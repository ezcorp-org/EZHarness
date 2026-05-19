import { test, expect, describe } from "bun:test";

/**
 * Replicate the resolveInitialMembers logic from TeamBuilderForm.svelte
 * to unit-test the legacy fallback without needing the Svelte component.
 */
interface TestMember { agentConfigId: string; overrides?: Record<string, unknown> }

function resolveInitialMembers(
	refs: { agents?: string[]; extensions?: string[]; members?: TestMember[] } | null | undefined,
): TestMember[] {
	if (Array.isArray(refs?.members) && refs.members.length > 0) {
		return refs.members;
	}
	if (Array.isArray(refs?.agents) && refs.agents.length > 0) {
		return refs.agents.map((id) => ({ agentConfigId: id }));
	}
	return [];
}

describe("TeamBuilderForm resolveInitialMembers fallback", () => {
	test("returns members when members array exists and is non-empty", () => {
		const refs = {
			members: [
				{ agentConfigId: "agent-1" },
				{ agentConfigId: "agent-2" },
			],
			agents: ["agent-3"],
		};
		const result = resolveInitialMembers(refs);
		expect(result).toEqual([
			{ agentConfigId: "agent-1" },
			{ agentConfigId: "agent-2" },
		]);
	});

	test("falls back to agents array when members is missing", () => {
		const refs = { agents: ["a1", "a2"] };
		const result = resolveInitialMembers(refs);
		expect(result).toEqual([
			{ agentConfigId: "a1" },
			{ agentConfigId: "a2" },
		]);
	});

	test("falls back to agents array when members is empty array", () => {
		const refs = { members: [], agents: ["a1"] };
		const result = resolveInitialMembers(refs);
		expect(result).toEqual([{ agentConfigId: "a1" }]);
	});

	test("returns empty array when both are missing", () => {
		const refs = { extensions: ["ext-1"] };
		const result = resolveInitialMembers(refs);
		expect(result).toEqual([]);
	});

	test("returns empty array when refs is null", () => {
		expect(resolveInitialMembers(null)).toEqual([]);
	});

	test("returns empty array when refs is undefined", () => {
		expect(resolveInitialMembers(undefined)).toEqual([]);
	});

	test("preserves member overrides when members array exists", () => {
		const refs = {
			members: [
				{ agentConfigId: "agent-1", overrides: { model: "gpt-4", provider: "openai" } },
				{ agentConfigId: "agent-2", overrides: { systemPromptAppend: "Be concise." } },
			],
		};
		const result = resolveInitialMembers(refs);
		expect(result).toEqual([
			{ agentConfigId: "agent-1", overrides: { model: "gpt-4", provider: "openai" } },
			{ agentConfigId: "agent-2", overrides: { systemPromptAppend: "Be concise." } },
		]);
	});

	test("flat agents fallback creates members without overrides", () => {
		const refs = { agents: ["a1", "a2", "a3"] };
		const result = resolveInitialMembers(refs);
		for (const member of result) {
			expect(member).toEqual({ agentConfigId: expect.any(String) });
			expect(member).not.toHaveProperty("overrides");
		}
		expect(result).toHaveLength(3);
	});
});
