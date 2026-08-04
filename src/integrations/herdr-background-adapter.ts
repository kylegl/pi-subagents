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

export interface HerdrBackgroundTimerHandle {
	unref?(): void;
}

export interface HerdrBackgroundTimers<TimerHandle extends HerdrBackgroundTimerHandle = ReturnType<typeof setInterval>> {
	setInterval(callback: () => void, delayMs: number): TimerHandle;
	clearInterval(handle: TimerHandle): void;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Projects complete, current-session async state into the generic authority seam. */
export function registerHerdrBackgroundAdapter<TimerHandle extends HerdrBackgroundTimerHandle = ReturnType<typeof setInterval>>(options: {
	enabled: boolean;
	events: HerdrLifecycleEvents;
	getRuns: () => Iterable<HerdrBackgroundRun>;
	refreshMs?: number;
	timers?: HerdrBackgroundTimers<TimerHandle>;
}) {
	const refreshMs = options.refreshMs ?? 1_000;
	let sessionId: string | undefined;
	let clearRefreshTimer: (() => void) | undefined;
	let disposed = false;
	let active = false;
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
		if (!active || disposed || !sessionId) return;
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
	const activate = () => {
		if (active || disposed || !options.enabled) return;
		active = true;
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
	};
	return {
		sessionStarted(nextSessionId: string) {
			if (disposed || !options.enabled) return;
			activate();
			sessionId = nextSessionId;
			publish();
			if (refreshMs > 0 && !clearRefreshTimer) {
				const injectedTimers = options.timers;
				if (injectedTimers) {
					const handle = injectedTimers.setInterval(publish, refreshMs);
					handle.unref?.();
					clearRefreshTimer = () => injectedTimers.clearInterval(handle);
				} else {
					const handle = globalThis.setInterval(publish, refreshMs);
					handle.unref?.();
					clearRefreshTimer = () => globalThis.clearInterval(handle);
				}
			}
		},
		agentStarted() {
			if (disposed) return;
			// Let the authority mark the foreground turn active before completed
			// background work is removed from the aggregate lifecycle state.
			queueMicrotask(publish);
		},
		publish,
		dispose() {
			if (disposed) return;
			disposed = true;
			active = false;
			clearRefreshTimer?.();
			clearRefreshTimer = undefined;
			sessionId = undefined;
			for (const unsub of unsubscribes) unsub();
		},
	};
}
