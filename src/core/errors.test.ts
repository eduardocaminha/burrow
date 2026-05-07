import { describe, expect, test } from "bun:test";
import {
	BurrowError,
	formatError,
	NotFoundError,
	SandboxError,
	SandboxPrimitiveMissing,
	ValidationError,
} from "./errors.ts";

describe("BurrowError hierarchy", () => {
	test("subclasses extend BurrowError and carry stable codes", () => {
		const sb = new SandboxError("nope");
		const sbm = new SandboxPrimitiveMissing("missing");
		const nf = new NotFoundError("gone");
		const ve = new ValidationError("bad");

		expect(sb).toBeInstanceOf(BurrowError);
		expect(sb).toBeInstanceOf(Error);
		expect(sbm).toBeInstanceOf(SandboxError);
		expect(sb.code).toBe("sandbox_error");
		expect(sbm.code).toBe("bwrap_or_sb_missing");
		expect(nf.code).toBe("not_found");
		expect(ve.code).toBe("validation_error");
	});

	test("recoveryHint round-trips", () => {
		const e = new ValidationError("bad config", { recoveryHint: "fix it" });
		expect(e.recoveryHint).toBe("fix it");
	});

	test("name reflects class for stack trace identification", () => {
		const e = new SandboxPrimitiveMissing("missing");
		expect(e.name).toBe("SandboxPrimitiveMissing");
	});

	test("cause is preserved via Error options", () => {
		const root = new Error("root");
		const e = new SandboxError("wrap", { cause: root });
		expect(e.cause).toBe(root);
	});
});

describe("formatError", () => {
	test("renders code, message, and recoveryHint", () => {
		const e = new ValidationError("bad config", { recoveryHint: "fix it" });
		expect(formatError(e)).toBe("[validation_error] bad config\n  → fix it");
	});

	test("omits hint line when absent", () => {
		const e = new NotFoundError("missing");
		expect(formatError(e)).toBe("[not_found] missing");
	});

	test("falls back for non-BurrowError throws", () => {
		expect(formatError(new Error("plain"))).toBe("[unexpected] plain");
		expect(formatError("string thrown")).toBe("[unexpected] string thrown");
	});
});
