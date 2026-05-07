import { describe, expect, test } from "bun:test";
import { generateId, isId } from "./ids.ts";

describe("generateId", () => {
	test("emits the right prefix for each kind", () => {
		expect(generateId("burrow")).toMatch(/^bur_[0-9a-z]{12}$/);
		expect(generateId("run")).toMatch(/^run_[0-9a-z]{12}$/);
		expect(generateId("message")).toMatch(/^msg_[0-9a-z]{12}$/);
		expect(generateId("event")).toMatch(/^evt_[0-9a-z]{12}$/);
	});

	test("ids are unique across many invocations", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 10_000; i++) ids.add(generateId("burrow"));
		expect(ids.size).toBe(10_000);
	});
});

describe("isId", () => {
	test("validates prefix and suffix shape", () => {
		const burrowId = generateId("burrow");
		expect(isId("burrow", burrowId)).toBe(true);
		expect(isId("run", burrowId)).toBe(false);
		expect(isId("burrow", "bur_short")).toBe(false);
		expect(isId("burrow", "BUR_0123456789ab")).toBe(false);
		expect(isId("burrow", "bur_!!!!!!!!!!!!")).toBe(false);
		expect(isId("burrow", undefined)).toBe(false);
		expect(isId("burrow", 42)).toBe(false);
	});
});
