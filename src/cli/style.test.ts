import { describe, expect, test } from "bun:test";
import { icon, shouldColor } from "./style.ts";

describe("style", () => {
	test("icon returns plain symbol when color is forced off", () => {
		expect(icon("ok", { color: false })).toBe("✓");
		expect(icon("fail", { color: false })).toBe("✗");
		expect(icon("warn", { color: false })).toBe("!");
		expect(icon("pending", { color: false })).toBe("-");
	});

	test("shouldColor honors explicit overrides", () => {
		expect(shouldColor({ color: true })).toBe(true);
		expect(shouldColor({ color: false })).toBe(false);
	});
});
