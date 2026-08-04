import {
	HERDR_BACKGROUND_REFRESH_EVENT,
	HERDR_BACKGROUND_SNAPSHOT_EVENT,
	type HerdrBackgroundSnapshot,
	type HerdrLifecycleEvents,
} from "./herdr-lifecycle-authority.ts";
import {
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
}) {
	let sessionId: string | undefined;
	const acknowledgedAttention = new Set<string>();
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
		return [...roots.values()];
	};
	const publish = () => {
		if (!options.enabled || !sessionId) return;
		const runs = currentRoots();
		const activeIds = new Set(runs.map((run) => run.id));
		for (const id of acknowledgedAttention) if (!activeIds.has(id)) acknowledgedAttention.delete(id);
		for (const run of runs) if (!run.needsAttention) acknowledgedAttention.delete(run.id);
		const snapshot: HerdrBackgroundSnapshot = {
			provider: "pi-subagents",
			sessionId,
			items: runs.map((run) => {
				const blocked = run.needsAttention === true && !acknowledgedAttention.has(run.id);
				return {
					id: run.id,
					state: blocked ? "blocked" : "working",
					...(blocked ? { message: `pi-subagents run ${run.id.slice(0, 24)} needs attention` } : {}),
				};
			}),
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
		on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => {
			if (record(data)) {
				const id = typeof data.runId === "string" ? data.runId : typeof data.id === "string" ? data.id : undefined;
				if (id) acknowledgedAttention.delete(id);
			}
			publishAfterEventReconciliation();
		});
		on(SUBAGENT_CONTROL_EVENT, (data) => {
			if (record(data) && data.source === "async" && record(data.event) && data.event.type === "needs_attention" && typeof data.event.runId === "string") {
				acknowledgedAttention.delete(data.event.runId);
			}
			publishAfterEventReconciliation();
		});
	}
	return {
		sessionStarted(nextSessionId: string) { sessionId = nextSessionId; acknowledgedAttention.clear(); publish(); },
		agentStarted() { for (const run of currentRoots()) if (run.needsAttention) acknowledgedAttention.add(run.id); publish(); },
		publish,
		dispose() { acknowledgedAttention.clear(); for (const unsub of unsubscribes) unsub(); },
	};
}
