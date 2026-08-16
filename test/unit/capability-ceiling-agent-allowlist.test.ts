import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { handleList } from "../../src/agents/agent-management.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { resolveSubagentLaunchContract } from "../../src/api/preflight.ts";
import {
	decodeSubagentCapabilityCeiling,
	encodeSubagentCapabilityCeiling,
	intersectSubagentCapabilityCeilings,
	parseSubagentCapabilityCeiling,
	registerSubagentCapabilityCeiling,
} from "../../src/api/capability-ceiling.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";

function agent(name: string): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: `${name} prompt`,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: `/tmp/${name}.md`,
	};
}

const FIXTURE_ALLOWED_AGENT = "ceiling-allowed-fixture";
const FIXTURE_BLOCKED_AGENT = "ceiling-blocked-fixture";

function createAgentFixture(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-capability-agents-"));
	execFileSync("git", ["init", "-q", cwd]);
	const agentDir = path.join(cwd, ".pi", "agents");
	fs.mkdirSync(agentDir, { recursive: true });
	for (const name of [FIXTURE_ALLOWED_AGENT, FIXTURE_BLOCKED_AGENT])
		fs.writeFileSync(path.join(agentDir, `${name}.md`), `---\nname: ${name}\ndescription: ${name} agent\ntools: read\n---\n${name} prompt\n`, "utf-8");
	return cwd;
}

function readText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	if (!first || first.type !== "text" || typeof first.text !== "string")
		assert.fail("expected a text result");
	return first.text;
}

describe("capability ceiling agent allowlist", () => {
	it("parses, round-trips, and intersects allowedAgents", () => {
		const parsed = parseSubagentCapabilityCeiling({ version: 1, allowedAgents: ["worker", "reviewer", "worker"], denyExtensions: false, sources: ["plan"] });
		assert.deepEqual(parsed.allowedAgents, ["reviewer", "worker"]);
		assert.deepEqual(decodeSubagentCapabilityCeiling(encodeSubagentCapabilityCeiling(parsed)), parsed);

		assert.deepEqual(intersectSubagentCapabilityCeilings(
			{ version: 1, allowedAgents: ["worker", "reviewer"], denyExtensions: false, sources: ["outer"] },
			{ version: 1, allowedAgents: ["reviewer", "scout"], denyExtensions: true, sources: ["inner"] },
		), {
			version: 1,
			allowedAgents: ["reviewer"],
			denyExtensions: true,
			sources: ["inner", "outer"],
		});

		assert.deepEqual(intersectSubagentCapabilityCeilings(
			{ version: 1, allowedTools: ["read"], denyExtensions: false, sources: ["tools-only"] },
			{ version: 1, allowedAgents: [], denyExtensions: false, sources: ["none"] },
		)?.allowedAgents, []);
	});

	it("marks non-allowlisted agents as restricted in list output", () => {
		const cwd = createAgentFixture();
		const sessionId = `allowlist-list-${path.basename(cwd)}`;
		const handle = registerSubagentCapabilityCeiling({ sessionId, source: "plan-mode", ceiling: { allowedAgents: [FIXTURE_ALLOWED_AGENT] } });
		try {
			const result = handleList({}, { cwd, currentSessionId: sessionId, modelRegistry: { getAvailable: () => [] } as never });
			const text = readText(result);
			assert.match(text, /Executable agents:/);
			assert.ok(text.includes(`- ${FIXTURE_ALLOWED_AGENT} `));
			assert.match(text, /Restricted agents \(not executable in this session; capability ceiling: plan-mode\):/);
			assert.ok(text.includes(`- ${FIXTURE_BLOCKED_AGENT} `));
		} finally {
			handle.dispose();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects a non-allowlisted agent in preflight launch resolution", async () => {
		const cwd = createAgentFixture();
		try {
			const result = await resolveSubagentLaunchContract({
				agent: FIXTURE_BLOCKED_AGENT,
				cwd,
				capabilityCeiling: { version: 1, allowedAgents: [FIXTURE_ALLOWED_AGENT], denyExtensions: false, sources: ["plan-mode"] },
			});
			assert.equal(result.ok, false);
			assert.equal(result.code, "restricted_agent");
			assert.ok(result.message.includes(`does not allow agent '${FIXTURE_BLOCKED_AGENT}'`));
			assert.ok(result.message.includes(`Allowed agents: ${FIXTURE_ALLOWED_AGENT}`));
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects a non-allowlisted foreground launch before spawning", async () => {
		const result = await runSync(process.cwd(), [agent("worker"), agent("reviewer")], "worker", "Do work", {
			runId: "capability-ceiling-test",
			capabilityCeiling: { version: 1, allowedAgents: ["reviewer"], denyExtensions: false, sources: ["plan-mode"] },
		});
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /does not allow agent 'worker'/);
		assert.deepEqual(result.capabilityCeiling?.allowedAgents, ["reviewer"]);
	});

	it("includes allowedAgents in propagated launch env and audit metadata", () => {
		const { env, capabilityAudit } = buildPiArgs({
			baseArgs: [],
			task: "Review",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			childAgentName: "reviewer",
			capabilityCeiling: { version: 1, allowedAgents: ["reviewer"], allowedTools: ["read"], denyExtensions: true, sources: ["plan-mode"] },
		});
		assert.equal(capabilityAudit?.agentAllowed, true);
		assert.deepEqual(capabilityAudit?.agentRestrictionSources, ["plan-mode"]);
		assert.ok(env.PI_SUBAGENT_CAPABILITY_CEILING_V1);
		assert.deepEqual(decodeSubagentCapabilityCeiling(env.PI_SUBAGENT_CAPABILITY_CEILING_V1)?.allowedAgents, ["reviewer"]);
	});
});
