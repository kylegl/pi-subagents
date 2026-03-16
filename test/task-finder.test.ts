import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempDir, removeTempDir } from "./helpers.ts";
import { inferTaskScopedCwd, resolveSingleAgentTaskCwd } from "../task-finder.ts";

describe("inferTaskScopedCwd", () => {
	it("matches task id in backticks against .agents/tasks directory", () => {
		const tempDir = createTempDir();
		try {
			const taskId = "letta-memfs-architecture";
			const taskDir = path.join(tempDir, ".agents", "tasks", taskId);
			fs.mkdirSync(taskDir, { recursive: true });

			const resolved = inferTaskScopedCwd(
				"Create a detailed plan for the task `letta-memfs-architecture`.",
				tempDir,
			);
			assert.equal(resolved, taskDir);
		} finally {
			removeTempDir(tempDir);
		}
	});

	it("falls back to latest task directory for 'this task' phrasing", () => {
		const tempDir = createTempDir();
		try {
			const oldTask = path.join(tempDir, ".agents", "tasks", "old-task");
			const newTask = path.join(tempDir, ".agents", "tasks", "new-task");
			fs.mkdirSync(oldTask, { recursive: true });
			fs.mkdirSync(newTask, { recursive: true });

			const oldSpec = path.join(oldTask, "spec.md");
			const newSpec = path.join(newTask, "spec.md");
			fs.writeFileSync(oldSpec, "old", "utf-8");
			fs.writeFileSync(newSpec, "new", "utf-8");

			const oldTime = Date.now() - 30_000;
			const newTime = Date.now();
			fs.utimesSync(oldSpec, oldTime / 1000, oldTime / 1000);
			fs.utimesSync(newSpec, newTime / 1000, newTime / 1000);

			const resolved = inferTaskScopedCwd("Make a plan for this task", tempDir);
			assert.equal(resolved, newTask);
		} finally {
			removeTempDir(tempDir);
		}
	});
});

describe("resolveSingleAgentTaskCwd", () => {
	it("uses task inference for spec/planner/reviewer/worker", () => {
		const tempDir = createTempDir();
		try {
			const taskId = "task-abc";
			const taskDir = path.join(tempDir, ".agents", "tasks", taskId);
			fs.mkdirSync(taskDir, { recursive: true });

			for (const agent of ["spec", "planner", "reviewer", "worker"]) {
				const resolved = resolveSingleAgentTaskCwd(agent, "make a plan for `task-abc`", tempDir);
				assert.equal(resolved, taskDir);
			}
		} finally {
			removeTempDir(tempDir);
		}
	});

	it("allows scout/context-builder to create .agents/tasks/<id> when asked", () => {
		const tempDir = createTempDir();
		try {
			const expected = path.join(tempDir, ".agents", "tasks", "new-task-42");
			const scoutResult = resolveSingleAgentTaskCwd(
				"scout",
				"Please create task `new-task-42` in .agents/tasks and prepare context",
				tempDir,
			);
			assert.equal(scoutResult, expected);
			assert.ok(fs.existsSync(expected), "task directory should be created");

			const expected2 = path.join(tempDir, ".agents", "tasks", "another-task");
			const contextBuilderResult = resolveSingleAgentTaskCwd(
				"context-builder",
				"Set up task named another-task and gather context",
				tempDir,
			);
			assert.equal(contextBuilderResult, expected2);
			assert.ok(fs.existsSync(expected2), "task directory should be created");
		} finally {
			removeTempDir(tempDir);
		}
	});
});
