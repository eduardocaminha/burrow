import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { bearerAuth, NO_AUTH, resolveAuth } from "./auth.ts";

function req(headers: Record<string, string> = {}): Request {
	return new Request("http://localhost/x", { headers });
}

describe("bearerAuth", () => {
	test("rejects construction with empty token", () => {
		expect(() => bearerAuth("")).toThrow();
	});

	test("missing Authorization → 401 missing-header", () => {
		const r = bearerAuth("s3cr3t").authorize(req());
		expect(r).toMatchObject({ ok: false, status: 401, code: "unauthorized" });
		if (r.ok === false) expect(r.message).toContain("missing");
	});

	test("non-Bearer scheme → 401 invalid_request", () => {
		const r = bearerAuth("s3cr3t").authorize(req({ authorization: "Basic abc" }));
		expect(r).toMatchObject({ ok: false, status: 401 });
		if (r.ok === false) expect(r.challenge).toContain('error="invalid_request"');
	});

	test("Bearer with empty token → 401 invalid_request", () => {
		const r = bearerAuth("s3cr3t").authorize(req({ authorization: "Bearer  " }));
		expect(r.ok).toBe(false);
	});

	test("wrong token → 401 invalid_token", () => {
		const r = bearerAuth("s3cr3t").authorize(req({ authorization: "Bearer nope" }));
		expect(r).toMatchObject({ ok: false });
		if (r.ok === false) expect(r.challenge).toContain('error="invalid_token"');
	});

	test("token of different length → still 401 invalid_token (no length leak)", () => {
		const r = bearerAuth("s3cr3t").authorize(req({ authorization: "Bearer x" }));
		expect(r).toMatchObject({ ok: false });
		if (r.ok === false) expect(r.challenge).toContain('error="invalid_token"');
	});

	test("matching token → ok", () => {
		const r = bearerAuth("s3cr3t").authorize(req({ authorization: "Bearer s3cr3t" }));
		expect(r.ok).toBe(true);
	});

	test("Bearer scheme is case-insensitive", () => {
		const r = bearerAuth("s3cr3t").authorize(req({ authorization: "bearer s3cr3t" }));
		expect(r.ok).toBe(true);
	});

	test("trailing whitespace in header is tolerated", () => {
		const r = bearerAuth("s3cr3t").authorize(req({ authorization: "Bearer s3cr3t   " }));
		expect(r.ok).toBe(true);
	});
});

describe("NO_AUTH", () => {
	test("permits every request", () => {
		expect(NO_AUTH.authorize(req()).ok).toBe(true);
		expect(NO_AUTH.authorize(req({ authorization: "garbage" })).ok).toBe(true);
	});
});

describe("resolveAuth", () => {
	test("noAuth wins regardless of token / env", () => {
		const auth = resolveAuth({
			noAuth: true,
			token: "ignored",
			env: { BURROW_API_TOKEN: "ignored" },
		});
		expect(auth.authorize(req()).ok).toBe(true);
	});

	test("explicit token beats env", () => {
		const auth = resolveAuth({ token: "explicit", env: { BURROW_API_TOKEN: "from-env" } });
		expect(auth.authorize(req({ authorization: "Bearer explicit" })).ok).toBe(true);
		expect(auth.authorize(req({ authorization: "Bearer from-env" })).ok).toBe(false);
	});

	test("env BURROW_API_TOKEN is consumed when no explicit token", () => {
		const auth = resolveAuth({ env: { BURROW_API_TOKEN: "from-env" } });
		expect(auth.authorize(req({ authorization: "Bearer from-env" })).ok).toBe(true);
	});

	test("missing token + no noAuth → ValidationError with hint", () => {
		expect(() => resolveAuth({ env: {} })).toThrow(ValidationError);
		try {
			resolveAuth({ env: {} });
		} catch (err) {
			if (err instanceof ValidationError) {
				expect(err.recoveryHint).toContain("BURROW_API_TOKEN");
				expect(err.recoveryHint).toContain("--no-auth");
			} else {
				throw err;
			}
		}
	});

	test("empty BURROW_API_TOKEN treated as missing", () => {
		expect(() => resolveAuth({ env: { BURROW_API_TOKEN: "" } })).toThrow(ValidationError);
	});
});
