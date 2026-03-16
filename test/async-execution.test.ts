/**
 * Integration tests for async (background) agent execution.
 *
 * Tests the async support utilities: jiti availability check,
 * status file reading/caching.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTempDir, removeTempDir, tryImport } from "./helpers.ts";

// Top-level await
const asyncMod = await tryImport<any>("./async-execution.ts");
const utils = await tryImport<any>("./utils.ts");
const available = !!(asyncMod && utils);

const isAsyncAvailable = asyncMod?.isAsyncAvailable;
const executeAsyncChain = asyncMod?.executeAsyncChain;
const readStatus = utils?.readStatus;

describe("async execution utilities", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("reports jiti availability as boolean", () => {
		const result = isAsyncAvailable();
		assert.equal(typeof result, "boolean");
	});

	it("executeAsyncChain routes taskId artifacts consistently", () => {
		if (!isAsyncAvailable()) return;
		const tempDir = createTempDir();
		const id = `async-route-${Date.now().toString(36)}`;
		const taskId = "ticket-42";
		let startedPid: number | undefined;
		try {
			executeAsyncChain(id, {
				chain: [{ agent: "worker", task: "Use {chain_dir}", output: "out.md" }],
				agents: [{ name: "worker" }],
				ctx: {
					cwd: tempDir,
					currentSessionId: "session-test",
					pi: {
						events: {
							emit: (_event: string, payload: any) => {
								startedPid = payload?.pid;
							},
						},
					},
				} as any,
				cwd: tempDir,
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 1 },
				shareEnabled: false,
				taskId,
			});

			const cfgPath = path.join(os.tmpdir(), `pi-async-cfg-${id}.json`);
			assert.ok(fs.existsSync(cfgPath), "runner config file should exist");
			const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
			const expectedChainDir = path.join(tempDir, ".agents", "tasks", taskId);
			assert.ok(cfg.steps[0].task.includes(expectedChainDir), "task should use resolved chain_dir");
			assert.equal(cfg.steps[0].outputPath, path.join(expectedChainDir, "out.md"));
		} finally {
			if (startedPid) {
				try { process.kill(startedPid); } catch {}
			}
			try { fs.rmSync(path.join(os.tmpdir(), `pi-async-cfg-${id}.json`), { force: true }); } catch {}
			removeTempDir(path.join(os.tmpdir(), "pi-async-subagent-runs", id));
			removeTempDir(tempDir);
		}
	});

	it("executeAsyncChain prefers chainDir over taskId", () => {
		if (!isAsyncAvailable()) return;
		const tempDir = createTempDir();
		const id = `async-precedence-${Date.now().toString(36)}`;
		const customBase = path.join(tempDir, "custom-chain");
		let startedPid: number | undefined;
		try {
			executeAsyncChain(id, {
				chain: [{ agent: "worker", task: "Use {chain_dir}" }],
				agents: [{ name: "worker" }],
				ctx: {
					cwd: tempDir,
					currentSessionId: "session-test",
					pi: { events: { emit: (_event: string, payload: any) => { startedPid = payload?.pid; } } },
				} as any,
				cwd: tempDir,
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 1 },
				shareEnabled: false,
				chainDir: customBase,
				taskId: "ignored-task-id",
			});

			const cfgPath = path.join(os.tmpdir(), `pi-async-cfg-${id}.json`);
			assert.ok(fs.existsSync(cfgPath), "runner config file should exist");
			const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
			assert.ok(cfg.steps[0].task.includes(path.join(customBase, id)), "task should use chainDir-derived path");
		} finally {
			if (startedPid) {
				try { process.kill(startedPid); } catch {}
			}
			try { fs.rmSync(path.join(os.tmpdir(), `pi-async-cfg-${id}.json`), { force: true }); } catch {}
			removeTempDir(path.join(os.tmpdir(), "pi-async-subagent-runs", id));
			removeTempDir(tempDir);
		}
	});

	it("readStatus returns null for missing directory", () => {
		const status = readStatus("/nonexistent/path/abc123");
		assert.equal(status, null);
	});

	it("readStatus parses valid status file", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "test-123",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [{ agent: "test", status: "running" }],
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const status = readStatus(dir);
			assert.ok(status, "should parse status");
			assert.equal(status.runId, "test-123");
			assert.equal(status.state, "running");
			assert.equal(status.mode, "single");
		} finally {
			removeTempDir(dir);
		}
	});

	it("readStatus caches by mtime (second call uses cache)", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "cache-test",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const s1 = readStatus(dir);
			const s2 = readStatus(dir);
			assert.ok(s1);
			assert.ok(s2);
			assert.equal(s1.runId, s2.runId);
		} finally {
			removeTempDir(dir);
		}
	});
});
