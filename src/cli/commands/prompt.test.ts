import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { AgentNotInstalled, ValidationError } from "../../core/errors.ts";
import type { BurrowRow } from "../../db/schema.ts";
import { Client } from "../../lib/client.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../../provider/types.ts";
import type { ProxyHandle, StartProxyOptions } from "../../proxy/server.ts";
import type { AgentRuntime } from "../../runtime/runtime.ts";
import {
	type PromptCommandInput,
	parseMetadataPairs,
	renderPromptResult,
	runPromptCommand,
	type SpawnFn,
	type StartProxyFn,
} from "./prompt.ts";

interface CollectedSpawn {
	profile: SandboxProfile;
	command: SpawnCommand;
}

interface FakeSpawnOptions {
	stdoutLines?: string[];
	stderrLines?: string[];
	exitCode?: number;
	calls?: CollectedSpawn[];
	cancelHook?: () => void;
}

function fakeSpawn(opts: FakeSpawnOptions = {}): SpawnFn {
	return async (profile, command) => {
		opts.calls?.push({ profile, command });
		const stdout = encodeStream(opts.stdoutLines ?? []);
		const stderr = encodeStream(opts.stderrLines ?? []);
		let resolveExit!: (n: number) => void;
		const exited = new Promise<number>((r) => {
			resolveExit = r;
		});
		const result: SpawnResult = {
			pid: 1234,
			stdout,
			stderr,
			exited,
			cancel: () => {
				opts.cancelHook?.();
				resolveExit(130);
			},
		};
		// Resolve the exit promise on the next microtask so streams have a
		// chance to deliver their queued chunks before we tear down.
		queueMicrotask(() => resolveExit(opts.exitCode ?? 0));
		return result;
	};
}

function encodeStream(lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const blob = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (blob.length > 0) controller.enqueue(encoder.encode(blob));
			controller.close();
		},
	});
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

function collectStdout(): { stream: NodeJS.WritableStream; lines: () => string[] } {
	const chunks: Buffer[] = [];
	const stream = new Writable({
		write(chunk, _enc, cb) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			cb();
		},
	});
	return {
		stream,
		lines: () =>
			Buffer.concat(chunks)
				.toString("utf8")
				.split("\n")
				.filter((l) => l.length > 0),
	};
}

function seedActiveBurrow(client: Client, profile: Partial<SandboxProfile> = {}): BurrowRow {
	const fullProfile: SandboxProfile = {
		workspace: "/ws",
		readOnlyMounts: [],
		network: "none",
		allowedDomains: [],
		envPassthrough: [],
		setEnv: { FOO: "bar" },
		toolchainPaths: [],
		...profile,
	};
	return client.repos.burrows.create({
		kind: "project",
		projectRoot: "/repo",
		workspacePath: "/ws",
		branch: "main",
		provider: "local",
		profile: fullProfile,
	});
}

describe("parseMetadataPairs", () => {
	test("parses k=v pairs", () => {
		expect(parseMetadataPairs(["a=1", "b=two"])).toEqual({ a: "1", b: "two" });
	});

	test("rejects malformed pairs", () => {
		expect(() => parseMetadataPairs(["bad"])).toThrow(ValidationError);
		expect(() => parseMetadataPairs(["=value"])).toThrow(ValidationError);
	});

	test("returns an empty record when no pairs are passed", () => {
		expect(parseMetadataPairs(undefined)).toEqual({});
	});
});

describe("runPromptCommand", () => {
	let dataDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-prompt-"));
		client = await Client.open({ dataDir, configDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("creates a run, persists parsed events, finalizes succeeded", async () => {
		const burrow = seedActiveBurrow(client);
		const runtime = fakeRuntime();
		client.agents.register(runtime);
		const calls: CollectedSpawn[] = [];
		const out = collectStdout();

		const input: PromptCommandInput = {
			client,
			burrowId: burrow.id,
			prompt: "ship it",
			options: { agent: "fake", json: true },
			stdout: out.stream,
			isTty: false,
			spawn: fakeSpawn({ stdoutLines: ["hello", "world"], calls }),
		};
		const result = await runPromptCommand(input);

		expect(result.state).toBe("succeeded");
		expect(result.exitCode).toBe(0);
		expect(result.eventsPersisted).toBe(2);
		expect(result.agentId).toBe("fake");

		const persisted = client.repos.events.listByBurrow(burrow.id);
		expect(persisted).toHaveLength(2);
		expect(persisted.map((e) => e.runId)).toEqual([result.run.id, result.run.id]);
		expect((persisted[0]?.payloadJson as { text: string }).text).toBe("hello");

		const lines = out.lines();
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0] ?? "{}");
		expect(first.kind).toBe("text");
		expect(first.runId).toBe(result.run.id);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.profile.setEnv).toEqual({ FOO: "bar" });
	});

	test("non-zero exit finalizes failed and surfaces the exit code", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());
		const out = collectStdout();

		const result = await runPromptCommand({
			client,
			burrowId: burrow.id,
			prompt: "p",
			options: { agent: "fake", json: true },
			stdout: out.stream,
			isTty: false,
			spawn: fakeSpawn({ stdoutLines: ["boom"], exitCode: 2 }),
		});

		expect(result.state).toBe("failed");
		expect(result.exitCode).toBe(2);
		const stored = client.runs.get(result.run.id);
		expect(stored.state).toBe("failed");
		expect(stored.errorMessage).toContain("exited with code 2");
	});

	test("refuses to dispatch against a stopped burrow", async () => {
		const burrow = seedActiveBurrow(client);
		client.burrows.stop(burrow.id);
		client.agents.register(fakeRuntime());

		await expect(
			runPromptCommand({
				client,
				burrowId: burrow.id,
				prompt: "p",
				options: { agent: "fake" },
				stdout: collectStdout().stream,
				isTty: false,
				spawn: fakeSpawn(),
			}),
		).rejects.toThrow(ValidationError);
	});

	test("install-check failure throws AgentNotInstalled with the runtime's hint", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(
			fakeRuntime({
				id: "needs-install",
				installCheck: async () => ({ installed: false, hint: "brew install fake" }),
			}),
		);

		const err = await runPromptCommand({
			client,
			burrowId: burrow.id,
			prompt: "p",
			options: { agent: "needs-install" },
			stdout: collectStdout().stream,
			isTty: false,
			spawn: fakeSpawn(),
		}).then(
			() => null,
			(e: unknown) => e,
		);

		expect(err).toBeInstanceOf(AgentNotInstalled);
		expect((err as AgentNotInstalled).recoveryHint).toBe("brew install fake");
		// Must not have created a run row when the install check rejects.
		expect(client.runs.list({ burrowId: burrow.id })).toHaveLength(0);
	});

	test("picks the default agent from burrow.toml [[agents]] when --agent is omitted", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime({ id: "claude-code" }));

		const tomlSource = join(dataDir, "burrow.toml");
		writeFileSync(tomlSource, `[project]\nname = "p"\n\n[[agents]]\nid = "claude-code"\n`, "utf8");

		const result = await runPromptCommand({
			client,
			burrowId: burrow.id,
			prompt: "p",
			options: {},
			stdout: collectStdout().stream,
			isTty: false,
			spawn: fakeSpawn({ stdoutLines: ["ok"] }),
			burrowTomlLoader: async () => ({
				source: tomlSource,
				config: { agents: [{ id: "claude-code" }] },
			}),
		});
		expect(result.agentId).toBe("claude-code");
	});

	test("rejects when no --agent and burrow.toml has no [[agents]]", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());

		await expect(
			runPromptCommand({
				client,
				burrowId: burrow.id,
				prompt: "p",
				options: {},
				stdout: collectStdout().stream,
				isTty: false,
				spawn: fakeSpawn(),
				burrowTomlLoader: async () => null,
			}),
		).rejects.toThrow(/no default agent/);
	});

	test("delivers pending steering messages to the runtime via SpawnContext", async () => {
		const burrow = seedActiveBurrow(client);
		client.inbox.send({ burrowId: burrow.id, body: "first", priority: "urgent" });
		client.inbox.send({ burrowId: burrow.id, body: "second", priority: "normal" });
		const observed: { ids: string[] } = { ids: [] };
		client.agents.register(
			fakeRuntime({
				id: "drinks-inbox",
				buildSpawnCommand: (ctx) => {
					observed.ids = ctx.pendingMessages.map((m) => m.id);
					return { argv: ["fake"] };
				},
			}),
		);

		const result = await runPromptCommand({
			client,
			burrowId: burrow.id,
			prompt: "p",
			options: { agent: "drinks-inbox" },
			stdout: collectStdout().stream,
			isTty: false,
			spawn: fakeSpawn({ stdoutLines: ["ok"] }),
		});

		expect(result.messagesDelivered).toBe(2);
		expect(observed.ids).toHaveLength(2);
		const stored = client.inbox.list(burrow.id);
		for (const m of stored) {
			expect(m.state).toBe("delivered");
			expect(m.deliveredAtRunId).toBe(result.run.id);
		}
	});

	test("captures stderr lines as stderr-stream events", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());

		const result = await runPromptCommand({
			client,
			burrowId: burrow.id,
			prompt: "p",
			options: { agent: "fake", noStream: true },
			stdout: collectStdout().stream,
			isTty: false,
			spawn: fakeSpawn({ stderrLines: ["warn: thing"] }),
		});

		const events = client.repos.events.listByBurrow(burrow.id);
		const stderrs = events.filter((e) => e.stream === "stderr");
		expect(stderrs).toHaveLength(1);
		expect((stderrs[0]?.payloadJson as { line: string }).line).toBe("warn: thing");
		expect(result.eventsPersisted).toBe(1);
	});

	test("noStream suppresses stdout writes but still persists events", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());
		const out = collectStdout();

		const result = await runPromptCommand({
			client,
			burrowId: burrow.id,
			prompt: "p",
			options: { agent: "fake", noStream: true, json: true },
			stdout: out.stream,
			isTty: false,
			spawn: fakeSpawn({ stdoutLines: ["one"] }),
		});

		expect(result.eventsPersisted).toBe(1);
		expect(out.lines()).toEqual([]);
	});

	test("network=restricted starts a proxy, injects HTTP_PROXY, sets proxyAddress, stops on exit", async () => {
		const burrow = seedActiveBurrow(client, {
			network: "restricted",
			allowedDomains: ["api.anthropic.com"],
		});
		client.agents.register(fakeRuntime());
		const calls: CollectedSpawn[] = [];

		const startedWith: { value: StartProxyOptions | null } = { value: null };
		let stopCalls = 0;
		const fakeProxy: StartProxyFn = async (opts) => {
			startedWith.value = opts;
			const handle: ProxyHandle = {
				port: 51234,
				url: "http://127.0.0.1:51234",
				get deniedCount() {
					return 0;
				},
				get allowedCount() {
					return 0;
				},
				stop: async () => {
					stopCalls += 1;
				},
			};
			return handle;
		};

		const result = await runPromptCommand({
			client,
			burrowId: burrow.id,
			prompt: "p",
			options: { agent: "fake", noStream: true },
			stdout: collectStdout().stream,
			isTty: false,
			spawn: fakeSpawn({ stdoutLines: ["ok"], calls }),
			startProxy: fakeProxy,
		});

		expect(result.state).toBe("succeeded");
		expect(startedWith.value).not.toBeNull();
		expect(startedWith.value?.allowedDomains).toEqual(["api.anthropic.com"]);
		expect(stopCalls).toBe(1);

		expect(calls).toHaveLength(1);
		const spawned = calls[0];
		expect(spawned?.profile.proxyAddress).toEqual({ host: "127.0.0.1", port: 51234 });
		expect(spawned?.command.env?.HTTP_PROXY).toBe("http://127.0.0.1:51234");
		expect(spawned?.command.env?.HTTPS_PROXY).toBe("http://127.0.0.1:51234");
		expect(spawned?.command.env?.http_proxy).toBe("http://127.0.0.1:51234");
		expect(spawned?.command.env?.https_proxy).toBe("http://127.0.0.1:51234");
	});

	test("network=open does not start a proxy or set proxyAddress", async () => {
		const burrow = seedActiveBurrow(client, { network: "open" });
		client.agents.register(fakeRuntime());
		const calls: CollectedSpawn[] = [];
		let proxyStarts = 0;
		const fakeProxy: StartProxyFn = async () => {
			proxyStarts += 1;
			throw new Error("should not be called");
		};

		await runPromptCommand({
			client,
			burrowId: burrow.id,
			prompt: "p",
			options: { agent: "fake", noStream: true },
			stdout: collectStdout().stream,
			isTty: false,
			spawn: fakeSpawn({ stdoutLines: ["ok"], calls }),
			startProxy: fakeProxy,
		});

		expect(proxyStarts).toBe(0);
		expect(calls[0]?.profile.proxyAddress).toBeUndefined();
		expect(calls[0]?.command.env?.HTTP_PROXY).toBeUndefined();
	});

	test("proxy is stopped even when spawn rejects", async () => {
		const burrow = seedActiveBurrow(client, {
			network: "restricted",
			allowedDomains: ["github.com"],
		});
		client.agents.register(fakeRuntime());

		let stopCalls = 0;
		const fakeProxy: StartProxyFn = async () => ({
			port: 9999,
			url: "http://127.0.0.1:9999",
			get deniedCount() {
				return 0;
			},
			get allowedCount() {
				return 0;
			},
			stop: async () => {
				stopCalls += 1;
			},
		});
		const failingSpawn: SpawnFn = async () => {
			throw new Error("kaboom");
		};

		const result = await runPromptCommand({
			client,
			burrowId: burrow.id,
			prompt: "p",
			options: { agent: "fake", noStream: true },
			stdout: collectStdout().stream,
			isTty: false,
			spawn: failingSpawn,
			startProxy: fakeProxy,
		});
		expect(result.state).toBe("failed");
		expect(result.run.errorMessage).toBe("kaboom");
		expect(stopCalls).toBe(1);
	});

	test("aborting via signal cancels the spawn and finalizes cancelled", async () => {
		const burrow = seedActiveBurrow(client);
		client.agents.register(fakeRuntime());
		const ac = new AbortController();
		ac.abort();

		const result = await runPromptCommand({
			client,
			burrowId: burrow.id,
			prompt: "p",
			options: { agent: "fake", noStream: true },
			stdout: collectStdout().stream,
			signal: ac.signal,
			isTty: false,
			spawn: fakeSpawn(),
		});

		expect(result.state).toBe("cancelled");
	});
});

describe("renderPromptResult", () => {
	test("renders a success summary with event counts", () => {
		const out = renderPromptResult({
			burrow: {
				id: "bur_x",
				parentId: null,
				kind: "project",
				name: null,
				projectRoot: "/r",
				workspacePath: "/r/ws",
				branch: "main",
				provider: "local",
				providerStateJson: null,
				profileJson: {},
				state: "active",
				createdAt: new Date(0),
				updatedAt: new Date(0),
				destroyedAt: null,
			},
			run: {
				id: "run_x",
				burrowId: "bur_x",
				agentId: "claude-code",
				prompt: "p",
				resumeOfRunId: null,
				state: "succeeded",
				exitCode: 0,
				errorMessage: null,
				metadataJson: null,
				queuedAt: new Date(0),
				startedAt: null,
				completedAt: null,
			},
			agentId: "claude-code",
			state: "succeeded",
			exitCode: 0,
			eventsPersisted: 7,
			messagesDelivered: 0,
		});
		expect(out).toContain("✓ run run_x succeeded (exit 0)");
		expect(out).toContain("agent:    claude-code");
		expect(out).toContain("events:   7");
		expect(out).not.toContain("steering");
	});
});
