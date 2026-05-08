import { describe, expect, test } from "bun:test";
import {
	AgentNotInstalled,
	AgentRuntimeError,
	NotFoundError,
	SandboxError,
	ToolchainMismatch,
	ValidationError,
} from "../core/errors.ts";
import { methodNotAllowed, notFound, notImplemented, renderError } from "./errors.ts";

describe("renderError", () => {
	test("NotFoundError → 404 with code/message", () => {
		const r = renderError(new NotFoundError("burrow bur_x not found"));
		expect(r.status).toBe(404);
		expect(r.envelope.error.code).toBe("not_found");
		expect(r.envelope.error.message).toBe("burrow bur_x not found");
	});

	test("ValidationError → 400", () => {
		const r = renderError(new ValidationError("bad input"));
		expect(r.status).toBe(400);
		expect(r.envelope.error.code).toBe("validation_error");
	});

	test("AgentNotInstalled → 424", () => {
		const r = renderError(new AgentNotInstalled("missing claude-code"));
		expect(r.status).toBe(424);
	});

	test("AgentRuntimeError → 502", () => {
		const r = renderError(new AgentRuntimeError("agent crashed"));
		expect(r.status).toBe(502);
	});

	test("SandboxError → 502", () => {
		const r = renderError(new SandboxError("bwrap failed"));
		expect(r.status).toBe(502);
	});

	test("ToolchainMismatch → 409", () => {
		const r = renderError(new ToolchainMismatch("bun version drift"));
		expect(r.status).toBe(409);
	});

	test("includes hint when BurrowError carries one", () => {
		const r = renderError(new ValidationError("bad input", { recoveryHint: "pass --foo" }));
		expect(r.envelope.error.hint).toBe("pass --foo");
	});

	test("plain Error → 500 internal_error", () => {
		const r = renderError(new Error("kaboom"));
		expect(r.status).toBe(500);
		expect(r.envelope.error.code).toBe("internal_error");
		expect(r.envelope.error.message).toBe("kaboom");
	});

	test("non-Error thrown value → 500 with String() message", () => {
		const r = renderError("just a string");
		expect(r.status).toBe(500);
		expect(r.envelope.error.message).toBe("just a string");
	});
});

describe("notImplemented / notFound / methodNotAllowed", () => {
	test("notImplemented → 501 with route in message", () => {
		const r = notImplemented("GET /burrows");
		expect(r.status).toBe(501);
		expect(r.envelope.error.code).toBe("not_implemented");
		expect(r.envelope.error.message).toContain("GET /burrows");
	});

	test("notFound → 404 with pathname in message", () => {
		const r = notFound("/nope");
		expect(r.status).toBe(404);
		expect(r.envelope.error.code).toBe("not_found");
		expect(r.envelope.error.message).toContain("/nope");
	});

	test("methodNotAllowed → 405", () => {
		const r = methodNotAllowed("PUT", "/burrows");
		expect(r.status).toBe(405);
		expect(r.envelope.error.code).toBe("method_not_allowed");
		expect(r.envelope.error.message).toContain("PUT");
		expect(r.envelope.error.message).toContain("/burrows");
	});
});
