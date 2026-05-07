import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError } from "../../core/errors.ts";
import { Client } from "../../lib/client.ts";
import { renderShowReport, runShowCommand, showResultToJson } from "./show.ts";

describe("runShowCommand", () => {
	let dataDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-show-"));
		client = await Client.open({ dataDir, configDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("aggregates burrow + runs + events + pending messages", () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		client.runs.create({ burrowId: burrow.id, agentId: "claude-code", prompt: "hi" });
		client.repos.events.append({
			burrowId: burrow.id,
			kind: "tool_use",
			stream: "stdout",
			payload: { tool: "ls" },
		});
		client.inbox.send({ burrowId: burrow.id, body: "do something" });

		const result = runShowCommand({ client, burrowId: burrow.id, options: {} });
		expect(result.burrow.id).toBe(burrow.id);
		expect(result.runs.length).toBe(1);
		expect(result.events.length).toBe(1);
		expect(result.pendingMessages.length).toBe(1);
		expect(result.counts.pending).toBe(1);
	});

	test("renders a TTY summary", () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const out = renderShowReport(runShowCommand({ client, burrowId: burrow.id, options: {} }));
		expect(out).toContain("Burrow ");
		expect(out).toContain("(none yet)");
	});

	test("emits valid JSON", () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const json = showResultToJson(runShowCommand({ client, burrowId: burrow.id, options: {} }));
		const parsed = JSON.parse(json);
		expect(parsed.burrow.id).toBe(burrow.id);
	});

	test("missing burrow throws NotFoundError", () => {
		expect(() => runShowCommand({ client, burrowId: "bur_nope", options: {} })).toThrow(
			NotFoundError,
		);
	});
});
