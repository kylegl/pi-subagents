// Package-owned fork of Herdr's official Pi lifecycle integration.
// Upstream provenance: herdrdev/herdr HERDR_INTEGRATION_ID=pi, version 8
// https://github.com/herdrdev/herdr/blob/master/src/integration/assets/pi/herdr-agent-state.ts
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { getAgentDir } from "../shared/utils.ts";

export const HERDR_BACKGROUND_SNAPSHOT_EVENT = "pi-subagents:herdr-background-snapshot";
export const HERDR_BACKGROUND_REFRESH_EVENT = "pi-subagents:herdr-background-refresh";
const SOURCE = "herdr:pi";

export type HerdrWorkState = "working" | "blocked";
export interface HerdrBackgroundSnapshot {
	provider: string;
	sessionId: string;
	items: Array<{ id: string; state: HerdrWorkState; message?: string }>;
}
export interface HerdrLifecycleEvents {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}
export interface HerdrSessionContext {
	mode?: string;
	isIdle?: () => boolean;
	sessionManager?: { getSessionFile?: () => string | null | undefined; getSessionId?: () => string | null | undefined };
}
export type HerdrAuthorityStatus = "disabled" | "outside-herdr" | "conflict" | "active";

interface AuthorityOptions {
	enabled: boolean;
	events: HerdrLifecycleEvents;
	env?: NodeJS.ProcessEnv;
	officialIntegrationPath?: string;
	sendRequest?: (request: unknown) => Promise<boolean>;
}

function socketSender(env: NodeJS.ProcessEnv): (request: unknown) => Promise<boolean> {
	const rawPath = env.HERDR_SOCKET_PATH;
	const endpoint = process.platform === "win32" && rawPath ? `\\\\.\\pipe\\${rawPath}` : rawPath;
	const attempt = (request: unknown, timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
		if (!endpoint) return resolve(false);
		let finished = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const socket = net.createConnection(endpoint);
		const finish = (ok: boolean) => {
			if (finished) return;
			finished = true;
			if (timer) clearTimeout(timer);
			socket.destroy();
			resolve(ok);
		};
		socket.on("error", () => finish(false));
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", () => finish(true));
		socket.on("end", () => finish(false));
		timer = setTimeout(() => finish(false), timeoutMs);
		timer.unref?.();
	});
	return async (request) => (await attempt(request, 500)) || attempt(request, 1500);
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSnapshot(value: unknown): HerdrBackgroundSnapshot | undefined {
	if (!record(value) || typeof value.provider !== "string" || !value.provider || typeof value.sessionId !== "string") return;
	if (!Array.isArray(value.items)) return;
	const items: HerdrBackgroundSnapshot["items"] = [];
	for (const raw of value.items) {
		if (!record(raw) || typeof raw.id !== "string" || !raw.id || (raw.state !== "working" && raw.state !== "blocked")) return;
		items.push({ id: raw.id, state: raw.state, ...(typeof raw.message === "string" ? { message: raw.message.slice(0, 160) } : {}) });
	}
	return { provider: value.provider, sessionId: value.sessionId, items };
}

export function managedHerdrIntegrationPath(): string {
	return path.join(getAgentDir(), "extensions", "herdr-agent-state.ts");
}

export function registerHerdrLifecycleAuthority(options: AuthorityOptions) {
	const env = options.env ?? process.env;
	const paneId = env.HERDR_PANE_ID;
	const inHerdr = env.HERDR_ENV === "1" && !!paneId && !!env.HERDR_SOCKET_PATH;
	const officialPath = options.officialIntegrationPath ?? managedHerdrIntegrationPath();
	const conflict = options.enabled && inHerdr && fs.existsSync(officialPath);
	let status: HerdrAuthorityStatus = !options.enabled ? "disabled" : !inHerdr ? "outside-herdr" : conflict ? "conflict" : "outside-herdr";
	const send = options.sendRequest ?? socketSender(env);
	const providers = new Map<string, Map<string, HerdrBackgroundSnapshot["items"][number]>>();
	const unsubscribes: Array<() => void> = [];
	let rootSession = false;
	let foregroundActive = false;
	let blockedCount = 0;
	let foregroundBlockedMessage: string | undefined;
	let sessionId: string | undefined;
	let sessionPath: string | undefined;
	let sessionScopeId: string | undefined;
	let lastState: string | undefined;
	let lastMessage: string | undefined;
	let seq = Date.now() * 1000;
	let queue = Promise.resolve();
	let disposed = false;
	const nextSeq = () => ++seq;
	const enqueue = (request: unknown, delivered?: (ok: boolean) => void) => {
		queue = queue.then(async () => {
			let ok = false;
			try { ok = await send(request); } catch {}
			delivered?.(ok);
		});
	};
	const sessionRef = () => sessionPath ? { agent_session_path: sessionPath } : sessionId ? { agent_session_id: sessionId } : {};
	const request = (method: string, params: Record<string, unknown>) => ({
		id: `${SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
		method,
		params: { pane_id: paneId, source: SOURCE, agent: "pi", seq: nextSeq(), ...params },
	});
	const desired = () => {
		if (blockedCount > 0) return { state: "blocked", message: foregroundBlockedMessage };
		for (const [provider, items] of providers) for (const item of items.values()) {
			if (item.state === "blocked") return { state: "blocked", message: item.message || `${provider} background work needs attention` };
		}
		if (foregroundActive) return { state: "working", message: undefined };
		for (const items of providers.values()) if ([...items.values()].some((item) => item.state === "working")) return { state: "working", message: undefined };
		return { state: "idle", message: undefined };
	};
	const publish = (force = false) => {
		if (!rootSession || disposed || status !== "active") return;
		const next = desired();
		if (!force && next.state === lastState && next.message === lastMessage) return;
		lastState = next.state;
		lastMessage = next.message;
		enqueue(request("pane.report_agent", { ...sessionRef(), state: next.state, ...(next.message ? { message: next.message } : {}) }), (ok) => {
			if (!ok && lastState === next.state && lastMessage === next.message) {
				lastState = undefined;
				lastMessage = undefined;
			}
		});
	};
	const updateSession = (ctx: HerdrSessionContext) => {
		let rawFile: string | undefined;
		try { const file = ctx.sessionManager?.getSessionFile?.(); rawFile = typeof file === "string" && file ? file : undefined; sessionPath = rawFile?.startsWith("/") ? rawFile : undefined; } catch { sessionPath = undefined; }
		try {
			const id = ctx.sessionManager?.getSessionId?.();
			sessionId = typeof id === "string" && id ? id : undefined;
			sessionScopeId = rawFile ?? sessionId;
		} catch { sessionId = undefined; sessionScopeId = rawFile; }
	};
	const subscribe = (event: string, handler: (data: unknown) => void) => {
		const unsub = options.events.on(event, handler);
		if (typeof unsub === "function") unsubscribes.push(unsub);
	};
	if (options.enabled && inHerdr && !conflict) {
		subscribe(HERDR_BACKGROUND_SNAPSHOT_EVENT, (data) => {
			if (!rootSession) return;
			const snapshot = parseSnapshot(data);
			if (!snapshot || snapshot.sessionId !== sessionScopeId) return;
			providers.set(snapshot.provider, new Map(snapshot.items.map((item) => [item.id, item])));
			publish();
		});
		subscribe("herdr:blocked", (data) => {
			if (!rootSession || !record(data)) return;
			if (data.active) { blockedCount += 1; foregroundBlockedMessage = typeof data.label === "string" ? data.label : undefined; }
			else { blockedCount = Math.max(0, blockedCount - 1); if (!blockedCount) foregroundBlockedMessage = undefined; }
			publish();
		});
	}
	return {
		get status(): HerdrAuthorityStatus { return status; },
		get conflictPath(): string | undefined { return conflict ? officialPath : undefined; },
		async sessionStarted(event: { reason?: string }, ctx: HerdrSessionContext): Promise<void> {
			if (!options.enabled || !inHerdr || conflict || disposed || ctx.mode !== "tui") return;
			status = "active"; rootSession = true; providers.clear(); updateSession(ctx);
			lastState = undefined; lastMessage = undefined;
			enqueue(request("pane.report_agent_session", { ...sessionRef(), ...(event.reason ? { session_start_source: event.reason } : {}) }));
			foregroundActive = ctx.isIdle?.() === false;
			options.events.emit(HERDR_BACKGROUND_REFRESH_EVENT, { sessionId: sessionScopeId });
			publish();
			await queue;
		},
		agentStarted(ctx: HerdrSessionContext) { if (!rootSession) return; updateSession(ctx); enqueue(request("pane.report_agent_session", sessionRef())); foregroundActive = true; publish(); },
		agentSettled(ctx: HerdrSessionContext) { if (!rootSession || ctx.isIdle?.() !== true) return; foregroundActive = false; publish(); },
		async flush() { await queue; },
		dispose() { disposed = true; for (const unsub of unsubscribes) unsub(); },
	};
}
