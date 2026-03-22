import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempDir, removeTempDir } from "./helpers.ts";
import {
	getMostRecentTask,
	inferTaskIdToCreate,
	inferTaskScopedCwd,
	listProjectTasks,
	resolveSingleAgentTaskCwd,
} from "../task-finder.ts";

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

	it("matches nested subtask path references", () => {
		const tempDir = createTempDir();
		try {
			const subtaskDir = path.join(tempDir, ".agents", "tasks", "platform-refactor", "subtasks", "auth-flow");
			fs.mkdirSync(subtaskDir, { recursive: true });

			const resolved = inferTaskScopedCwd(
				"Update plan for `.agents/tasks/platform-refactor/subtasks/auth-flow`",
				tempDir,
			);
			assert.equal(resolved, subtaskDir);
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

	it("uses latest filesystem activity for 'current task' phrasing", () => {
		const tempDir = createTempDir();
		try {
			const olderTask = path.join(tempDir, ".agents", "tasks", "older-task");
			const activeTask = path.join(tempDir, ".agents", "tasks", "active-task");
			fs.mkdirSync(path.join(olderTask, "stages"), { recursive: true });
			fs.mkdirSync(path.join(activeTask, "content"), { recursive: true });

			const olderStage = path.join(olderTask, "stages", "stage-a.md");
			const activeContent = path.join(activeTask, "content", "note.md");
			fs.writeFileSync(olderStage, "older", "utf-8");
			fs.writeFileSync(activeContent, "active", "utf-8");

			const oldTime = Date.now() - 60_000;
			const newTime = Date.now();
			fs.utimesSync(olderStage, oldTime / 1000, oldTime / 1000);
			fs.utimesSync(activeContent, newTime / 1000, newTime / 1000);

			const resolved = inferTaskScopedCwd("continue work on the current task", tempDir);
			assert.equal(resolved, activeTask);
		} finally {
			removeTempDir(tempDir);
		}
	});

	it("uses latest filesystem activity for continuation phrasing without explicit task id", () => {
		const tempDir = createTempDir();
		try {
			const olderTask = path.join(tempDir, ".agents", "tasks", "older-task");
			const activeTask = path.join(tempDir, ".agents", "tasks", "active-task");
			fs.mkdirSync(olderTask, { recursive: true });
			fs.mkdirSync(activeTask, { recursive: true });
			const olderPlan = path.join(olderTask, "plan.md");
			const activeProgress = path.join(activeTask, "progress.md");
			fs.writeFileSync(olderPlan, "older", "utf-8");
			fs.writeFileSync(activeProgress, "active", "utf-8");
			const oldTime = Date.now() - 60_000;
			const newTime = Date.now();
			fs.utimesSync(olderPlan, oldTime / 1000, oldTime / 1000);
			fs.utimesSync(activeProgress, newTime / 1000, newTime / 1000);

			assert.equal(inferTaskScopedCwd("pick up where we left off", tempDir), activeTask);
			assert.equal(inferTaskScopedCwd("resume planning", tempDir), activeTask);
		} finally {
			removeTempDir(tempDir);
		}
	});
});

describe("resolveSingleAgentTaskCwd", () => {
	it("uses task inference for spec/planner/implementer/reviewer/worker", () => {
		const tempDir = createTempDir();
		try {
			const taskId = "task-abc";
			const taskDir = path.join(tempDir, ".agents", "tasks", taskId);
			fs.mkdirSync(taskDir, { recursive: true });

			for (const agent of ["spec", "planner", "implementer", "reviewer", "worker"]) {
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

	it("creates nested subtask folders for scout/context-builder", () => {
		const tempDir = createTempDir();
		try {
			const expected = path.join(tempDir, ".agents", "tasks", "platform-refactor", "subtasks", "auth-flow");
			const scoutResult = resolveSingleAgentTaskCwd(
				"scout",
				"Create subtask auth-flow for task platform-refactor and gather context",
				tempDir,
			);
			assert.equal(scoutResult, expected);
			assert.ok(fs.existsSync(expected), "subtask directory should be created");
		} finally {
			removeTempDir(tempDir);
		}
	});
});

describe("task registry helpers", () => {
	it("lists project tasks ordered by most recent filesystem activity", () => {
		const tempDir = createTempDir();
		try {
			const olderTask = path.join(tempDir, ".agents", "tasks", "older-task");
			const newerTask = path.join(tempDir, ".agents", "tasks", "newer-task");
			fs.mkdirSync(olderTask, { recursive: true });
			fs.mkdirSync(newerTask, { recursive: true });
			const olderProgress = path.join(olderTask, "progress.md");
			const newerPlan = path.join(newerTask, "plan.md");
			fs.writeFileSync(olderProgress, "older", "utf-8");
			fs.writeFileSync(newerPlan, "newer", "utf-8");
			const oldTime = Date.now() - 60_000;
			const newTime = Date.now();
			fs.utimesSync(olderProgress, oldTime / 1000, oldTime / 1000);
			fs.utimesSync(newerPlan, newTime / 1000, newTime / 1000);

			const tasks = listProjectTasks(tempDir);
			assert.equal(tasks[0]?.name, "newer-task");
			assert.equal(tasks[1]?.name, "older-task");
		} finally {
			removeTempDir(tempDir);
		}
	});

	it("returns the most recently active task", () => {
		const tempDir = createTempDir();
		try {
			const olderTask = path.join(tempDir, ".agents", "tasks", "older-task");
			const activeTask = path.join(tempDir, ".agents", "tasks", "active-task");
			fs.mkdirSync(olderTask, { recursive: true });
			fs.mkdirSync(activeTask, { recursive: true });
			const olderContext = path.join(olderTask, "context.md");
			const activeProgress = path.join(activeTask, "progress.md");
			fs.writeFileSync(olderContext, "older", "utf-8");
			fs.writeFileSync(activeProgress, "active", "utf-8");
			const oldTime = Date.now() - 60_000;
			const newTime = Date.now();
			fs.utimesSync(olderContext, oldTime / 1000, oldTime / 1000);
			fs.utimesSync(activeProgress, newTime / 1000, newTime / 1000);

			const task = getMostRecentTask(tempDir);
			assert.equal(task?.name, "active-task");
		} finally {
			removeTempDir(tempDir);
		}
	});
});

describe("inferTaskIdToCreate", () => {
	it("returns nested task/subtasks target when prompt asks for subtask creation", () => {
		const inferred = inferTaskIdToCreate("Please create subtask auth-flow for task platform-refactor");
		assert.equal(inferred, "platform-refactor/subtasks/auth-flow");
	});
});
