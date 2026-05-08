import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../core/errors.ts";
import { createLogger } from "../logging/logger.ts";
import { type AuthProvider, bearerAuth, NO_AUTH } from "./auth.ts";
import { jsonResponse } from "./response.ts";
import { startServer } from "./server.ts";
import type { Route, ServeHandle, ServeOptions } from "./types.ts";

const silentLogger = createLogger({ level: "fatal" });

function tcpOpts(extra: { auth?: AuthProvider; routes?: readonly Route[] } = {}): ServeOptions {
	const opts: ServeOptions = {
		transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
		auth: extra.auth ?? NO_AUTH,
		logger: silentLogger,
	};
	if (extra.routes) opts.routes = extra.routes;
	return opts;
}

function tcpUrl(handle: ServeHandle): string {
	if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
	return `http://${handle.transport.hostname}:${handle.transport.port}`;
}

describe("startServer (skeleton)", () => {
	let handle: ServeHandle | null = null;

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
	});

	test("binds an ephemeral port and exposes the resolved url", () => {
		handle = startServer(null, tcpOpts());
		expect(handle.transport.kind).toBe("tcp");
		if (handle.transport.kind === "tcp") {
			expect(handle.transport.port).toBeGreaterThan(0);
			expect(handle.url).toBe(`http://${handle.transport.hostname}:${handle.transport.port}`);
		}
	});

	test("scaffold routes return 501 not_implemented", async () => {
		handle = startServer(null, tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/burrows`);
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_implemented");
	});

	test("/healthz returns 200 ok regardless of state", async () => {
		handle = startServer(null, tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/healthz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	test("unknown path → 404 not_found", async () => {
		handle = startServer(null, tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/nope`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_found");
	});

	test("known path with wrong method → 405 method_not_allowed", async () => {
		handle = startServer(null, tcpOpts());
		const res = await fetch(`${tcpUrl(handle)}/burrows`, { method: "PUT" });
		expect(res.status).toBe(405);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("method_not_allowed");
	});

	test("handler that throws BurrowError → mapped status + envelope", async () => {
		const routes: Route[] = [
			{
				method: "GET",
				pattern: "/boom",
				handler: () => {
					throw new ValidationError("nope");
				},
			},
		];
		handle = startServer(null, tcpOpts({ routes }));
		const res = await fetch(`${tcpUrl(handle)}/boom`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("validation_error");
		expect(body.error.message).toBe("nope");
	});

	test("handler that throws plain Error → 500 internal_error", async () => {
		const routes: Route[] = [
			{
				method: "GET",
				pattern: "/boom",
				handler: () => {
					throw new Error("kaboom");
				},
			},
		];
		handle = startServer(null, tcpOpts({ routes }));
		const res = await fetch(`${tcpUrl(handle)}/boom`);
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("internal_error");
	});

	test("path params are populated on the route context", async () => {
		const seen: { id?: string } = {};
		const routes: Route[] = [
			{
				method: "GET",
				pattern: "/burrows/:id",
				handler: (ctx) => {
					seen.id = ctx.params.id;
					return jsonResponse(200, { id: ctx.params.id });
				},
			},
		];
		handle = startServer(null, tcpOpts({ routes }));
		const res = await fetch(`${tcpUrl(handle)}/burrows/bur_xyz`);
		expect(res.status).toBe(200);
		expect(seen.id).toBe("bur_xyz");
	});

	test("stop() cleanly tears down the listener", async () => {
		const local = startServer(null, tcpOpts());
		const url = tcpUrl(local);
		await local.stop();
		await expect(fetch(url, { signal: AbortSignal.timeout(200) })).rejects.toThrow();
	});
});

describe("startServer (auth)", () => {
	let handle: ServeHandle | null = null;

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
	});

	test("missing Authorization header → 401 with WWW-Authenticate", async () => {
		handle = startServer(null, tcpOpts({ auth: bearerAuth("s3cr3t") }));
		const res = await fetch(`${tcpUrl(handle)}/burrows`);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain("Bearer");
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("unauthorized");
	});

	test("malformed Authorization header → 401 invalid_request", async () => {
		handle = startServer(null, tcpOpts({ auth: bearerAuth("s3cr3t") }));
		const res = await fetch(`${tcpUrl(handle)}/burrows`, {
			headers: { authorization: "Basic abc" },
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain('error="invalid_request"');
	});

	test("wrong bearer token → 401 invalid_token", async () => {
		handle = startServer(null, tcpOpts({ auth: bearerAuth("s3cr3t") }));
		const res = await fetch(`${tcpUrl(handle)}/burrows`, {
			headers: { authorization: "Bearer nope" },
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
	});

	test("valid bearer token → request reaches the handler", async () => {
		handle = startServer(null, tcpOpts({ auth: bearerAuth("s3cr3t") }));
		const res = await fetch(`${tcpUrl(handle)}/burrows`, {
			headers: { authorization: "Bearer s3cr3t" },
		});
		// /burrows under the null-client scaffold is 501, not 401 — auth passed.
		expect(res.status).toBe(501);
	});

	test("/healthz is auth-exempt even when a token is required", async () => {
		handle = startServer(null, tcpOpts({ auth: bearerAuth("s3cr3t") }));
		const res = await fetch(`${tcpUrl(handle)}/healthz`);
		expect(res.status).toBe(200);
	});

	test("unknown paths still require auth (401, not 404)", async () => {
		handle = startServer(null, tcpOpts({ auth: bearerAuth("s3cr3t") }));
		const res = await fetch(`${tcpUrl(handle)}/nope`);
		expect(res.status).toBe(401);
	});
});

describe("startServer (unix transport)", () => {
	let handle: ServeHandle | null = null;
	const sockPath = join(tmpdir(), `burrow-test-${process.pid}-${Date.now()}.sock`);

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
	});

	test("binds a unix socket and serves /healthz", async () => {
		handle = startServer(null, {
			transport: { kind: "unix", path: sockPath },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		expect(handle.transport).toEqual({ kind: "unix", path: sockPath });
		expect(handle.url).toBe(`unix://${sockPath}`);
		expect(existsSync(sockPath)).toBe(true);

		const res = await fetch("http://localhost/healthz", { unix: sockPath });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	test("removes a stale socket file before binding", async () => {
		// Put a leftover file at the path; unix bind should clear and rebind.
		await Bun.write(sockPath, "");
		expect(existsSync(sockPath)).toBe(true);

		handle = startServer(null, {
			transport: { kind: "unix", path: sockPath },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch("http://localhost/healthz", { unix: sockPath });
		expect(res.status).toBe(200);
	});

	test("stop() cleans up the socket inode", async () => {
		const local = startServer(null, {
			transport: { kind: "unix", path: sockPath },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		expect(existsSync(sockPath)).toBe(true);
		await local.stop();
		expect(existsSync(sockPath)).toBe(false);
	});

	test("auth applies over unix transport (loopback ≠ trusted)", async () => {
		handle = startServer(null, {
			transport: { kind: "unix", path: sockPath },
			auth: bearerAuth("s3cr3t"),
			logger: silentLogger,
		});
		const denied = await fetch("http://localhost/burrows", { unix: sockPath });
		expect(denied.status).toBe(401);
		const allowed = await fetch("http://localhost/burrows", {
			unix: sockPath,
			headers: { authorization: "Bearer s3cr3t" },
		});
		expect(allowed.status).toBe(501);
	});
});
