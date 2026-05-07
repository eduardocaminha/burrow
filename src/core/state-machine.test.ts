import { describe, expect, test } from "bun:test";
import {
	assertBurrowTransition,
	assertRunTransition,
	BURROW_TERMINAL_STATES,
	canTransitionBurrow,
	canTransitionRun,
	RUN_TERMINAL_STATES,
} from "./state-machine.ts";

describe("run state machine", () => {
	test("queued can advance to running or be cancelled", () => {
		expect(canTransitionRun("queued", "running")).toBe(true);
		expect(canTransitionRun("queued", "cancelled")).toBe(true);
		expect(canTransitionRun("queued", "succeeded")).toBe(false);
		expect(canTransitionRun("queued", "failed")).toBe(false);
	});

	test("running can finalize to any terminal", () => {
		expect(canTransitionRun("running", "succeeded")).toBe(true);
		expect(canTransitionRun("running", "failed")).toBe(true);
		expect(canTransitionRun("running", "cancelled")).toBe(true);
		expect(canTransitionRun("running", "queued")).toBe(false);
	});

	test("terminal states are sinks", () => {
		for (const t of RUN_TERMINAL_STATES) {
			expect(canTransitionRun(t, "running")).toBe(false);
			expect(canTransitionRun(t, "queued")).toBe(false);
		}
	});

	test("assertRunTransition throws on illegal moves", () => {
		expect(() => assertRunTransition("succeeded", "running")).toThrow(/illegal run transition/);
		expect(() => assertRunTransition("queued", "running")).not.toThrow();
	});
});

describe("burrow state machine", () => {
	test("active ↔ stopped, both can be destroyed", () => {
		expect(canTransitionBurrow("active", "stopped")).toBe(true);
		expect(canTransitionBurrow("stopped", "active")).toBe(true);
		expect(canTransitionBurrow("active", "destroyed")).toBe(true);
		expect(canTransitionBurrow("stopped", "destroyed")).toBe(true);
	});

	test("destroyed is terminal", () => {
		expect(BURROW_TERMINAL_STATES.has("destroyed")).toBe(true);
		expect(canTransitionBurrow("destroyed", "active")).toBe(false);
		expect(() => assertBurrowTransition("destroyed", "active")).toThrow();
	});
});
