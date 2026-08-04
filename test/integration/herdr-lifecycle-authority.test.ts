import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { registerHerdrBackgroundAdapter, type HerdrBackgroundRun } from "../../src/integrations/herdr-background-adapter.ts";
import {
	HERDR_BACKGROUND_SNAPSHOT_EVENT,
	registerHerdrLifecycleAuthority,
} from "../../src/integrations/herdr-lifecycle-authority.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT } from "../../src/shared/types.ts";
import { listAsyncRuns } from "../../src/runs/background/async-status.ts";

class Events {
	private readonly emitter = new EventEmitter();
	on(event: string, handler: (data: unknown) => void) { this.emitter.on(event, handler); return () => this.emitter.off(event, handler); }
	emit(event: string, data: unknown) { this.emitter.emit(event, data); }
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function recordingSocket() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-authority-"));
	const socketPath = path.join(dir, "herdr.sock");
	const requests: any[] = [];
	const server = net.createServer((socket) => {
		let input = "";
		socket.on("data", (chunk) => {
			input += chunk.toString();
			const newline = input.indexOf("\n");
			if (newline < 0) return;
			requests.push(JSON.parse(input.slice(0, newline)));
			socket.end("{\"ok\":true}\n");
		});
	});
	await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
	cleanups.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); });
	return { socketPath, requests };
}

function context(id = "session-1", idle = true) {
	return { mode: "tui", isIdle: () => idle, sessionManager: { getSessionFile: () => null, getSessionId: () => id } };
}

describe("Herdr lifecycle authority socket integration", () => {
	it("reports official lifecycle shapes and aggregates provider snapshots by precedence", async () => {
		const socket = await recordingSocket();
		const events = new Events();
		const authority = registerHerdrLifecycleAuthority({
			enabled: true,
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: socket.socketPath },
			officialIntegrationPath: path.join(path.dirname(socket.socketPath), "absent.ts"),
		});
		await authority.sessionStarted({ reason: "startup" }, context());
		events.emit(HERDR_BACKGROUND_SNAPSHOT_EVENT, { provider: "one", sessionId: "session-1", items: [{ id: "run-a", state: "working" }] });
		authority.agentStarted(context("session-1", false));
		events.emit(HERDR_BACKGROUND_SNAPSHOT_EVENT, { provider: "two", sessionId: "session-1", items: [{ id: "run-b", state: "blocked", message: "reviewer needs attention" }] });
		events.emit("herdr:blocked", { active: true, label: "foreground question" });
		events.emit("herdr:blocked", { active: false });
		events.emit(HERDR_BACKGROUND_SNAPSHOT_EVENT, { provider: "two", sessionId: "session-1", items: [] });
		authority.agentSettled(context());
		events.emit(HERDR_BACKGROUND_SNAPSHOT_EVENT, { provider: "one", sessionId: "session-1", items: [] });
		await authority.flush();

		assert.equal(socket.requests[0].method, "pane.report_agent_session");
		assert.deepEqual(socket.requests.filter((request) => request.method === "pane.report_agent").map((request) => [request.params.state, request.params.message]), [
			["idle", undefined], ["working", undefined], ["blocked", "reviewer needs attention"],
			["blocked", "foreground question"], ["blocked", "reviewer needs attention"], ["working", undefined], ["idle", undefined],
		]);
		assert.ok(socket.requests.every((request) => request.params.agent_session_id === "session-1"));
		const sequences = socket.requests.map((request) => request.params.seq);
		assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
		authority.dispose();
	});

	it("reports background attention transitions with foreground-message precedence", async () => {
		const socket = await recordingSocket();
		const events = new Events();
		let runs: HerdrBackgroundRun[] = [];
		const authority = registerHerdrLifecycleAuthority({
			enabled: true,
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: socket.socketPath },
			officialIntegrationPath: path.join(path.dirname(socket.socketPath), "absent.ts"),
		});
		const adapter = registerHerdrBackgroundAdapter({ enabled: true, events, getRuns: () => runs });
		adapter.sessionStarted("session-1");
		await authority.sessionStarted({ reason: "startup" }, context());

		runs = [{ id: "working", status: "running", sessionId: "session-1" }];
		adapter.publish();
		runs[0] = { ...runs[0], needsAttention: false }; // active_long_running is still ordinary work
		adapter.publish();
		runs[0] = { ...runs[0], needsAttention: true };
		adapter.publish();
		runs[0] = { ...runs[0], needsAttention: false };
		adapter.publish();
		runs = [
			{ id: "z-blocked", status: "running", sessionId: "session-1", needsAttention: true },
			{ id: "a-blocked", status: "queued", sessionId: "session-1", needsAttention: true },
		];
		adapter.publish();
		events.emit("herdr:blocked", { active: true, label: "Approve foreground action?" });
		runs[1] = { ...runs[1], needsAttention: false };
		adapter.publish();
		events.emit("herdr:blocked", { active: false });
		runs = runs.map((run) => ({ ...run, status: "complete" }));
		adapter.publish();
		await authority.flush();

		assert.deepEqual(socket.requests.filter((request) => request.method === "pane.report_agent").map((request) => [request.params.state, request.params.message]), [
			["idle", undefined],
			["working", undefined],
			["blocked", "pi-subagents background work needs attention"],
			["working", undefined],
			["blocked", "2 pi-subagents background runs need attention"],
			["blocked", "Approve foreground action?"],
			["blocked", "pi-subagents background work needs attention"],
			["idle", undefined],
		]);
		assert.doesNotMatch(JSON.stringify(socket.requests), /z-blocked|a-blocked/);
		adapter.dispose();
		authority.dispose();
	});

	it("keeps a settled parent working across concurrent async-root transitions", async () => {
		const socket = await recordingSocket();
		const events = new Events();
		let runs: HerdrBackgroundRun[] = [];
		const authority = registerHerdrLifecycleAuthority({
			enabled: true,
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: socket.socketPath },
			officialIntegrationPath: path.join(path.dirname(socket.socketPath), "absent.ts"),
		});
		const adapter = registerHerdrBackgroundAdapter({ enabled: true, events, getRuns: () => runs });
		adapter.sessionStarted("session-1");
		await authority.sessionStarted({ reason: "startup" }, context("session-1", false));

		runs = [{ id: "root-a", status: "running", sessionId: "session-1" }];
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "root-a" });
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "root-a" });
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		authority.agentSettled(context());
		runs.push({ id: "root-b", status: "queued", sessionId: "session-1" });
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "root-b" });
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		runs = runs.map((run) => run.id === "root-a" ? { ...run, status: "complete" } : run);
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "root-a" });
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "root-a" });
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		runs = runs.map((run) => run.id === "root-b" ? { ...run, status: "failed" } : run);
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "root-b" });
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		await authority.flush();

		assert.deepEqual(socket.requests.filter((request) => request.method === "pane.report_agent").map((request) => request.params.state), ["working", "idle"]);
		adapter.dispose();
		authority.dispose();
	});

	it("rebuilds authoritative roots across reload, session replacement, stale events, and revival", async () => {
		const events = new Events();
		const reports: any[] = [];
		let runs: HerdrBackgroundRun[] = [
			{ id: "restored-root", status: "running", sessionId: "session-1" },
			{ id: "nested", status: "running", sessionId: "session-1", parentWorkflowRunId: "restored-root" },
			{ id: "foreign", status: "running", sessionId: "session-other" },
		];
		const authority = registerHerdrLifecycleAuthority({
			enabled: true,
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "injected" },
			officialIntegrationPath: path.join(os.tmpdir(), `absent-${Date.now()}.ts`),
			sendRequest: async (request) => { reports.push(request); return true; },
		});
		const adapter = registerHerdrBackgroundAdapter({ enabled: true, events, getRuns: () => runs, refreshMs: 0 });

		adapter.sessionStarted("session-1");
		await authority.sessionStarted({ reason: "startup" }, context("session-1"));
		await authority.flush();
		assert.equal(reports.at(-1).params.state, "working", "startup restores the live root");

		await authority.sessionStarted({ reason: "reload" }, context("session-1"));
		await authority.flush();
		assert.equal(reports.at(-1).params.state, "working", "reload requests a fresh snapshot");

		events.emit("herdr:blocked", { active: true, label: "stale foreground question" });
		runs = [
			{ id: "stale-old-session", status: "running", sessionId: "session-1" },
			{ id: "revived", status: "paused", sessionId: "session-2" },
		];
		adapter.sessionStarted("session-2");
		await authority.sessionStarted({ reason: "resume" }, context("session-2"));
		await authority.flush();
		assert.equal(reports.at(-1).params.state, "idle", "replacement clears old-session and paused work");

		runs = [{ id: "revived", status: "running", sessionId: "session-2" }];
		adapter.publish();
		await authority.flush();
		assert.equal(reports.at(-1).params.state, "working", "artifact reconciliation revives work without a start event");

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "revived" });
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		await authority.flush();
		assert.equal(reports.at(-1).params.state, "working", "an out-of-order completion cannot override the authoritative run");

		runs = [{ id: "revived", status: "complete", sessionId: "session-2" }];
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "revived" });
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		await authority.flush();
		assert.equal(reports.at(-1).params.state, "idle", "an out-of-order start converges to the authoritative completion");
		adapter.dispose();
		authority.dispose();
	});

	it("restores a revived root from lifecycle artifacts without receiving its start event", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-revival-artifacts-"));
		cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
		const writeStatus = (id: string, sessionId: string, state: "paused" | "running", pid = process.pid) => {
			const runDir = path.join(root, id);
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: id,
				mode: "single",
				state,
				sessionId,
				pid,
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: state === "running" ? "running" : "pending" }],
			}));
		};
		writeStatus("revived", "session-2", "paused");
		writeStatus("foreign", "session-other", "running", 999_999_999);
		const events = new Events();
		const reports: any[] = [];
		const getRuns = () => listAsyncRuns(root, {
			states: ["queued", "running"],
			sessionId: "session-2",
			reconcile: false,
		}).flatMap((candidate) => listAsyncRuns(root, {
			runId: candidate.id,
			states: ["queued", "running"],
			sessionId: "session-2",
		})).map((run) => ({ id: run.id, status: run.state, sessionId: run.sessionId, parentWorkflowRunId: run.parentWorkflowRunId }));
		const authority = registerHerdrLifecycleAuthority({
			enabled: true,
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "injected" },
			officialIntegrationPath: path.join(root, "absent.ts"),
			sendRequest: async (request) => { reports.push(request); return true; },
		});
		const adapter = registerHerdrBackgroundAdapter({ enabled: true, events, getRuns, refreshMs: 0 });
		adapter.sessionStarted("session-2");
		await authority.sessionStarted({ reason: "resume" }, context("session-2"));
		await authority.flush();
		assert.equal(reports.at(-1).params.state, "idle");

		writeStatus("revived", "session-2", "running");
		adapter.publish();
		await authority.flush();
		assert.equal(reports.at(-1).params.state, "working");
		assert.deepEqual(getRuns().map((run) => run.id), ["revived"], "foreign shared-root artifacts stay excluded");
		const foreign = JSON.parse(fs.readFileSync(path.join(root, "foreign", "status.json"), "utf8"));
		assert.equal(foreign.state, "running", "foreign stale artifacts are not reconciled or mutated");
		adapter.dispose();
		authority.dispose();
	});

	it("retries an unchanged snapshot after delivery failure and scopes relative session paths consistently", async () => {
		const events = new Events();
		const requests: any[] = [];
		let failedWorking = false;
		const authority = registerHerdrLifecycleAuthority({
			enabled: true,
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "injected" },
			officialIntegrationPath: path.join(os.tmpdir(), `absent-${Date.now()}.ts`),
			sendRequest: async (request: any) => {
				requests.push(request);
				if (request.method === "pane.report_agent" && request.params.state === "working" && !failedWorking) {
					failedWorking = true;
					return false;
				}
				return true;
			},
		});
		const relativeContext = { mode: "tui", isIdle: () => true, sessionManager: { getSessionFile: () => "sessions/current.jsonl", getSessionId: () => "native-id" } };
		await authority.sessionStarted({ reason: "startup" }, relativeContext);
		const snapshot = { provider: "provider", sessionId: "sessions/current.jsonl", items: [{ id: "run", state: "working" }] };
		events.emit(HERDR_BACKGROUND_SNAPSHOT_EVENT, snapshot);
		await authority.flush();
		events.emit(HERDR_BACKGROUND_SNAPSHOT_EVENT, snapshot);
		await authority.flush();
		assert.equal(requests.filter((request) => request.method === "pane.report_agent" && request.params.state === "working").length, 2);
		assert.ok(requests.every((request) => request.params.agent_session_id === "native-id"));
	});

	it("is inert unless explicitly enabled in a Herdr TUI and rejects a managed integration conflict", async () => {
		const socket = await recordingSocket();
		const events = new Events();
		const disabled = registerHerdrLifecycleAuthority({ enabled: false, events, env: { HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: socket.socketPath } });
		await disabled.sessionStarted({ reason: "startup" }, context());
		assert.equal(disabled.status, "disabled");
		const official = path.join(path.dirname(socket.socketPath), "herdr-agent-state.ts");
		fs.writeFileSync(official, "// HERDR_INTEGRATION_ID=pi\n");
		const conflicting = registerHerdrLifecycleAuthority({ enabled: true, events, env: { HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: socket.socketPath }, officialIntegrationPath: official });
		await conflicting.sessionStarted({ reason: "startup" }, context());
		assert.equal(conflicting.status, "conflict");
		assert.equal(conflicting.conflictPath, official);
		const headless = registerHerdrLifecycleAuthority({ enabled: true, events, env: { HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: socket.socketPath }, officialIntegrationPath: `${official}.absent` });
		await headless.sessionStarted({ reason: "startup" }, { ...context(), mode: "rpc" });
		assert.equal(headless.status, "outside-herdr");
		assert.deepEqual(socket.requests, []);
	});
});
