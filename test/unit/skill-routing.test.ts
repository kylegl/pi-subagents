import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { resolveParallelBehaviors, resolveStepBehavior } from "../../src/shared/settings.ts";

const agent = (skills: string[]): AgentConfig => ({
	name: "worker",
	description: "test worker",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "project",
	skills,
});

describe("explicit skill routing provenance", () => {
	it("keeps agent-default skills conditional and routed run skills mandatory", () => {
		const behavior = resolveStepBehavior(agent(["default-skill", "overlap"]), {}, ["overlap", "run-skill"]);

		assert.deepEqual(behavior.skills, ["default-skill", "overlap", "run-skill"]);
		assert.deepEqual(behavior.mandatorySkills, ["overlap", "run-skill"]);
	});

	it("treats explicit step skills as mandatory and deduplicates overlap", () => {
		const behavior = resolveStepBehavior(
			agent(["default-skill"]),
			{ skills: ["step-skill", "overlap"] },
			["overlap", "run-skill"],
		);

		assert.deepEqual(behavior.skills, ["step-skill", "overlap", "run-skill"]);
		assert.deepEqual(behavior.mandatorySkills, ["step-skill", "overlap", "run-skill"]);
	});

	it("preserves provenance for parallel chain tasks", () => {
		const [behavior] = resolveParallelBehaviors(
			[{ agent: "worker", task: "work", skill: ["task-skill", "overlap"] }],
			[agent(["default-skill"])],
			0,
			["overlap", "run-skill"],
		);

		assert.deepEqual(behavior?.skills, ["task-skill", "overlap", "run-skill"]);
		assert.deepEqual(behavior?.mandatorySkills, ["task-skill", "overlap", "run-skill"]);
	});

	it("disables conditional and mandatory skills with skill false", () => {
		const stepBehavior = resolveStepBehavior(agent(["default-skill"]), { skills: false }, ["run-skill"]);
		const [parallelBehavior] = resolveParallelBehaviors(
			[{ agent: "worker", task: "work", skill: false }],
			[agent(["default-skill"])],
			0,
			["run-skill"],
		);

		assert.equal(stepBehavior.skills, false);
		assert.deepEqual(stepBehavior.mandatorySkills, []);
		assert.equal(parallelBehavior?.skills, false);
		assert.deepEqual(parallelBehavior?.mandatorySkills, []);
	});
});
