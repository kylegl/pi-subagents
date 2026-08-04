import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { registerHerdrBackgroundAdapter, type HerdrBackgroundRun } from "../../src/integrations/herdr-background-adapter.ts";
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
		let runs: HerdrBackgroundRun[] = [
			{ id: "stable-a", status: "queued", sessionId: "session-a", needsAttention: false },
			{ id: "stable-a", status: "running", sessionId: "session-a", needsAttention: false },
			{ id: "stable-b", status: "running", sessionId: "session-a", needsAttention: true },
			{ id: "done", status: "complete", sessionId: "session-a" },
			{ id: "failed", status: "failed", sessionId: "session-a" },
			{ id: "stopped", status: "stopped", sessionId: "session-a" },
			{ id: "paused", status: "paused", sessionId: "session-a" },
			{ id: "other-session", status: "running", sessionId: "session-b" },
			{ id: "nested", status: "running", sessionId: "session-a", parentWorkflowRunId: "stable-a" },
		];
		const snapshots: any[] = [];
		events.on(HERDR_BACKGROUND_SNAPSHOT_EVENT, (snapshot) => snapshots.push(snapshot));
		const adapter = registerHerdrBackgroundAdapter({ enabled: true, events, getRuns: () => runs });
		adapter.sessionStarted("session-a");
		events.emit(HERDR_BACKGROUND_REFRESH_EVENT, { sessionId: "session-a" });
		assert.equal(snapshots[0].provider, "pi-subagents");
		assert.equal(snapshots[0].sessionId, "session-a");
		assert.deepEqual(snapshots[0].items.map((item: any) => [item.id, item.state]), [["stable-a", "working"], ["stable-b", "blocked"]]);

		runs = runs.map((run) => run.id === "stable-a" ? { ...run, status: "complete" } : run);
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "stable-a" });
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		assert.deepEqual(snapshots.at(-1).items.map((item: any) => item.id), ["stable-b"]);

		runs = runs.map((run) => run.id === "paused" ? { ...run, status: "queued" } : run);
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "paused" });
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "paused" });
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		assert.deepEqual(snapshots.at(-1).items.map((item: any) => item.id), ["stable-b", "paused"]);
		adapter.dispose();
	});

	it("converges from the authoritative projection when lifecycle events are missed", () => {
		const events = new Events();
		let runs: HerdrBackgroundRun[] = [{ id: "revived", status: "paused", sessionId: "session-a" }];
		const snapshots: any[] = [];
		let refresh: (() => void) | undefined;
		let cleared = 0;
		events.on(HERDR_BACKGROUND_SNAPSHOT_EVENT, (snapshot) => snapshots.push(snapshot));
		const adapter = registerHerdrBackgroundAdapter({
			enabled: true,
			events,
			getRuns: () => runs,
			refreshMs: 10,
			timers: {
				setInterval(handler) { refresh = handler as () => void; return { unref() {} } as NodeJS.Timeout; },
				clearInterval() { cleared += 1; },
			},
		});

		adapter.sessionStarted("session-a");
		assert.deepEqual(snapshots.at(-1).items, [], "paused work is not active");
		runs = [{ id: "revived", status: "running", sessionId: "session-a" }];
		refresh?.();
		assert.deepEqual(snapshots.at(-1).items, [{ id: "revived", state: "working" }]);

		adapter.sessionStarted("session-b");
		runs = [
			{ id: "revived", status: "running", sessionId: "session-a" },
			{ id: "replacement", status: "queued", sessionId: "session-b" },
		];
		refresh?.();
		assert.deepEqual(snapshots.at(-1).items, [{ id: "replacement", state: "working" }]);

		adapter.dispose();
		const countAtDispose = snapshots.length;
		refresh?.();
		adapter.sessionStarted("session-a");
		assert.equal(snapshots.length, countAtDispose, "a replaced adapter cannot republish stale state");
		assert.equal(cleared, 1);
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
