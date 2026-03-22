import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	finalizeSingleOutput,
	injectSingleOutputInstruction,
	injectSingleReadInstruction,
	resolveSingleOutputPath,
	resolveSingleProgressPath,
	resolveSingleReadPaths,
} from "./single-output.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("resolveSingleReadPaths", () => {
	it("resolves read paths against requested cwd", () => {
		const resolved = resolveSingleReadPaths(["context.md", "spec.md"], "/runtime", "/requested");
		assert.deepEqual(resolved, [
			path.resolve("/requested", "context.md"),
			path.resolve("/requested", "spec.md"),
		]);
	});
});

describe("resolveSingleOutputPath", () => {
	it("keeps absolute paths unchanged", () => {
		const absolutePath = path.join(os.tmpdir(), "pi-subagents-abs", "report.md");
		const resolved = resolveSingleOutputPath(absolutePath, "/repo", "/override");
		assert.equal(resolved, absolutePath);
	});

	it("resolves relative paths against requested cwd", () => {
		const resolved = resolveSingleOutputPath("reviews/report.md", "/runtime", "/requested");
		assert.equal(resolved, path.resolve("/requested", "reviews/report.md"));
	});

	it("resolves relative paths against runtime cwd when requested cwd is absent", () => {
		const resolved = resolveSingleOutputPath("reviews/report.md", "/runtime");
		assert.equal(resolved, path.resolve("/runtime", "reviews/report.md"));
	});

	it("resolves relative requested cwd from runtime cwd before resolving output", () => {
		const resolved = resolveSingleOutputPath("reviews/report.md", "/runtime", "nested/work");
		assert.equal(resolved, path.resolve("/runtime", "nested/work", "reviews/report.md"));
	});
});

describe("resolveSingleProgressPath", () => {
	it("uses progress.md beside the resolved task cwd", () => {
		const outputPath = resolveSingleOutputPath("plan.md", "/runtime", "/requested");
		const progressPath = resolveSingleProgressPath(outputPath, "/runtime", "/requested");
		assert.equal(progressPath, path.resolve("/requested", "progress.md"));
	});
});

describe("injectSingleReadInstruction", () => {
	it("prepends read instruction with resolved paths", () => {
		const output = injectSingleReadInstruction("Analyze this", ["/tmp/context.md", "/tmp/spec.md"]);
		assert.match(output, /^\[Read from: \/tmp\/context.md, \/tmp\/spec.md\]/);
	});
});

describe("injectSingleOutputInstruction", () => {
	it("appends output instruction with resolved path", () => {
		const output = injectSingleOutputInstruction("Analyze this", "/tmp/report.md");
		assert.match(output, /Write your findings to: \/tmp\/report.md/);
	});
});

describe("finalizeSingleOutput", () => {
	it("persists full output while displaying truncated output", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-test-"));
		tempDirs.push(dir);
		const outputPath = path.join(dir, "progress.md");
		const fullOutput = "line 1\nline 2\nline 3";
		const truncatedOutput = "[TRUNCATED]\nline 1";

		const result = finalizeSingleOutput({
			fullOutput,
			truncatedOutput,
			outputPath,
			exitCode: 0,
		});

		assert.match(result.displayOutput, /^\[TRUNCATED\]\nline 1/);
		assert.match(result.displayOutput, /📄 Output saved to:/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), fullOutput);
	});

	it("appends to existing progress output instead of overwriting", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-test-"));
		tempDirs.push(dir);
		const outputPath = path.join(dir, "progress.md");
		fs.writeFileSync(outputPath, "existing", "utf-8");

		finalizeSingleOutput({
			fullOutput: "new output",
			outputPath,
			exitCode: 0,
		});

		assert.equal(fs.readFileSync(outputPath, "utf-8"), "existing\n\n---\n\nnew output");
	});

	it("does not write output file on failed runs", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-test-"));
		tempDirs.push(dir);
		const outputPath = path.join(dir, "progress.md");

		const result = finalizeSingleOutput({
			fullOutput: "full output",
			truncatedOutput: "truncated output",
			outputPath,
			exitCode: 1,
		});

		assert.equal(result.displayOutput, "truncated output");
		assert.equal(fs.existsSync(outputPath), false);
	});
});
