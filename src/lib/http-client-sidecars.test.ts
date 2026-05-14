/**
 * HttpClient.sidecars wire-shape parity tests (R-08, SPEC §8.7). The
 * sidecar registry needs explicit wiring on the server side (it's not a
 * Client surface), so this file lives alongside the general HttpClient
 * round-trip suite but boots its own server with `sidecars:` injected.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import type { Burrow } from "../core/types.ts";
import { Client } from "../lib/client.ts";
import { createLogger } from "../logging/logger.ts";
import type { ForwardHandle } from "../provider/local/inbound-forward.ts";
import type { SandboxProfile, SpawnResult } from "../provider/types.ts";
import { startServer } from "../server/server.ts";
import { type ForwardStarter, SidecarRegistry, type SidecarSpawnFn } from "../server/sidecars.ts";
import type { ServeHandle } from "../server/types.ts";
import { HttpClient, HttpClientError } from "./http-client.ts";

const silentLogger = createLogger({ level: "fatal" });

function mkTmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
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

function makeFakeProc(pid: number): SpawnResult {
	let exitResolve!: (code: number) => void;
	const exited = new Promise<number>((res) => {
		exitResolve = res;
	});
	const stdout = new ReadableStream<Uint8Array>({ start() {} });
	const stderr = new ReadableStream<Uint8Array>({ start() {} });
	return {
		pid,
		stdout,
		stderr,
		exited,
		cancel: () => exitResolve(143),
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

describe("HttpClient.sidecars", () => {
	let dataDir: string;
	let configDir: string;
	let client: Client;
	let handle: ServeHandle;
	let http: HttpClient;
	let registry: SidecarRegistry;

	beforeEach(async () => {
		dataDir = mkTmp("burrow-http-sc-");
		configDir = mkTmp("burrow-http-sc-cfg-");
		client = await Client.open({ dataDir, configDir });
		const spawn: SidecarSpawnFn = async () => makeFakeProc(1234);
		const startForward: ForwardStarter = async () => makeFakeForward();
		registry = new SidecarRegistry({ client }, { spawn, startForward, cap: 2 });

		handle = startServer(client, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			logger: silentLogger,
			sidecars: registry,
		});
		if (handle.transport.kind !== "tcp") throw new Error("expected tcp transport");
		http = new HttpClient({ transport: handle.transport });
	});

	afterEach(async () => {
		await http.close();
		await handle.stop();
		await registry.shutdownAll();
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(configDir, { recursive: true, force: true });
	});

	test("create round-trips with rehydrated startedAt", async () => {
		const burrow = seedBurrow(client);
		const sc = await http.sidecars.create({
			burrowId: burrow.id,
			command: ["bun", "run", "dev"],
			inboundPortForward: { hostPort: 32100, sandboxPort: 3000 },
		});
		expect(sc.state).toBe("live");
		expect(sc.startedAt).toBeInstanceOf(Date);
		expect(sc.hostPortBound).toBe(true);
		expect(sc.inboundPortForward).toEqual({ hostPort: 32100, sandboxPort: 3000 });
	});

	test("list/get returns wire-compatible records", async () => {
		const burrow = seedBurrow(client);
		const created = await http.sidecars.create({ burrowId: burrow.id, command: ["a"] });
		const list = await http.sidecars.list(burrow.id);
		expect(list.length).toBe(1);
		const got = await http.sidecars.get(burrow.id, created.id);
		expect(got.id).toBe(created.id);
	});

	test("get throws NotFoundError for unknown sidecar", async () => {
		const burrow = seedBurrow(client);
		await expect(http.sidecars.get(burrow.id, "sc_nope")).rejects.toBeInstanceOf(NotFoundError);
	});

	test("delete transitions to torn-down and returns void", async () => {
		const burrow = seedBurrow(client);
		const sc = await http.sidecars.create({ burrowId: burrow.id, command: ["a"] });
		await http.sidecars.delete(burrow.id, sc.id);
		const after = await http.sidecars.get(burrow.id, sc.id);
		expect(after.state).toBe("torn-down");
	});

	test("cap exceeded rehydrates as HttpClientError with sidecar_cap_exceeded code", async () => {
		const burrow = seedBurrow(client);
		await http.sidecars.create({ burrowId: burrow.id, command: ["a"] });
		await http.sidecars.create({ burrowId: burrow.id, command: ["b"] });
		try {
			await http.sidecars.create({ burrowId: burrow.id, command: ["c"] });
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(HttpClientError);
			expect((err as HttpClientError).code).toBe("sidecar_cap_exceeded");
			expect((err as HttpClientError).status).toBe(409);
		}
	});

	test("validation_error rehydrates as ValidationError", async () => {
		const burrow = seedBurrow(client);
		await expect(http.sidecars.create({ burrowId: burrow.id, command: [] })).rejects.toBeInstanceOf(
			ValidationError,
		);
	});

	test("logs returns stdout/stderr strings", async () => {
		const burrow = seedBurrow(client);
		const sc = await http.sidecars.create({ burrowId: burrow.id, command: ["a"] });
		const logs = await http.sidecars.logs(burrow.id, sc.id);
		expect(typeof logs.stdout).toBe("string");
		expect(typeof logs.stderr).toBe("string");
	});
});
