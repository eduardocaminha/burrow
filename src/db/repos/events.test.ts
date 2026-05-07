import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type BurrowDb, openDatabase } from "../client.ts";
import { createRepos, type Repos } from "./index.ts";

describe("EventsRepo", () => {
	let db: BurrowDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => db.close());

	test("seq is monotonic per burrow", () => {
		const burrowA = repos.burrows.create({
			kind: "project",
			projectRoot: "/a",
			workspacePath: "/a/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const burrowB = repos.burrows.create({
			kind: "project",
			projectRoot: "/b",
			workspacePath: "/b/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});

		const a1 = repos.events.append({
			burrowId: burrowA.id,
			kind: "tool_use",
			stream: "stdout",
			payload: { i: 1 },
		});
		const a2 = repos.events.append({
			burrowId: burrowA.id,
			kind: "tool_use",
			stream: "stdout",
			payload: { i: 2 },
		});
		const b1 = repos.events.append({
			burrowId: burrowB.id,
			kind: "tool_use",
			stream: "stdout",
			payload: { i: 1 },
		});

		expect(a1.seq).toBe(1);
		expect(a2.seq).toBe(2);
		expect(b1.seq).toBe(1);
	});

	test("listByBurrow filters by sinceSeq", () => {
		const burrow = repos.burrows.create({
			kind: "project",
			projectRoot: "/a",
			workspacePath: "/a/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		for (let i = 0; i < 5; i++) {
			repos.events.append({
				burrowId: burrow.id,
				kind: "kind",
				stream: "stdout",
				payload: { i },
			});
		}
		const after2 = repos.events.listByBurrow(burrow.id, { sinceSeq: 2 });
		expect(after2.map((e) => e.seq)).toEqual([3, 4, 5]);
	});

	test("payload roundtrips as JSON", () => {
		const burrow = repos.burrows.create({
			kind: "project",
			projectRoot: "/a",
			workspacePath: "/a/ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const e = repos.events.append({
			burrowId: burrow.id,
			kind: "tool_result",
			stream: "stdout",
			payload: { ok: true, items: [1, 2, 3] },
		});
		const fetched = repos.events.listByBurrow(burrow.id);
		expect(fetched).toHaveLength(1);
		expect(fetched[0]?.payloadJson).toEqual({ ok: true, items: [1, 2, 3] });
		expect(fetched[0]?.id).toBe(e.id);
	});
});
