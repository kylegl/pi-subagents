/**
 * Shared chain artifact directory routing.
 *
 * Used by both sync and async chain execution so path behavior stays identical.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createChainDir, type ChainDirMode } from "./settings.js";
import { inferTaskIdToCreate, shouldCreateTaskFromText } from "./task-finder.js";

export interface ChainArtifactRouteParams {
	runId: string;
	baseCwd: string;
	originalTask: string;
	chainDir?: string;
	taskId?: string;
	taskRoot?: string;
	taskMode?: "direct" | "run";
}

function slugifyTaskName(task: string, fallback: string): string {
	const slug = task
		.toLowerCase()
		.replace(/\{[^}]+\}/g, " ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return slug || fallback;
}

function resolveDefaultTaskRoot(baseCwd: string): string {
	const agentsRoot = path.join(baseCwd, ".agents");
	const tasksRoot = path.join(agentsRoot, "tasks");
	for (const dir of [
		agentsRoot,
		tasksRoot,
		path.join(agentsRoot, "notes"),
		path.join(agentsRoot, "docs"),
		path.join(agentsRoot, "sources"),
	]) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return tasksRoot;
}

function normalizeTaskMode(taskMode: "direct" | "run" | undefined, defaultMode: ChainDirMode): ChainDirMode {
	if (taskMode === "direct") return "direct";
	if (taskMode === "run") return "run";
	return defaultMode;
}

/**
 * Resolve and create the chain artifact directory using precedence:
 * 1) chainDir (existing behavior)
 * 2) taskId + (taskRoot, taskMode)
 * 3) default task-slug routing
 */
export function resolveChainArtifactDir(params: ChainArtifactRouteParams): string {
	const { runId, baseCwd, originalTask, chainDir, taskId, taskRoot, taskMode } = params;

	if (chainDir) {
		return createChainDir(runId, chainDir, "run");
	}

	if (taskId) {
		const resolvedTaskRoot = path.resolve(taskRoot ?? path.join(baseCwd, ".agents", "tasks"));
		const mode = normalizeTaskMode(taskMode, "direct");
		return createChainDir(runId, path.join(resolvedTaskRoot, taskId), mode);
	}

	const defaultTaskRoot = resolveDefaultTaskRoot(baseCwd);
	if (shouldCreateTaskFromText(originalTask)) {
		const inferredTaskId = inferTaskIdToCreate(originalTask);
		if (inferredTaskId) {
			return createChainDir(runId, path.join(defaultTaskRoot, inferredTaskId), "direct");
		}
	}
	const taskDirName = slugifyTaskName(originalTask, runId.slice(0, 12));
	return createChainDir(runId, path.join(defaultTaskRoot, taskDirName), "run");
}
