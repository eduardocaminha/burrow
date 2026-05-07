import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { type BurrowDb, openDatabase } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { BurrowRow } from "../db/schema.ts";
import { Inbox } from "./inbox.ts";

function seedBurrow(repos: Repos, suffix = "a"): BurrowRow {
	return repos.burrows.create({
		kind: "project",
		projectRoot: `/r-${suffix}`,
		workspacePath: `/r-${suffix}/ws`,
		branch: "main",
		provider: "local",
		profile: {},
	});
}

describe("Inbox", () => {
	let db: BurrowDb;
	let repos: Repos;
	let inbox: Inbox;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		inbox = new Inbox(repos);
	});

	afterEach(() => db.close());

	test("send queues an unread message and defaults the actor to 'user'", () => {
		const burrow = seedBurrow(repos);
		const msg = inbox.send({ burrowId: burrow.id, body: "do the thing" });
		expect(msg.fromActor).toBe("user");
		expect(msg.state).toBe("unread");
		expect(inbox.pending(burrow.id)).toHaveLength(1);
	});

	test("send rejects empty bodies", () => {
		const burrow = seedBurrow(repos);
		expect(() => inbox.send({ burrowId: burrow.id, body: "" })).toThrow(ValidationError);
	});

	test("send rejects non-active burrows", () => {
		const burrow = seedBurrow(repos);
		repos.burrows.markStopped(burrow.id);
		expect(() => inbox.send({ burrowId: burrow.id, body: "hi" })).toThrow(ValidationError);
	});

	test("list returns the burrow's messages newest-first; pending omits delivered", () => {
		const burrow = seedBurrow(repos);
		const a = inbox.send({ burrowId: burrow.id, body: "first", now: new Date(1000) });
		const b = inbox.send({ burrowId: burrow.id, body: "second", now: new Date(2000) });
		expect(inbox.list(burrow.id).map((m) => m.id)).toEqual([b.id, a.id]);

		const run = repos.runs.enqueue({ burrowId: burrow.id, agentId: "x", prompt: "" });
		inbox.claimForRun(burrow.id, run.id);
		expect(inbox.pending(burrow.id)).toHaveLength(0);
		expect(inbox.list(burrow.id, { state: "delivered" })).toHaveLength(2);
	});

	test("cancel removes the message", () => {
		const burrow = seedBurrow(repos);
		const m = inbox.send({ burrowId: burrow.id, body: "drop me" });
		inbox.cancel(m.id);
		expect(repos.messages.get(m.id)).toBeNull();
	});

	test("claimForRun delegates to the repo and tags the runId", () => {
		const burrow = seedBurrow(repos);
		const run = repos.runs.enqueue({ burrowId: burrow.id, agentId: "x", prompt: "" });
		inbox.send({ burrowId: burrow.id, body: "one" });
		inbox.send({ burrowId: burrow.id, body: "two", priority: "urgent" });

		const claimed = inbox.claimForRun(burrow.id, run.id);
		expect(claimed.map((m) => m.body)).toEqual(["two", "one"]);
		for (const m of claimed) expect(m.deliveredAtRunId).toBe(run.id);
	});

	test("count tallies messages by state", () => {
		const burrow = seedBurrow(repos);
		const run = repos.runs.enqueue({ burrowId: burrow.id, agentId: "x", prompt: "" });
		inbox.send({ burrowId: burrow.id, body: "a" });
		inbox.send({ burrowId: burrow.id, body: "b" });
		expect(inbox.count(burrow.id)).toBe(2);
		expect(inbox.count(burrow.id, "unread")).toBe(2);
		inbox.claimForRun(burrow.id, run.id);
		expect(inbox.count(burrow.id, "delivered")).toBe(2);
	});
});
