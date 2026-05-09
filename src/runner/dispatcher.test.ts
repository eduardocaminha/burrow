/**
 * `RunDispatcher` integration tests — exercises the wiring that closes
 * `burrow-7b97`: HTTP-enqueued runs (the `client.runs.create` path) flow
 * into the in-process executor instead of sitting at `state=queued`
 * forever.
 *
 * Tests stub spawn + installCheck so they don't shell out to the host.
 * Real Client + repos so the queue / claim / finalize transitions are
 * exercised against actual SQLite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BurrowRow } from "../db/schema.ts";
import { Client } from "../lib/client.ts";
import { createLogger } from "../logging/logger.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../provider/types.ts";
import type { AgentRuntime } from "../runtime/runtime.ts";
import type { SpawnFn } from "./dispatch.ts";
import { startRunDispatcher } from "./dispatcher.ts";

const silentLogger = createLogger({ level: "fatal" });

interface CollectedSpawn {
	profile: SandboxProfile;
	command: SpawnCommand;
}

interface FakeSpawnOpts {
	stdoutLines?: string[];
	exitCode?: number;
	calls?: CollectedSpawn[];
}

function fakeSpawn(opts: FakeSpawnOpts = {}): SpawnFn {
	return async (profile, command) => {
		opts.calls?.push({ profile, command });
		const encoder = new TextEncoder();
		const blob = (opts.stdoutLines ?? []).map((l) => `${l}\n`).join("");
		const stdout = new ReadableStream<Uint8Array>({
			start(controller) {
				if (blob.length > 0) controller.enqueue(encoder.encode(blob));
				controller.close();
			},
		});
		const stderr = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
		let resolveExit!: (n: number) => void;
		const exited = new Promise<number>((r) => {
			resolveExit = r;
		});
		const result: SpawnResult = {
			pid: 1234,
			stdout,
			stderr,
			exited,
			cancel: () => resolveExit(130),
		};
		queueMicrotask(() => resolveExit(opts.exitCode ?? 0));
		return result;
	};
}

function fakeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
	return {
		id: "fake",
		displayName: "Fake",
		supportsResume: false,
		buildSpawnCommand: () => ({ argv: ["fake"] }),
		parseEvents: (line) => [{ kind: "text", stream: "stdout", payload: { text: line } }],
		installCheck: async () => ({ installed: true }),
		...overrides,
	};
}

function seedActiveBurrow(client: Client): BurrowRow {
	const profile: SandboxProfile = {
		workspace: "/ws",
		readOnlyMounts: [],
		network: "none",
		allowedDomains: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: [],
	};
	return client.repos.burrows.create({
		kind: "project",
		projectRoot: "/repo",
		workspacePath: "/ws",
		branch: "main",
		provider: "local",
		profile,
	});
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("waitFor timed out");
		}
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe("startRunDispatcher", () => {
	let dataDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-dispatcher-"));
		client = await Client.open({ dataDir, configDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("client.runs.create after start() drives the run to terminal", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ stdoutLines: ["hello"] }),
		});
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "fake",
			prompt: "p",
		});

		// Synchronously after create the loop has only just been notified;
		// the row is still queued. Wait for the loop to transition it.
		await waitFor(() => client.runs.get(run.id).state === "succeeded");
		await dispatcher.stop();

		const finalized = client.runs.get(run.id);
		expect(finalized.state).toBe("succeeded");
		expect(finalized.exitCode).toBe(0);
		expect(finalized.startedAt).not.toBeNull();
		expect(finalized.completedAt).not.toBeNull();
	});

	test("startup recovery sweeps stale running rows from a prior process", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());

		// Simulate a crashed previous process: enqueue then mark running
		// without finalizing.
		const stuck = client.repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "fake",
			prompt: "stuck",
		});
		client.repos.runs.markRunning(stuck.id);
		expect(client.repos.runs.require(stuck.id).state).toBe("running");

		const dispatcher = startRunDispatcher(client, { logger: silentLogger, spawn: fakeSpawn() });
		const { recovered } = dispatcher.start();
		await dispatcher.stop();

		expect(recovered.failedRunIds).toEqual([stuck.id]);
		expect(client.repos.runs.require(stuck.id).state).toBe("failed");
	});

	test("queued rows already in the DB at start() are picked up", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());

		// Pre-existing queued run (e.g. enqueued by an earlier process or
		// by the library directly before the dispatcher was wired).
		const pre = client.repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "fake",
			prompt: "pre",
		});
		expect(client.repos.runs.require(pre.id).state).toBe("queued");

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ stdoutLines: ["ok"] }),
		});
		dispatcher.start();
		await waitFor(() => client.runs.get(pre.id).state === "succeeded");
		await dispatcher.stop();

		expect(client.runs.get(pre.id).state).toBe("succeeded");
	});

	test("stop() unhooks the create callback so library callers don't dangle", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());

		const dispatcher = startRunDispatcher(client, { logger: silentLogger, spawn: fakeSpawn() });
		dispatcher.start();
		await dispatcher.stop();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "fake",
			prompt: "after-stop",
		});
		// Loop is stopped — row should stay queued.
		await new Promise((r) => setTimeout(r, 30));
		expect(client.runs.get(run.id).state).toBe("queued");
	});

	test("agent not registered → run finalizes failed with a clear error", async () => {
		const burrow = seedActiveBurrow(client);
		// Note: agent NOT registered.

		const dispatcher = startRunDispatcher(client, { logger: silentLogger, spawn: fakeSpawn() });
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "ghost",
			prompt: "p",
		});
		await waitFor(() => client.runs.get(run.id).state === "failed");
		await dispatcher.stop();

		const finalized = client.runs.get(run.id);
		expect(finalized.state).toBe("failed");
		expect(finalized.errorMessage).toContain("ghost");
		expect(finalized.errorMessage).toContain("not registered");
	});

	test("stopped burrow → enqueued run finalizes failed without spawning", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());
		client.repos.burrows.markStopped(burrow.id);

		const calls: CollectedSpawn[] = [];
		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ calls }),
		});
		dispatcher.start();

		const run = client.runs.create({
			burrowId: burrow.id,
			agentId: "fake",
			prompt: "p",
		});
		await waitFor(() => client.runs.get(run.id).state === "failed");
		await dispatcher.stop();

		expect(calls).toHaveLength(0);
		expect(client.runs.get(run.id).errorMessage).toContain("stopped");
	});

	test("isIdle is true once all enqueued runs have finalized", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());

		const dispatcher = startRunDispatcher(client, {
			logger: silentLogger,
			spawn: fakeSpawn({ stdoutLines: ["ok"] }),
		});
		dispatcher.start();

		client.runs.create({ burrowId: burrow.id, agentId: "fake", prompt: "1" });
		client.runs.create({ burrowId: burrow.id, agentId: "fake", prompt: "2" });

		await waitFor(() => dispatcher.isIdle());
		await dispatcher.stop();
	});
});
