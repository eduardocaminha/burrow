import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type BurrowDb, openDatabase } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { BurrowRow } from "../db/schema.ts";
import { AgentRegistry } from "../runtime/registry.ts";
import { Inbox } from "./inbox.ts";
import { isSpawnPerTurn, prepareTurnInjection } from "./injector.ts";

function seedBurrow(repos: Repos): BurrowRow {
	return repos.burrows.create({
		kind: "project",
		projectRoot: "/r",
		workspacePath: "/r/ws",
		branch: "main",
		provider: "local",
		profile: {},
	});
}

describe("prepareTurnInjection", () => {
	let db: BurrowDb;
	let repos: Repos;
	let inbox: Inbox;
	let registry: AgentRegistry;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		inbox = new Inbox(repos);
		registry = new AgentRegistry();
	});

	afterEach(() => db.close());

	test("returns the runtime + claimed messages for a spawn-per-turn agent", () => {
		const burrow = seedBurrow(repos);
		const run = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "go",
		});
		inbox.send({ burrowId: burrow.id, body: "stop and write tests", priority: "high" });

		const injection = prepareTurnInjection({
			inbox,
			registry,
			burrowId: burrow.id,
			runId: run.id,
			agentId: "claude-code",
		});

		expect(injection.runtime.id).toBe("claude-code");
		expect(injection.messages.map((m) => m.body)).toEqual(["stop and write tests"]);
		expect(injection.deferred).toBe(false);
		expect(inbox.pending(burrow.id)).toHaveLength(0);
	});

	test("flags codex as deferred (one-shot) but still claims pending messages", () => {
		const burrow = seedBurrow(repos);
		const run = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "codex",
			prompt: "go",
		});
		inbox.send({ burrowId: burrow.id, body: "remember to lint" });

		const injection = prepareTurnInjection({
			inbox,
			registry,
			burrowId: burrow.id,
			runId: run.id,
			agentId: "codex",
		});

		expect(injection.runtime.id).toBe("codex");
		expect(injection.deferred).toBe(true);
		expect(injection.messages).toHaveLength(1);
	});

	test("isSpawnPerTurn matches the encodeInboxMessage hook", () => {
		expect(isSpawnPerTurn(registry.require("claude-code"))).toBe(true);
		expect(isSpawnPerTurn(registry.require("sapling"))).toBe(true);
		expect(isSpawnPerTurn(registry.require("codex"))).toBe(false);
	});

	test("propagates NotFound when the agentId isn't registered", () => {
		const burrow = seedBurrow(repos);
		const run = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "missing",
			prompt: "go",
		});
		expect(() =>
			prepareTurnInjection({
				inbox,
				registry,
				burrowId: burrow.id,
				runId: run.id,
				agentId: "missing",
			}),
		).toThrow(/agent runtime not registered/);
	});
});
