import * as fs from "node:fs";
import * as path from "node:path";

function resolveBaseCwd(runtimeCwd: string, requestedCwd?: string): string {
	if (!requestedCwd) return runtimeCwd;
	return path.isAbsolute(requestedCwd) ? requestedCwd : path.resolve(runtimeCwd, requestedCwd);
}

export function resolveSingleReadPaths(
	reads: string[] | false | undefined,
	runtimeCwd: string,
	requestedCwd?: string,
): string[] {
	if (!reads || reads.length === 0) return [];
	const baseCwd = resolveBaseCwd(runtimeCwd, requestedCwd);
	return reads.map((filePath) => (path.isAbsolute(filePath) ? filePath : path.resolve(baseCwd, filePath)));
}

export function injectSingleReadInstruction(task: string, readPaths: string[]): string {
	if (readPaths.length === 0) return task;
	return `[Read from: ${readPaths.join(", ")}]\n\n${task}`;
}

export function resolveSingleOutputPath(
	output: string | false | undefined,
	runtimeCwd: string,
	requestedCwd?: string,
): string | undefined {
	if (typeof output !== "string" || !output) return undefined;
	if (path.isAbsolute(output)) return output;
	return path.resolve(resolveBaseCwd(runtimeCwd, requestedCwd), output);
}

export function injectSingleOutputInstruction(task: string, outputPath: string | undefined): string {
	if (!outputPath) return task;
	return `${task}\n\n---\n**Output:** Write your findings to: ${outputPath}`;
}

export function resolveSingleProgressPath(
	outputPath: string | undefined,
	runtimeCwd: string,
	requestedCwd?: string,
): string | undefined {
	if (!outputPath) return undefined;
	return path.join(resolveBaseCwd(runtimeCwd, requestedCwd), "progress.md");
}

export function persistSingleOutput(
	outputPath: string | undefined,
	fullOutput: string,
): { savedPath?: string; error?: string } {
	if (!outputPath) return {};
	try {
		fs.mkdirSync(path.dirname(outputPath), { recursive: true });
		const content = fullOutput.trim();
		const prefix = fs.existsSync(outputPath) && fs.readFileSync(outputPath, "utf-8").trim().length > 0
			? "\n\n---\n\n"
			: "";
		fs.appendFileSync(outputPath, `${prefix}${content}`, "utf-8");
		return { savedPath: outputPath };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export function finalizeSingleOutput(params: {
	fullOutput: string;
	truncatedOutput?: string;
	outputPath?: string;
	exitCode: number;
}): { displayOutput: string; savedPath?: string; saveError?: string } {
	let displayOutput = params.truncatedOutput || params.fullOutput;
	if (params.outputPath && params.exitCode === 0) {
		const save = persistSingleOutput(params.outputPath, params.fullOutput);
		if (save.savedPath) {
			displayOutput += `\n\n📄 Output saved to: ${save.savedPath}`;
			return { displayOutput, savedPath: save.savedPath };
		}
		if (save.error) {
			displayOutput += `\n\n⚠️ Failed to save output to: ${params.outputPath}\n${save.error}`;
			return { displayOutput, saveError: save.error };
		}
	}
	return { displayOutput };
}
