/**
 * Wire-level tests for the sidecars HTTP namespace (R-08, SPEC §8.7).
 * Spawn + forward seams are injected on a per-test `SidecarRegistry` so
 * the assertions cover the route → registry path without bwrap.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Burrow } from "../core/types.ts";
import { Client } from "../lib/client.ts";
import { createLogger } from "../logging/logger.ts";
import type { ForwardHandle } from "../provider/local/inbound-forward.ts";
import type { SandboxProfile, SpawnResult } from "../provider/types.ts";
import { startServer } from "./server.ts";
import { type ForwardStarter, SidecarRegistry, type SidecarSpawnFn } from "./sidecars.ts";
import type { ServeHandle } from "./types.ts";

const silentLogger = createLogger({ level: "fatal" });

function mkTmp(): string {
	return mkdtempSync(join(tmpdir(), "burrow-sc-handlers-"));
}

function seedBurrow(client: Client): Burrow {
	return client.repos.burrows.create({
		kind: "project",
		projectRoot: "/tmp/proj",
		workspacePath: "/tmp/proj/.ws",
		branch: "main",
		provider: "local",
		profile: {
			workspace: "/tmp/proj/.ws",
			readOnlyMounts: [],
			network: "none",
			allowedDomains: [],
			envPassthrough: [],
			setEnv: {},
			toolchainPaths: [],
		} as SandboxProfile,
	});
}

function makeFakeProc(pid: number): { result: SpawnResult; exit: (code: number) => void } {
	let exitResolve!: (code: number) => void;
	const exited = new Promise<number>((res) => {
		exitResolve = res;
	});
	let pushOut: (c: Uint8Array | null) => void = () => {};
	let pushErr: (c: Uint8Array | null) => void = () => {};
	const stdout = new ReadableStream<Uint8Array>({
		start(c) {
			pushOut = (chunk) => {
				if (chunk === null) c.close();
				else c.enqueue(chunk);
			};
		},
	});
	const stderr = new ReadableStream<Uint8Array>({
		start(c) {
			pushErr = (chunk) => {
				if (chunk === null) c.close();
				else c.enqueue(chunk);
			};
		},
	});
	const result: SpawnResult = {
		pid,
		stdout,
		stderr,
		exited,
		cancel: () => {
			pushOut(null);
			pushErr(null);
			exitResolve(143);
		},
	};
	return {
		result,
		exit: (code) => {
			pushOut(null);
			pushErr(null);
			exitResolve(code);
		},
	};
}

function makeFakeForward(): ForwardHandle {
	return {
		hostPort: 32100,
		sandboxPort: 3000,
		hostPortBound: true,
		stop: async () => {},
	};
}

describe("sidecars HTTP handlers", () => {
	let dataDir: string;
	let configDir: string;
	let client: Client;
	let handle: ServeHandle;
	let registry: SidecarRegistry;

	beforeEach(async () => {
		dataDir = mkTmp();
		configDir = mkTmp();
		client = await Client.open({ dataDir, configDir });
		const spawn: SidecarSpawnFn = async () => makeFakeProc(1234).result;
		const startForward: ForwardStarter = async () => makeFakeForward();
		registry = new SidecarRegistry({ client }, { spawn, startForward, cap: 2 });
		handle = startServer(client, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			logger: silentLogger,
			sidecars: registry,
		});
	});

	afterEach(async () => {
		await handle.stop();
		await registry.shutdownAll();
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(configDir, { recursive: true, force: true });
	});

	test("POST /burrows/:id/sidecars creates a sidecar and returns 201", async () => {
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/sidecars`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				command: ["bun", "run", "dev"],
				inboundPortForward: { hostPort: 32100, sandboxPort: 3000 },
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			id: string;
			state: string;
			hostPortBound: boolean;
			inboundPortForward: { hostPort: number; sandboxPort: number } | null;
			pid: number | null;
		};
		expect(body.id.startsWith("sc_")).toBe(true);
		expect(body.state).toBe("live");
		expect(body.hostPortBound).toBe(true);
		expect(body.inboundPortForward).toEqual({ hostPort: 32100, sandboxPort: 3000 });
		expect(body.pid).toBe(1234);
	});

	test("POST /burrows/:id/sidecars rejects empty command (400)", async () => {
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/sidecars`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ command: [] }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});

	test("POST /burrows/:id/sidecars enforces the cap → 409 sidecar_cap_exceeded", async () => {
		const burrow = seedBurrow(client);
		for (let i = 0; i < 2; i++) {
			const ok = await fetch(`${handle.url}/burrows/${burrow.id}/sidecars`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ command: ["a"] }),
			});
			expect(ok.status).toBe(201);
		}
		const over = await fetch(`${handle.url}/burrows/${burrow.id}/sidecars`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ command: ["c"] }),
		});
		expect(over.status).toBe(409);
		const body = (await over.json()) as { error: { code: string } };
		expect(body.error.code).toBe("sidecar_cap_exceeded");
	});

	test("GET /burrows/:id/sidecars returns all sidecars for the burrow", async () => {
		const burrow = seedBurrow(client);
		await fetch(`${handle.url}/burrows/${burrow.id}/sidecars`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ command: ["a"] }),
		});
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/sidecars`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ id: string }>;
		expect(body.length).toBe(1);
	});

	test("GET /burrows/:id/sidecars/:sid returns the sidecar", async () => {
		const burrow = seedBurrow(client);
		const created = await fetch(`${handle.url}/burrows/${burrow.id}/sidecars`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ command: ["a"] }),
		});
		const { id } = (await created.json()) as { id: string };
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/sidecars/${id}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string };
		expect(body.id).toBe(id);
	});

	test("DELETE /burrows/:id/sidecars/:sid → 204 and state torn-down", async () => {
		const burrow = seedBurrow(client);
		const created = await fetch(`${handle.url}/burrows/${burrow.id}/sidecars`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ command: ["a"] }),
		});
		const { id } = (await created.json()) as { id: string };
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/sidecars/${id}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(204);
		const after = await fetch(`${handle.url}/burrows/${burrow.id}/sidecars/${id}`);
		const body = (await after.json()) as { state: string };
		expect(body.state).toBe("torn-down");
	});

	test("GET /burrows/:id/sidecars/:sid/logs returns the captured buffers", async () => {
		const burrow = seedBurrow(client);
		const created = await fetch(`${handle.url}/burrows/${burrow.id}/sidecars`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ command: ["a"] }),
		});
		const { id } = (await created.json()) as { id: string };
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/sidecars/${id}/logs`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { stdout: string; stderr: string };
		expect(typeof body.stdout).toBe("string");
		expect(typeof body.stderr).toBe("string");
	});

	test("GET /burrows/:id/sidecars/:sid → 404 for unknown sidecar", async () => {
		const burrow = seedBurrow(client);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}/sidecars/sc_unknown`);
		expect(res.status).toBe(404);
	});

	test("when sidecars are not enabled, the namespace 404s with a hint", async () => {
		const noSidecarHandle = startServer(client, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			logger: silentLogger,
		});
		try {
			const burrow = seedBurrow(client);
			const res = await fetch(`${noSidecarHandle.url}/burrows/${burrow.id}/sidecars`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ command: ["bun"] }),
			});
			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: { hint?: string } };
			expect(body.error.hint).toContain("library-mode embeds");
		} finally {
			await noSidecarHandle.stop();
		}
	});

	test("DELETE /burrows/:id cascade-tears-down every sidecar before destroying the row", async () => {
		const burrow = seedBurrow(client);
		await fetch(`${handle.url}/burrows/${burrow.id}/sidecars`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ command: ["a"] }),
		});
		await fetch(`${handle.url}/burrows/${burrow.id}/sidecars`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ command: ["b"] }),
		});
		expect(registry.list(burrow.id).length).toBe(2);
		const res = await fetch(`${handle.url}/burrows/${burrow.id}?archive=false`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
		expect(registry.list(burrow.id).length).toBe(0);
	});
});
