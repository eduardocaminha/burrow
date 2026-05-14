/**
 * Sidecar registry tests (SPEC §8.7, R-08). The spawn + forward seams are
 * injected so we exercise the lifecycle state machine, cap enforcement,
 * and cascade-on-delete invariant without launching real bwrap children.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import type { Burrow } from "../core/types.ts";
import { Client } from "../lib/client.ts";
import type { ForwardHandle } from "../provider/local/inbound-forward.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../provider/types.ts";
import {
	type ForwardStarter,
	SidecarCapExceededError,
	SidecarRegistry,
	type SidecarSpawnFn,
} from "./sidecars.ts";

function mkTmp(): string {
	return mkdtempSync(join(tmpdir(), "burrow-sidecars-"));
}

interface FakeProc {
	result: SpawnResult;
	exit: (code: number) => void;
	pushStdout: (chunk: Uint8Array) => void;
	pushStderr: (chunk: Uint8Array) => void;
	cancelled: () => boolean;
}

function makeFakeProc(pid: number): FakeProc {
	let exitResolve!: (code: number) => void;
	const exited = new Promise<number>((res) => {
		exitResolve = res;
	});
	let pushStdout: (c: Uint8Array | null) => void = () => {};
	let pushStderr: (c: Uint8Array | null) => void = () => {};
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			pushStdout = (chunk) => {
				if (chunk === null) controller.close();
				else controller.enqueue(chunk);
			};
		},
	});
	const stderr = new ReadableStream<Uint8Array>({
		start(controller) {
			pushStderr = (chunk) => {
				if (chunk === null) controller.close();
				else controller.enqueue(chunk);
			};
		},
	});
	let cancelled = false;
	const result: SpawnResult = {
		pid,
		stdout,
		stderr,
		exited,
		cancel: () => {
			cancelled = true;
			pushStdout(null);
			pushStderr(null);
			exitResolve(143);
		},
	};
	return {
		result,
		exit: (code) => {
			pushStdout(null);
			pushStderr(null);
			exitResolve(code);
		},
		pushStdout: (chunk) => pushStdout(chunk),
		pushStderr: (chunk) => pushStderr(chunk),
		cancelled: () => cancelled,
	};
}

function makeFakeForward(): { handle: ForwardHandle; stopped: () => boolean } {
	let stopped = false;
	const handle: ForwardHandle = {
		hostPort: 32100,
		sandboxPort: 3000,
		hostPortBound: true,
		stop: async () => {
			stopped = true;
		},
	};
	return { handle, stopped: () => stopped };
}

function seedBurrow(client: Client, profile?: Partial<SandboxProfile>): Burrow {
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
			...profile,
		},
	});
}

describe("SidecarRegistry", () => {
	let dataDir: string;
	let configDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkTmp();
		configDir = mkTmp();
		client = await Client.open({ dataDir, configDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(configDir, { recursive: true, force: true });
	});

	test("create() spawns with the burrow's profile and reports live state", async () => {
		const burrow = seedBurrow(client);
		const fake = makeFakeProc(1234);
		const profiles: SandboxProfile[] = [];
		const commands: SpawnCommand[] = [];
		const spawn: SidecarSpawnFn = async (profile, command) => {
			profiles.push(profile);
			commands.push(command);
			return fake.result;
		};
		const registry = new SidecarRegistry({ client }, { spawn });

		const record = await registry.create({
			burrowId: burrow.id,
			command: ["bun", "run", "dev"],
		});

		expect(record.state).toBe("live");
		expect(record.pid).toBe(1234);
		expect(record.hostPortBound).toBe(false);
		expect(record.inboundPortForward).toBe(null);
		expect(commands[0]?.argv).toEqual(["bun", "run", "dev"]);
		expect(profiles[0]?.workspace).toBe("/tmp/proj/.ws");
	});

	test("create() with inboundPortForward starts the forward and reports host_port_bound", async () => {
		const burrow = seedBurrow(client);
		const fake = makeFakeProc(4242);
		const spawn: SidecarSpawnFn = async () => fake.result;
		const fakeForward = makeFakeForward();
		const startForward: ForwardStarter = async (spec) => {
			expect(spec.hostPort).toBe(32100);
			expect(spec.sandboxPort).toBe(3000);
			expect(spec.sandboxPid).toBe(4242);
			return fakeForward.handle;
		};
		const registry = new SidecarRegistry({ client }, { spawn, startForward });

		const record = await registry.create({
			burrowId: burrow.id,
			command: ["bun", "run", "dev"],
			inboundPortForward: { hostPort: 32100, sandboxPort: 3000 },
		});

		expect(record.hostPortBound).toBe(true);
		expect(record.inboundPortForward).toEqual({ hostPort: 32100, sandboxPort: 3000 });
	});

	test("spawn failure surfaces as state=failed without throwing", async () => {
		const burrow = seedBurrow(client);
		const spawn: SidecarSpawnFn = async () => {
			throw new Error("bwrap: cannot start");
		};
		const registry = new SidecarRegistry({ client }, { spawn });

		const record = await registry.create({
			burrowId: burrow.id,
			command: ["bun", "run", "dev"],
		});

		expect(record.state).toBe("failed");
		expect(record.message).toBe("bwrap: cannot start");
		expect(record.pid).toBe(null);
	});

	test("per-burrow cap enforced (default 4)", async () => {
		const burrow = seedBurrow(client);
		const spawn: SidecarSpawnFn = async () => makeFakeProc(1).result;
		const registry = new SidecarRegistry({ client }, { spawn, cap: 2 });

		await registry.create({ burrowId: burrow.id, command: ["a"] });
		await registry.create({ burrowId: burrow.id, command: ["b"] });
		await expect(registry.create({ burrowId: burrow.id, command: ["c"] })).rejects.toBeInstanceOf(
			SidecarCapExceededError,
		);
	});

	test("an exited sidecar releases its cap slot", async () => {
		const burrow = seedBurrow(client);
		const procs: FakeProc[] = [];
		const spawn: SidecarSpawnFn = async () => {
			const fake = makeFakeProc(procs.length + 1);
			procs.push(fake);
			return fake.result;
		};
		const registry = new SidecarRegistry({ client }, { spawn, cap: 1 });

		const first = await registry.create({ burrowId: burrow.id, command: ["a"] });
		expect(first.state).toBe("live");
		procs[0]?.exit(0);
		// Wait for the exit promise to be processed.
		await new Promise((r) => setTimeout(r, 5));
		expect(registry.get(burrow.id, first.id).state).toBe("exited");
		// Slot freed — second create works.
		const second = await registry.create({ burrowId: burrow.id, command: ["b"] });
		expect(second.state).toBe("live");
	});

	test("get() / list() / logs() throw NotFoundError for unknown ids", async () => {
		const burrow = seedBurrow(client);
		const registry = new SidecarRegistry({ client }, { spawn: async () => makeFakeProc(1).result });
		expect(() => registry.get(burrow.id, "sc_nope")).toThrow(NotFoundError);
		expect(() => registry.logs(burrow.id, "sc_nope")).toThrow(NotFoundError);
		expect(registry.list(burrow.id)).toEqual([]);
	});

	test("logs() captures stdout/stderr writes", async () => {
		const burrow = seedBurrow(client);
		const fake = makeFakeProc(99);
		const registry = new SidecarRegistry({ client }, { spawn: async () => fake.result });

		const sc = await registry.create({ burrowId: burrow.id, command: ["a"] });
		fake.pushStdout(new TextEncoder().encode("hello\n"));
		fake.pushStderr(new TextEncoder().encode("err\n"));
		// Yield so the stream pumps flush into the ring buffer.
		await new Promise((r) => setTimeout(r, 5));
		const logs = registry.logs(burrow.id, sc.id);
		expect(logs.stdout).toBe("hello\n");
		expect(logs.stderr).toBe("err\n");
	});

	test("delete() transitions to torn-down, cancels the process, stops the forward", async () => {
		const burrow = seedBurrow(client);
		const fake = makeFakeProc(1);
		const fakeForward = makeFakeForward();
		const registry = new SidecarRegistry(
			{ client },
			{ spawn: async () => fake.result, startForward: async () => fakeForward.handle },
		);

		const sc = await registry.create({
			burrowId: burrow.id,
			command: ["a"],
			inboundPortForward: { hostPort: 32100, sandboxPort: 3000 },
		});
		await registry.delete(burrow.id, sc.id);
		expect(registry.get(burrow.id, sc.id).state).toBe("torn-down");
		expect(fake.cancelled()).toBe(true);
		expect(fakeForward.stopped()).toBe(true);
	});

	test("cascadeDeleteBurrow tears down every sidecar", async () => {
		const burrow = seedBurrow(client);
		const procs: FakeProc[] = [];
		const spawn: SidecarSpawnFn = async () => {
			const fake = makeFakeProc(procs.length + 1);
			procs.push(fake);
			return fake.result;
		};
		const registry = new SidecarRegistry({ client }, { spawn });

		await registry.create({ burrowId: burrow.id, command: ["a"] });
		await registry.create({ burrowId: burrow.id, command: ["b"] });
		expect(registry.list(burrow.id).length).toBe(2);

		await registry.cascadeDeleteBurrow(burrow.id);
		expect(registry.list(burrow.id).length).toBe(0);
		for (const p of procs) expect(p.cancelled()).toBe(true);
	});

	test("create() validates command shape", async () => {
		const burrow = seedBurrow(client);
		const registry = new SidecarRegistry({ client }, { spawn: async () => makeFakeProc(1).result });
		await expect(registry.create({ burrowId: burrow.id, command: [] })).rejects.toBeInstanceOf(
			ValidationError,
		);
		await expect(
			registry.create({
				burrowId: burrow.id,
				command: ["bun", ""] as unknown as string[],
			}),
		).rejects.toBeInstanceOf(ValidationError);
	});

	test("create() rejects non-active burrow", async () => {
		const burrow = seedBurrow(client);
		client.repos.burrows.markStopped(burrow.id);
		const registry = new SidecarRegistry({ client }, { spawn: async () => makeFakeProc(1).result });
		await expect(registry.create({ burrowId: burrow.id, command: ["bun"] })).rejects.toBeInstanceOf(
			ValidationError,
		);
	});

	test("forward augments the burrow's profile.inboundPortForwards passed to spawn", async () => {
		const burrow = seedBurrow(client);
		const profiles: SandboxProfile[] = [];
		const spawn: SidecarSpawnFn = async (profile) => {
			profiles.push(profile);
			return makeFakeProc(1).result;
		};
		const registry = new SidecarRegistry(
			{ client },
			{
				spawn,
				startForward: async () => makeFakeForward().handle,
			},
		);

		await registry.create({
			burrowId: burrow.id,
			command: ["a"],
			inboundPortForward: { hostPort: 32100, sandboxPort: 3000 },
		});
		expect(profiles[0]?.inboundPortForwards).toEqual([{ hostPort: 32100, sandboxPort: 3000 }]);
	});
});
