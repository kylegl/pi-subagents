import * as fs from "node:fs";
import * as path from "node:path";

interface TaskDirEntry {
	name: string;
	relativePath: string;
	path: string;
	mtimeMs: number;
	taskName: string;
	subtaskName?: string;
}

const TASK_INFERENCE_AGENTS = new Set(["spec", "planner", "implementer", "reviewer", "worker"]);
const TASK_CREATOR_AGENTS = new Set(["scout", "context-builder"]);
const TASK_DOC_FILES = ["spec.md", "context.md", "plan.md", "progress.md", "content.md"];
const TASK_ACTIVITY_DIRS = ["content", "stages"];

function normalizeToken(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function normalizeTaskReference(value: string): string {
	return value
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\.?\/+/g, "")
		.replace(/^\.agents\/tasks\//i, "")
		.replace(/^tasks\//i, "")
		.replace(/^\/+/g, "")
		.replace(/\/+/g, "/")
		.replace(/\/+$/g, "");
}

function parseTaskTarget(value: string): string | undefined {
	const normalized = normalizeTaskReference(value);
	if (!normalized) return undefined;

	const subtaskMatch = normalized.match(/^([a-zA-Z0-9._-]{3,})\/subtasks\/([a-zA-Z0-9._-]{3,})$/);
	if (subtaskMatch) {
		const taskName = normalizeToken(subtaskMatch[1]!);
		const subtaskName = normalizeToken(subtaskMatch[2]!);
		if (taskName && subtaskName) return `${taskName}/subtasks/${subtaskName}`;
	}

	const taskOnly = normalized.match(/^([a-zA-Z0-9._-]{3,})$/)?.[1];
	if (taskOnly) {
		const taskName = normalizeToken(taskOnly);
		if (taskName) return taskName;
	}

	return undefined;
}

function tasksRoot(baseCwd: string): string {
	return path.join(baseCwd, ".agents", "tasks");
}

function ensureTasksRoot(baseCwd: string): string {
	const root = tasksRoot(baseCwd);
	fs.mkdirSync(root, { recursive: true });
	return root;
}

function collectActivityCandidatePaths(taskDir: string): string[] {
	const candidates = [
		taskDir,
		...TASK_ACTIVITY_DIRS.map((dir) => path.join(taskDir, dir)),
		...TASK_DOC_FILES.map((file) => path.join(taskDir, file)),
	].filter((candidate) => fs.existsSync(candidate));

	for (const activityDir of TASK_ACTIVITY_DIRS.map((dir) => path.join(taskDir, dir))) {
		if (!fs.existsSync(activityDir)) continue;
		for (const entry of fs.readdirSync(activityDir)) {
			candidates.push(path.join(activityDir, entry));
		}
	}

	return candidates;
}

function taskDirMtime(taskDir: string): number {
	const candidates = collectActivityCandidatePaths(taskDir)
		.filter((candidate) => fs.existsSync(candidate))
		.map((candidate) => fs.statSync(candidate).mtimeMs);
	return candidates.length ? Math.max(...candidates) : fs.statSync(taskDir).mtimeMs;
}

function listTaskDirs(baseCwd: string): TaskDirEntry[] {
	const root = tasksRoot(baseCwd);
	if (!fs.existsSync(root)) return [];

	const entries: TaskDirEntry[] = [];
	const taskEntries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());

	for (const taskEntry of taskEntries) {
		const taskName = taskEntry.name;
		const taskDir = path.join(root, taskName);
		entries.push({
			name: taskName,
			relativePath: taskName,
			path: taskDir,
			mtimeMs: taskDirMtime(taskDir),
			taskName,
		});

		const subtasksDir = path.join(taskDir, "subtasks");
		if (!fs.existsSync(subtasksDir)) continue;

		const subtaskEntries = fs.readdirSync(subtasksDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
		for (const subtaskEntry of subtaskEntries) {
			const subtaskName = subtaskEntry.name;
			const subtaskDir = path.join(subtasksDir, subtaskName);
			entries.push({
				name: `${taskName}/subtasks/${subtaskName}`,
				relativePath: `${taskName}/subtasks/${subtaskName}`,
				path: subtaskDir,
				mtimeMs: taskDirMtime(subtaskDir),
				taskName,
				subtaskName,
			});
		}
	}

	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return entries;
}

function extractTaskReferences(taskText: string): string[] {
	const refs = new Set<string>();

	for (const m of taskText.matchAll(/`([^`]+)`/g)) {
		const v = m[1]?.trim();
		if (v) refs.add(v);
	}
	for (const m of taskText.matchAll(/\.agents\/tasks\/([a-zA-Z0-9._\/-]+)/g)) {
		const v = m[1]?.trim();
		if (v) refs.add(v);
	}
	for (const m of taskText.matchAll(/["']([a-zA-Z0-9._\/-]{3,})["']/g)) {
		const v = m[1]?.trim();
		if (v) refs.add(v);
	}

	return [...refs];
}

function taskAliases(entry: TaskDirEntry): string[] {
	const aliases = new Set<string>([
		entry.relativePath,
		`.agents/tasks/${entry.relativePath}`,
		`tasks/${entry.relativePath}`,
	]);

	if (entry.subtaskName) {
		aliases.add(entry.subtaskName);
		aliases.add(`${entry.taskName}/${entry.subtaskName}`);
		aliases.add(`${entry.taskName}#${entry.subtaskName}`);
	} else {
		aliases.add(entry.taskName);
	}

	return [...aliases];
}

export function listProjectTasks(baseCwd: string): Array<{ name: string; path: string; lastActiveMs: number; taskName: string; subtaskName?: string }> {
	return listTaskDirs(baseCwd).map((task) => ({
		name: task.relativePath,
		path: task.path,
		lastActiveMs: task.mtimeMs,
		taskName: task.taskName,
		subtaskName: task.subtaskName,
	}));
}

export function getMostRecentTask(baseCwd: string): { name: string; path: string; lastActiveMs: number; taskName: string; subtaskName?: string } | undefined {
	return listProjectTasks(baseCwd)[0];
}

function hasImplicitCurrentTaskIntent(taskText: string): boolean {
	return /\b(this|the|current|active|latest|most\s+recent)\s+task\b/i.test(taskText)
		|| /\b(continue|resume|pick\s+up|carry\s+on)\b[\s\S]{0,40}\b(task|plan|planning|spec|review|progress|work)\b/i.test(taskText)
		|| /\b(pick\s+up|resume|continue)\b[\s\S]{0,40}\b(where\s+we\s+left\s+off|left\s+off)\b/i.test(taskText)
		|| /\b(where\s+we\s+left\s+off|left\s+off)\b/i.test(taskText);
}

function matchExistingTaskDir(taskText: string, baseCwd: string): string | undefined {
	const tasks = listTaskDirs(baseCwd);
	if (!tasks.length) return undefined;

	const refs = extractTaskReferences(taskText);
	if (refs.length) {
		const direct = new Map<string, string>();
		const normalized = new Map<string, string>();
		for (const task of tasks) {
			for (const alias of taskAliases(task)) {
				const lowerAlias = normalizeTaskReference(alias).toLowerCase();
				if (lowerAlias && !direct.has(lowerAlias)) {
					direct.set(lowerAlias, task.path);
				}
				const tokenAlias = normalizeToken(alias);
				if (tokenAlias && !normalized.has(tokenAlias)) {
					normalized.set(tokenAlias, task.path);
				}
			}
		}

		for (const ref of refs) {
			const normalizedRef = normalizeTaskReference(ref).toLowerCase();
			const directMatch = direct.get(normalizedRef);
			if (directMatch) return directMatch;

			const normalizedMatch = normalized.get(normalizeToken(ref));
			if (normalizedMatch) return normalizedMatch;
		}

		const lowerTaskText = taskText.toLowerCase();
		for (const task of tasks) {
			const aliases = taskAliases(task).map((alias) => normalizeTaskReference(alias).toLowerCase());
			if (refs.some((ref) => aliases.some((alias) => alias.includes(normalizeTaskReference(ref).toLowerCase())))
				|| aliases.some((alias) => lowerTaskText.includes(alias))) {
				return task.path;
			}
		}
	}

	if (hasImplicitCurrentTaskIntent(taskText)) {
		return tasks[0]?.path;
	}

	if (tasks.length === 1 && /\b(task|plan|spec|review|progress|continue|resume)\b/i.test(taskText)) {
		return tasks[0]?.path;
	}

	return undefined;
}

function hasCreateTaskIntent(taskText: string): boolean {
	return /(create|start|initialize|set\s*up|setup|make)\b[\s\S]{0,40}\b(task|subtask)\b/i.test(taskText)
		|| /\.agents\/tasks\b/i.test(taskText)
		|| /\bsubtasks\//i.test(taskText);
}

function extractTaskIdToCreate(taskText: string): string | undefined {
	for (const ref of extractTaskReferences(taskText)) {
		const target = parseTaskTarget(ref);
		if (target) return target;
	}

	const subtaskForward = taskText.match(/\bsubtask(?:\s+(?:named|called))?\s+([a-zA-Z0-9._-]{3,})\b[\s\S]{0,80}\b(?:for|under|in)\s+task\s+([a-zA-Z0-9._-]{3,})\b/i);
	if (subtaskForward) {
		const subtaskName = normalizeToken(subtaskForward[1]!);
		const taskName = normalizeToken(subtaskForward[2]!);
		if (taskName && subtaskName) return `${taskName}/subtasks/${subtaskName}`;
	}

	const subtaskReverse = taskText.match(/\btask\s+([a-zA-Z0-9._-]{3,})\b[\s\S]{0,80}\bsubtask(?:\s+(?:named|called))?\s+([a-zA-Z0-9._-]{3,})\b/i);
	if (subtaskReverse) {
		const taskName = normalizeToken(subtaskReverse[1]!);
		const subtaskName = normalizeToken(subtaskReverse[2]!);
		if (taskName && subtaskName) return `${taskName}/subtasks/${subtaskName}`;
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

export function shouldCreateTaskFromText(taskText: string): boolean {
	return hasCreateTaskIntent(taskText);
}

export function inferTaskIdToCreate(taskText: string): string | undefined {
	return extractTaskIdToCreate(taskText);
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
		if (hasCreateTaskIntent(taskText)) {
			return ensureCreatedTaskDir(taskText, baseCwd) ?? matchExistingTaskDir(taskText, baseCwd);
		}
		return matchExistingTaskDir(taskText, baseCwd);
	}
	return undefined;
}
