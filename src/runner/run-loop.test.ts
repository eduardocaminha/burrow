import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type BurrowDb, openDatabase } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { BurrowRow } from "../db/schema.ts";
import { type RunHandler, RunLoop } from "./run-loop.ts";

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

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve: (v: T) => void = () => {};
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("RunLoop", () => {
	let db: BurrowDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => db.close());

	test("start() runs crash recovery and re-enqueues queued runs", async () => {
		const burrow = seedBurrow(repos);
		const stuck = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "x",
			prompt: "stuck",
		});
		repos.runs.markRunning(stuck.id);

		const queued = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "x",
			prompt: "fresh",
		});

		const handler: RunHandler = async () => ({ state: "succeeded" });
		const loop = new RunLoop({ repos, handler });
		const { recovered } = loop.start();
		await loop.stop();

		expect(recovered.failedRunIds).toEqual([stuck.id]);
		expect(repos.runs.require(stuck.id).state).toBe("failed");
		expect(repos.runs.require(queued.id).state).toBe("succeeded");
	});

	test("runs against the same burrow execute strictly FIFO", async () => {
		const burrow = seedBurrow(repos);
		const order: string[] = [];
		const gates = [deferred<void>(), deferred<void>(), deferred<void>()];

		const handler: RunHandler = async ({ run }) => {
			const idx = Number(run.prompt);
			order.push(`start-${idx}`);
			await gates[idx]?.promise;
			order.push(`end-${idx}`);
			return { state: "succeeded" };
		};
		const loop = new RunLoop({ repos, handler });
		loop.start();

		const r0 = repos.runs.enqueue({ burrowId: burrow.id, agentId: "x", prompt: "0" });
		const r1 = repos.runs.enqueue({ burrowId: burrow.id, agentId: "x", prompt: "1" });
		const r2 = repos.runs.enqueue({ burrowId: burrow.id, agentId: "x", prompt: "2" });
		const p0 = loop.enqueue(r0.id);
		const p1 = loop.enqueue(r1.id);
		const p2 = loop.enqueue(r2.id);

		// Resolve in reverse to prove FIFO holds regardless of completion order signaled.
		// The first run is the only one that has actually started; we resolve it first.
		await Promise.resolve();
		gates[0]?.resolve();
		await p0;
		gates[1]?.resolve();
		await p1;
		gates[2]?.resolve();
		await Promise.all([p1, p2]);

		await loop.stop();

		expect(order).toEqual(["start-0", "end-0", "start-1", "end-1", "start-2", "end-2"]);
		expect(repos.runs.require(r2.id).state).toBe("succeeded");
	});

	test("distinct burrows run in parallel", async () => {
		const a = seedBurrow(repos, "a");
		const b = seedBurrow(repos, "b");
		const startedAt = new Map<string, number>();
		const gate = deferred<void>();

		const handler: RunHandler = async ({ run }) => {
			startedAt.set(run.burrowId, Date.now());
			await gate.promise;
			return { state: "succeeded" };
		};
		const loop = new RunLoop({ repos, handler });
		loop.start();

		const ra = repos.runs.enqueue({ burrowId: a.id, agentId: "x", prompt: "" });
		const rb = repos.runs.enqueue({ burrowId: b.id, agentId: "x", prompt: "" });
		const pa = loop.enqueue(ra.id);
		const pb = loop.enqueue(rb.id);

		// Both handlers should reach the gate before either completes.
		while (startedAt.size < 2) await new Promise((r) => setTimeout(r, 5));
		gate.resolve();
		await Promise.all([pa, pb]);
		await loop.stop();

		expect(repos.runs.require(ra.id).state).toBe("succeeded");
		expect(repos.runs.require(rb.id).state).toBe("succeeded");
	});

	test("handler exception finalizes the run as failed", async () => {
		const burrow = seedBurrow(repos);
		const handler: RunHandler = async () => {
			throw new Error("kaboom");
		};
		const loop = new RunLoop({ repos, handler });
		loop.start();

		const run = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "x",
			prompt: "p",
		});
		await loop.enqueue(run.id);
		await loop.stop();

		const finalized = repos.runs.require(run.id);
		expect(finalized.state).toBe("failed");
		expect(finalized.errorMessage).toBe("kaboom");
	});

	test("force-stop signals abort to in-flight handlers", async () => {
		const burrow = seedBurrow(repos);
		const aborted = deferred<boolean>();
		const handler: RunHandler = async ({ signal }) =>
			new Promise((resolve) => {
				signal.addEventListener("abort", () => {
					aborted.resolve(true);
					resolve({ state: "cancelled", errorMessage: "aborted" });
				});
			});
		const loop = new RunLoop({ repos, handler });
		loop.start();

		const run = repos.runs.enqueue({
			burrowId: burrow.id,
			agentId: "x",
			prompt: "p",
		});
		const inflight = loop.enqueue(run.id);
		await new Promise((r) => setTimeout(r, 10));
		await loop.stop({ force: true });
		await inflight;

		expect(await aborted.promise).toBe(true);
		expect(repos.runs.require(run.id).state).toBe("cancelled");
	});
});
