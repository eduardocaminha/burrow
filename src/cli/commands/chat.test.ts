import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { type BurrowDb, openDatabase } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { BurrowRow } from "../../db/schema.ts";
import { formatChatLine, lineIterator, renderChatBanner, runChatCommand } from "./chat.ts";

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

class CollectStream {
	chunks: string[] = [];
	stream: NodeJS.WritableStream = {
		write: (chunk: string | Uint8Array) => {
			this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		},
		end: () => {},
	} as NodeJS.WritableStream;
	get text(): string {
		return this.chunks.join("");
	}
}

async function* fromArray(lines: string[]): AsyncGenerator<string> {
	for (const line of lines) yield line;
}

describe("runChatCommand", () => {
	let db: BurrowDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(() => db.close());

	test("queues a message per non-blank stdin line and prints confirmations", async () => {
		const burrow = seedBurrow(repos);
		const out = new CollectStream();
		const summary = await runChatCommand({
			db,
			burrowId: burrow.id,
			options: {},
			stdin: fromArray(["hello", "  ", "stop and write tests"]),
			stdout: out.stream,
		});
		expect(summary.queued).toBe(2);
		expect(repos.messages.listByBurrow(burrow.id)).toHaveLength(2);
		expect(out.text).toContain("✓");
		expect(out.text).toContain("(normal)");
	});

	test("warns when the burrow's most recent run targeted a one-shot runtime", async () => {
		const burrow = seedBurrow(repos);
		repos.runs.enqueue({ burrowId: burrow.id, agentId: "codex", prompt: "p" });
		const out = new CollectStream();
		const summary = await runChatCommand({
			db,
			burrowId: burrow.id,
			options: {},
			stdin: fromArray([]),
			stdout: out.stream,
		});
		expect(summary.deferred).toBe(true);
		expect(summary.lastAgentId).toBe("codex");
		expect(out.text).toContain("codex is one-shot");
	});

	test("json mode emits one JSON object per queued message", async () => {
		const burrow = seedBurrow(repos);
		const out = new CollectStream();
		await runChatCommand({
			db,
			burrowId: burrow.id,
			options: { json: true },
			stdin: fromArray(["one", "two"]),
			stdout: out.stream,
		});
		const lines = out.text.trim().split("\n");
		expect(lines).toHaveLength(2);
		const parsed = lines.map((l) => JSON.parse(l));
		expect(parsed[0]?.body).toBe("one");
		expect(parsed[1]?.body).toBe("two");
	});

	test("respects priority + fromActor options", async () => {
		const burrow = seedBurrow(repos);
		const out = new CollectStream();
		await runChatCommand({
			db,
			burrowId: burrow.id,
			options: { priority: "urgent", from: "operator" },
			stdin: fromArray(["abort"]),
			stdout: out.stream,
		});
		const messages = repos.messages.listByBurrow(burrow.id);
		expect(messages[0]?.priority).toBe("urgent");
		expect(messages[0]?.fromActor).toBe("operator");
	});
});

describe("renderChatBanner", () => {
	test("notes when no run has happened yet", () => {
		const banner = renderChatBanner("bur_a", null, false);
		expect(banner).toContain("no runs yet");
	});

	test("includes the agent name on warning when deferred", () => {
		const banner = renderChatBanner("bur_a", "codex", true);
		expect(banner).toContain("codex is one-shot");
	});
});

describe("formatChatLine", () => {
	test("pretty mode renders ✓ + id + priority", () => {
		const out = formatChatLine(
			{
				id: "msg_1",
				burrowId: "bur_a",
				fromActor: "user",
				body: "hi",
				priority: "high",
				state: "unread",
				deliveredAtRunId: null,
				createdAt: new Date(0),
				deliveredAt: null,
			},
			false,
		);
		expect(out).toContain("✓ msg_1 (high)");
	});

	test("json mode emits a single-line JSON envelope", () => {
		const out = formatChatLine(
			{
				id: "msg_1",
				burrowId: "bur_a",
				fromActor: "user",
				body: "hi",
				priority: "high",
				state: "unread",
				deliveredAtRunId: null,
				createdAt: new Date(0),
				deliveredAt: null,
			},
			true,
		);
		expect(JSON.parse(out)).toEqual({ id: "msg_1", priority: "high", body: "hi" });
	});
});

describe("lineIterator", () => {
	test("yields one entry per newline and flushes a trailing fragment", async () => {
		const stream = Readable.from(["one\ntw", "o\nthree"]);
		const got: string[] = [];
		for await (const line of lineIterator(stream)) got.push(line);
		expect(got).toEqual(["one", "two", "three"]);
	});
});
