import * as fs from "node:fs";
import * as path from "node:path";

interface TaskDirEntry {
	name: string;
	path: string;
	mtimeMs: number;
}

const TASK_INFERENCE_AGENTS = new Set(["spec", "planner", "reviewer", "worker"]);
const TASK_CREATOR_AGENTS = new Set(["scout", "context-builder"]);

function normalizeToken(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function tasksRoot(baseCwd: string): string {
	return path.join(baseCwd, ".agents", "tasks");
}

function ensureTasksRoot(baseCwd: string): string {
	const root = tasksRoot(baseCwd);
	fs.mkdirSync(root, { recursive: true });
	return root;
}

function listTaskDirs(baseCwd: string): TaskDirEntry[] {
	const root = tasksRoot(baseCwd);
	if (!fs.existsSync(root)) return [];

	const entries = fs.readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const taskDir = path.join(root, entry.name);
			const specPath = path.join(taskDir, "spec.md");
			const contextPath = path.join(taskDir, "context.md");
			const progressPath = path.join(taskDir, "progress.md");
			const candidates = [taskDir, specPath, contextPath, progressPath]
				.filter((p) => fs.existsSync(p))
				.map((p) => fs.statSync(p).mtimeMs);
			const mtimeMs = candidates.length ? Math.max(...candidates) : fs.statSync(taskDir).mtimeMs;
			return { name: entry.name, path: taskDir, mtimeMs };
		});

	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return entries;
}

function extractTaskReferences(taskText: string): string[] {
	const refs = new Set<string>();

	for (const m of taskText.matchAll(/`([^`]+)`/g)) {
		const v = m[1]?.trim();
		if (v) refs.add(v);
	}
	for (const m of taskText.matchAll(/\.agents\/tasks\/([a-zA-Z0-9._-]+)/g)) {
		const v = m[1]?.trim();
		if (v) refs.add(v);
	}
	for (const m of taskText.matchAll(/["']([a-zA-Z0-9._-]{3,})["']/g)) {
		const v = m[1]?.trim();
		if (v) refs.add(v);
	}

	return [...refs];
}

function matchExistingTaskDir(taskText: string, baseCwd: string): string | undefined {
	const tasks = listTaskDirs(baseCwd);
	if (!tasks.length) return undefined;

	const refs = extractTaskReferences(taskText);
	if (refs.length) {
		const direct = new Map(tasks.map((t) => [t.name.toLowerCase(), t.path]));
		const normalized = new Map(tasks.map((t) => [normalizeToken(t.name), t.path]));

		for (const ref of refs) {
			const lower = ref.toLowerCase();
			const directMatch = direct.get(lower);
			if (directMatch) return directMatch;

			const normalizedMatch = normalized.get(normalizeToken(ref));
			if (normalizedMatch) return normalizedMatch;
		}

		const lowerTaskText = taskText.toLowerCase();
		for (const task of tasks) {
			if (refs.some((ref) => task.name.toLowerCase().includes(ref.toLowerCase()) || lowerTaskText.includes(task.name.toLowerCase()))) {
				return task.path;
			}
		}
	}

	if (/\b(this|the)\s+task\b/i.test(taskText)) {
		return tasks[0]?.path;
	}

	return undefined;
}

function hasCreateTaskIntent(taskText: string): boolean {
	return /(create|start|initialize|set\s*up|setup|make)\b[\s\S]{0,40}\btask\b/i.test(taskText)
		|| /\.agents\/tasks\b/i.test(taskText);
}

function extractTaskIdToCreate(taskText: string): string | undefined {
	for (const ref of extractTaskReferences(taskText)) {
		const id = normalizeToken(ref);
		if (id.length >= 3) return id;
	}

	const explicit = taskText.match(/\btask(?:\s+id)?\s*[:=]?\s*([a-zA-Z0-9._-]{3,})\b/i)?.[1];
	if (explicit) {
		const explicitNorm = normalizeToken(explicit);
		if (explicitNorm.length >= 3 && !new Set(["named", "called", "this", "that", "the", "new"]).has(explicitNorm)) {
			return explicitNorm;
		}
	}

	const named = taskText.match(/\b(?:called|named)\s+([a-zA-Z0-9._-]{3,})\b/i)?.[1];
	if (named) {
		const id = normalizeToken(named);
		if (id.length >= 3) return id;
	}

	return undefined;
}

function ensureCreatedTaskDir(taskText: string, baseCwd: string): string | undefined {
	if (!hasCreateTaskIntent(taskText)) return undefined;
	const taskId = extractTaskIdToCreate(taskText);
	if (!taskId) return undefined;

	const root = ensureTasksRoot(baseCwd);
	const dir = path.join(root, taskId);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Infer task-scoped cwd from the natural-language task string.
 *
 * Used to make single-agent runs write into .agents/tasks/<task>/
 * when the prompt references a known task id.
 */
export function inferTaskScopedCwd(taskText: string, baseCwd: string): string | undefined {
	return matchExistingTaskDir(taskText, baseCwd);
}

/**
 * Resolve task-scoped cwd for single-agent runs.
 *
 * - spec/planner/reviewer/worker: infer existing task directory
 * - scout/context-builder: infer existing task directory; if asked to create a task,
 *   create .agents/tasks/<taskId> and return it
 */
export function resolveSingleAgentTaskCwd(agentName: string, taskText: string, baseCwd: string): string | undefined {
	const agent = agentName.toLowerCase();
	if (TASK_INFERENCE_AGENTS.has(agent)) {
		return matchExistingTaskDir(taskText, baseCwd);
	}
	if (TASK_CREATOR_AGENTS.has(agent)) {
		return matchExistingTaskDir(taskText, baseCwd) ?? ensureCreatedTaskDir(taskText, baseCwd);
	}
	return undefined;
}
