import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { registerHerdrBackgroundAdapter } from "../../src/integrations/herdr-background-adapter.ts";
import { HERDR_BACKGROUND_REFRESH_EVENT, HERDR_BACKGROUND_SNAPSHOT_EVENT } from "../../src/integrations/herdr-lifecycle-authority.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";

class Events {
	private emitter = new EventEmitter();
	on(event: string, handler: (data: unknown) => void) { this.emitter.on(event, handler); return () => this.emitter.off(event, handler); }
	emit(event: string, data: unknown) { this.emitter.emit(event, data); }
}

describe("Herdr background adapter", () => {
	it("publishes complete current-session snapshots on bind, refresh, and reconciliation", async () => {
		const events = new Events();
		let runs = [{ id: "stable-a", needsAttention: false }, { id: "stable-b", needsAttention: true }];
		const snapshots: any[] = [];
		events.on(HERDR_BACKGROUND_SNAPSHOT_EVENT, (snapshot) => snapshots.push(snapshot));
		const adapter = registerHerdrBackgroundAdapter({ enabled: true, events, getRuns: () => runs });
		adapter.sessionStarted("session-a");
		events.emit(HERDR_BACKGROUND_REFRESH_EVENT, { sessionId: "session-a" });
		runs = [];
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "stable-a" });
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		assert.equal(snapshots[0].provider, "pi-subagents");
		assert.equal(snapshots[0].sessionId, "session-a");
		assert.deepEqual(snapshots[0].items.map((item: any) => [item.id, item.state]), [["stable-a", "working"], ["stable-b", "blocked"]]);
		assert.deepEqual(snapshots.at(-1).items, []);
		adapter.dispose();
	});

	it("does nothing while disabled", () => {
		const events = new Events();
		const snapshots: unknown[] = [];
		events.on(HERDR_BACKGROUND_SNAPSHOT_EVENT, (snapshot) => snapshots.push(snapshot));
		const adapter = registerHerdrBackgroundAdapter({ enabled: false, events, getRuns: () => [{ id: "run" }] });
		adapter.sessionStarted("session");
		assert.deepEqual(snapshots, []);
	});
});
