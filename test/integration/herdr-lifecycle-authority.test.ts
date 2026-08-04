import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	HERDR_BACKGROUND_SNAPSHOT_EVENT,
	registerHerdrLifecycleAuthority,
} from "../../src/integrations/herdr-lifecycle-authority.ts";

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
