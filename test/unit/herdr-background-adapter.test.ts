import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { registerHerdrBackgroundAdapter } from "../../src/integrations/herdr-background-adapter.ts";
import { HERDR_BACKGROUND_REFRESH_EVENT, HERDR_BACKGROUND_SNAPSHOT_EVENT } from "../../src/integrations/herdr-lifecycle-authority.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT } from "../../src/shared/types.ts";

class Events {
	private emitter = new EventEmitter();
	on(event: string, handler: (data: unknown) => void) { this.emitter.on(event, handler); return () => this.emitter.off(event, handler); }
	emit(event: string, data: unknown) { this.emitter.emit(event, data); }
}

describe("Herdr background adapter", () => {
	it("publishes only unique, working, current-session top-level roots", async () => {
		const events = new Events();
		let runs = [
			{ id: "stable-a", status: "queued" as const, sessionId: "session-a", needsAttention: false },
			{ id: "stable-a", status: "running" as const, sessionId: "session-a", needsAttention: false },
			{ id: "stable-b", status: "running" as const, sessionId: "session-a", needsAttention: true },
			{ id: "done", status: "complete" as const, sessionId: "session-a" },
			{ id: "failed", status: "failed" as const, sessionId: "session-a" },
			{ id: "stopped", status: "stopped" as const, sessionId: "session-a" },
			{ id: "paused", status: "paused" as const, sessionId: "session-a" },
			{ id: "other-session", status: "running" as const, sessionId: "session-b" },
			{ id: "nested", status: "running" as const, sessionId: "session-a", parentWorkflowRunId: "stable-a" },
		];
		const snapshots: any[] = [];
		events.on(HERDR_BACKGROUND_SNAPSHOT_EVENT, (snapshot) => snapshots.push(snapshot));
		const adapter = registerHerdrBackgroundAdapter({ enabled: true, events, getRuns: () => runs });
		adapter.sessionStarted("session-a");
		events.emit(HERDR_BACKGROUND_REFRESH_EVENT, { sessionId: "session-a" });
		assert.equal(snapshots[0].provider, "pi-subagents");
		assert.equal(snapshots[0].sessionId, "session-a");
		assert.deepEqual(snapshots[0].items.map((item: any) => [item.id, item.state]), [["stable-a", "working"], ["stable-b", "blocked"]]);

		runs = runs.map((run) => run.id === "stable-a" ? { ...run, status: "complete" as const } : run);
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "stable-a" });
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		assert.deepEqual(snapshots.at(-1).items.map((item: any) => item.id), ["stable-b"]);

		runs = runs.map((run) => run.id === "paused" ? { ...run, status: "queued" as const } : run);
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "paused" });
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "paused" });
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		assert.deepEqual(snapshots.at(-1).items.map((item: any) => item.id), ["stable-b", "paused"]);
		adapter.dispose();
	});

	it("does nothing while disabled", () => {
		const events = new Events();
		const snapshots: unknown[] = [];
		events.on(HERDR_BACKGROUND_SNAPSHOT_EVENT, (snapshot) => snapshots.push(snapshot));
		const adapter = registerHerdrBackgroundAdapter({ enabled: false, events, getRuns: () => [{ id: "run", status: "running", sessionId: "session" }] });
		adapter.sessionStarted("session");
		assert.deepEqual(snapshots, []);
	});
});
