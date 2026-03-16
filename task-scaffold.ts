import * as fs from "node:fs";
import * as path from "node:path";
import { inferTaskIdToCreate, shouldCreateTaskFromText } from "./task-finder.js";

const SCAFFOLD_AGENTS = new Set(["scout", "context-builder", "review", "reviewer", "worker", "spec", "planner"]);

function sanitizeFileStem(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "notes";
}

export function shouldUseTaskScaffold(originalTask: string, chainAgents: string[]): boolean {
	if (!shouldCreateTaskFromText(originalTask)) return false;
	if (!inferTaskIdToCreate(originalTask)) return false;
	return chainAgents.some((agent) => SCAFFOLD_AGENTS.has(agent.toLowerCase()));
}

export function scaffoldOutputPath(agentName: string, usedPaths: Set<string>): string {
	const baseStem = sanitizeFileStem(agentName);
	let candidate = `content/${baseStem}.md`;
	let n = 2;
	while (usedPaths.has(candidate)) {
		candidate = `content/${baseStem}-${n}.md`;
		n += 1;
	}
	usedPaths.add(candidate);
	return candidate;
}

export function ensureScaffoldDoc(chainDir: string, relativePath: string, content: string): string {
	const fullPath = path.join(chainDir, relativePath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, `${content.trim()}\n`, "utf-8");
	return fullPath;
}

export function writeTaskContextIndex(chainDir: string): void {
	const contentDir = path.join(chainDir, "content");
	if (!fs.existsSync(contentDir)) return;

	const docs = fs.readdirSync(contentDir)
		.filter((file) => file.endsWith(".md"))
		.sort((a, b) => a.localeCompare(b));

	if (!docs.length) return;

	const lines = [
		"# Task Context Index",
		"",
		"Supporting docs:",
		...docs.map((doc) => `- [${doc}](content/${doc})`),
		"",
	];

	fs.writeFileSync(path.join(chainDir, "context.md"), `${lines.join("\n")}`,
		"utf-8");
}
