import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type BurrowDb, openDatabase } from "../client.ts";
import type { BurrowRow } from "../schema.ts";
import { createRepos, type Repos } from "./index.ts";

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

describe("MessagesRepo", () => {
	let db: BurrowDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => db.close());

	test("send inserts an unread message with default priority", () => {
		const burrow = seedBurrow(repos);
		const msg = repos.messages.send({
			burrowId: burrow.id,
			fromActor: "user",
			body: "hi",
		});
		expect(msg.id).toMatch(/^msg_/);
		expect(msg.state).toBe("unread");
		expect(msg.priority).toBe("normal");
	});

	test("listPending sorts urgent first then FIFO inside priority", () => {
		const burrow = seedBurrow(repos);
		const a = repos.messages.send({
			burrowId: burrow.id,
			fromActor: "user",
			body: "a-low",
			priority: "low",
			now: new Date(100),
		});
		const b = repos.messages.send({
			burrowId: burrow.id,
			fromActor: "user",
			body: "b-urgent",
			priority: "urgent",
			now: new Date(200),
		});
		const c = repos.messages.send({
			burrowId: burrow.id,
			fromActor: "user",
			body: "c-urgent",
			priority: "urgent",
			now: new Date(300),
		});
		const d = repos.messages.send({
			burrowId: burrow.id,
			fromActor: "user",
			body: "d-normal",
			priority: "normal",
			now: new Date(400),
		});

		const order = repos.messages.listPending(burrow.id).map((m) => m.id);
		expect(order).toEqual([b.id, c.id, d.id, a.id]);
	});

	test("markDelivered moves the message and records the run id", () => {
		const burrow = seedBurrow(repos);
		const run = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "claude-code",
			prompt: "p",
		});
		const m = repos.messages.send({
			burrowId: burrow.id,
			fromActor: "user",
			body: "hi",
		});
		const updated = repos.messages.markDelivered(m.id, run.id);
		expect(updated.state).toBe("delivered");
		expect(updated.deliveredAtRunId).toBe(run.id);
		expect(repos.messages.listPending(burrow.id)).toHaveLength(0);
	});

	test("resetDeliveredOrphans only resets messages whose run is missing or non-terminal", () => {
		const burrow = seedBurrow(repos);
		const liveRun = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "x",
			prompt: "live",
		});
		repos.runs.markRunning(liveRun.id);

		const finishedRun = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "x",
			prompt: "done",
		});
		repos.runs.markRunning(finishedRun.id);
		repos.runs.finalize(finishedRun.id, { state: "succeeded" });

		const orphanMsg = repos.messages.send({ burrowId: burrow.id, fromActor: "u", body: "1" });
		const stillDeliveredMsg = repos.messages.send({
			burrowId: burrow.id,
			fromActor: "u",
			body: "2",
		});
		repos.messages.markDelivered(orphanMsg.id, liveRun.id);
		repos.messages.markDelivered(stillDeliveredMsg.id, finishedRun.id);

		const reset = repos.messages.resetDeliveredOrphans();
		expect(reset).toEqual([orphanMsg.id]);
		expect(repos.messages.require(orphanMsg.id).state).toBe("unread");
		expect(repos.messages.require(orphanMsg.id).deliveredAtRunId).toBeNull();
		expect(repos.messages.require(stillDeliveredMsg.id).state).toBe("delivered");
	});
});
