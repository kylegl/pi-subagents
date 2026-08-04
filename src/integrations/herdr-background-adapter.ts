import {
	HERDR_BACKGROUND_REFRESH_EVENT,
	HERDR_BACKGROUND_SNAPSHOT_EVENT,
	type HerdrBackgroundSnapshot,
	type HerdrLifecycleEvents,
} from "./herdr-lifecycle-authority.ts";
import {
	SUBAGENT_ASYNC_ACTIVITY_CHANGED_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CONTROL_EVENT,
} from "../shared/types.ts";

export interface HerdrBackgroundRun {
	id: string;
	status: "queued" | "running" | "complete" | "failed" | "paused" | "stopped" | "rejected";
	sessionId?: string;
	parentWorkflowRunId?: string;
	needsAttention?: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Projects complete, current-session async state into the generic authority seam. */
export function registerHerdrBackgroundAdapter(options: {
	enabled: boolean;
	events: HerdrLifecycleEvents;
	getRuns: () => Iterable<HerdrBackgroundRun>;
	refreshMs?: number;
	timers?: {
		setInterval: typeof setInterval;
		clearInterval: typeof clearInterval;
	};
}) {
	const refreshMs = options.refreshMs ?? 1_000;
	const timers = options.timers ?? globalThis;
	let sessionId: string | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let disposed = false;
	const unsubscribes: Array<() => void> = [];
	const currentRoots = () => {
		if (!sessionId) return [];
		const roots = new Map<string, HerdrBackgroundRun>();
		for (const run of options.getRuns()) {
			if (run.sessionId !== sessionId || run.parentWorkflowRunId) continue;
			if (run.status !== "queued" && run.status !== "running") continue;
			const existing = roots.get(run.id);
			if (!existing || run.needsAttention === true) roots.set(run.id, run);
		}
		return [...roots.values()].sort((a, b) => a.id.localeCompare(b.id));
	};
	const publish = () => {
		if (!options.enabled || disposed || !sessionId) return;
		const runs = currentRoots();
		const blockedCount = runs.filter((run) => run.needsAttention === true).length;
		const blockedMessage = blockedCount === 1
			? "pi-subagents background work needs attention"
			: `${blockedCount} pi-subagents background runs need attention`;
		const snapshot: HerdrBackgroundSnapshot = {
			provider: "pi-subagents",
			sessionId,
			items: runs.map((run) => ({
				id: run.id,
				state: run.needsAttention === true ? "blocked" : "working",
				...(run.needsAttention === true ? { message: blockedMessage } : {}),
			})),
		};
		options.events.emit(HERDR_BACKGROUND_SNAPSHOT_EVENT, snapshot);
	};
	const on = (event: string, handler: (data: unknown) => void) => {
		const unsub = options.events.on(event, handler);
		if (typeof unsub === "function") unsubscribes.push(unsub);
	};
	if (options.enabled) {
		on(HERDR_BACKGROUND_REFRESH_EVENT, (data) => {
			if (!record(data) || typeof data.sessionId !== "string" || data.sessionId !== sessionId) return;
			publish();
		});
		const publishAfterEventReconciliation = () => queueMicrotask(publish);
		on(SUBAGENT_ASYNC_STARTED_EVENT, publishAfterEventReconciliation);
		on(SUBAGENT_ASYNC_COMPLETE_EVENT, publishAfterEventReconciliation);
		on(SUBAGENT_ASYNC_ACTIVITY_CHANGED_EVENT, publishAfterEventReconciliation);
		on(SUBAGENT_CONTROL_EVENT, (data) => {
			if (record(data) && data.source === "async" && record(data.event) && data.event.type === "needs_attention") {
				publishAfterEventReconciliation();
			}
		});
	}
	return {
		sessionStarted(nextSessionId: string) {
			if (disposed) return;
			sessionId = nextSessionId;
			publish();
			if (options.enabled && refreshMs > 0 && !refreshTimer) {
				refreshTimer = timers.setInterval(publish, refreshMs);
				refreshTimer.unref?.();
			}
		},
		agentStarted() {
			if (disposed) return;
			publish();
		},
		publish,
		dispose() {
			if (disposed) return;
			disposed = true;
			if (refreshTimer) timers.clearInterval(refreshTimer);
			refreshTimer = undefined;
			sessionId = undefined;
			for (const unsub of unsubscribes) unsub();
		},
	};
}
