import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempDir, removeTempDir } from "./helpers.ts";
import { resolveChainArtifactDir } from "../chain-artifacts.ts";

describe("resolveChainArtifactDir", () => {
	it("uses chainDir precedence (run subdir)", () => {
		const tempDir = createTempDir();
		try {
			const chainDir = path.join(tempDir, "chain-base");
			const resolved = resolveChainArtifactDir({
				runId: "run-1",
				baseCwd: tempDir,
				originalTask: "review code",
				chainDir,
				taskId: "ignored",
			});
			assert.equal(resolved, path.join(path.resolve(chainDir), "run-1"));
			assert.ok(fs.existsSync(resolved));
		} finally {
			removeTempDir(tempDir);
		}
	});

	it("routes taskId directly by default", () => {
		const tempDir = createTempDir();
		try {
			const resolved = resolveChainArtifactDir({
				runId: "run-2",
				baseCwd: tempDir,
				originalTask: "review code",
				taskId: "ticket-123",
			});
			assert.equal(resolved, path.join(tempDir, ".agents", "tasks", "ticket-123"));
			assert.ok(fs.existsSync(resolved));
		} finally {
			removeTempDir(tempDir);
		}
	});

	it("supports taskMode run for taskId routing", () => {
		const tempDir = createTempDir();
		try {
			const resolved = resolveChainArtifactDir({
				runId: "run-3",
				baseCwd: tempDir,
				originalTask: "review code",
				taskId: "ticket-123",
				taskMode: "run",
				taskRoot: path.join(tempDir, "root"),
			});
			assert.equal(resolved, path.join(tempDir, "root", "ticket-123", "run-3"));
			assert.ok(fs.existsSync(resolved));
		} finally {
			removeTempDir(tempDir);
		}
	});
});
