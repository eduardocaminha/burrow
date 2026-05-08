import { afterEach, describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { createLogger } from "../logging/logger.ts";
import { jsonResponse } from "./response.ts";
import { startServer } from "./server.ts";
import type { Route, ServeHandle } from "./types.ts";

const silentLogger = createLogger({ level: "fatal" });

describe("startServer (skeleton)", () => {
	let handle: ServeHandle | null = null;

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
	});

	test("binds an ephemeral port and exposes the resolved url", () => {
		handle = startServer(null, { port: 0, logger: silentLogger });
		expect(handle.port).toBeGreaterThan(0);
		expect(handle.url).toBe(`http://${handle.hostname}:${handle.port}`);
	});

	test("scaffold routes return 501 not_implemented", async () => {
		handle = startServer(null, { port: 0, logger: silentLogger });
		const res = await fetch(`${handle.url}/burrows`);
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_implemented");
	});

	test("/healthz returns 200 ok regardless of state", async () => {
		handle = startServer(null, { port: 0, logger: silentLogger });
		const res = await fetch(`${handle.url}/healthz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	test("unknown path → 404 not_found", async () => {
		handle = startServer(null, { port: 0, logger: silentLogger });
		const res = await fetch(`${handle.url}/nope`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_found");
	});

	test("known path with wrong method → 405 method_not_allowed", async () => {
		handle = startServer(null, { port: 0, logger: silentLogger });
		const res = await fetch(`${handle.url}/burrows`, { method: "PUT" });
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
		handle = startServer(null, { port: 0, routes, logger: silentLogger });
		const res = await fetch(`${handle.url}/boom`);
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
		handle = startServer(null, { port: 0, routes, logger: silentLogger });
		const res = await fetch(`${handle.url}/boom`);
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
		handle = startServer(null, { port: 0, routes, logger: silentLogger });
		const res = await fetch(`${handle.url}/burrows/bur_xyz`);
		expect(res.status).toBe(200);
		expect(seen.id).toBe("bur_xyz");
	});

	test("stop() cleanly tears down the listener", async () => {
		const local = startServer(null, { port: 0, logger: silentLogger });
		const url = local.url;
		await local.stop();
		await expect(fetch(url, { signal: AbortSignal.timeout(200) })).rejects.toThrow();
	});
});
