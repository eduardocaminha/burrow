import { describe, expect, test } from "bun:test";
import { AGENT_ALIASES, knownBuiltInIds, resolveAgentAlias } from "./aliases.ts";

describe("resolveAgentAlias", () => {
	test("canonical ids resolve to themselves", () => {
		expect(resolveAgentAlias("claude-code")).toBe("claude-code");
		expect(resolveAgentAlias("sapling")).toBe("sapling");
		expect(resolveAgentAlias("codex")).toBe("codex");
	});

	test("short aliases collapse to canonical ids", () => {
		expect(resolveAgentAlias("claude")).toBe("claude-code");
		expect(resolveAgentAlias("cc")).toBe("claude-code");
		expect(resolveAgentAlias("sp")).toBe("sapling");
		expect(resolveAgentAlias("cx")).toBe("codex");
	});

	test("case- and whitespace-insensitive", () => {
		expect(resolveAgentAlias("  Claude  ")).toBe("claude-code");
		expect(resolveAgentAlias("CLAUDE-CODE")).toBe("claude-code");
	});

	test("unknown tokens return null", () => {
		expect(resolveAgentAlias("gemini")).toBeNull();
		expect(resolveAgentAlias("")).toBeNull();
	});
});

describe("knownBuiltInIds", () => {
	test("returns the three SPEC §12 built-ins in display order", () => {
		expect(knownBuiltInIds()).toEqual(["claude-code", "sapling", "codex"]);
	});

	test("every canonical id has at least one alias entry", () => {
		for (const id of knownBuiltInIds()) {
			expect(Object.values(AGENT_ALIASES)).toContain(id);
		}
	});
});
