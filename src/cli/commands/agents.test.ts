import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { Client } from "../../lib/client.ts";
import {
	renderAgentShow,
	renderAgentsList,
	renderAgentValidate,
	runAgentShow,
	runAgentsList,
	runAgentValidate,
} from "./agents.ts";

describe("agents commands", () => {
	let dataDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-agents-"));
		client = await Client.open({ dataDir, configDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("list returns the built-in runtimes", async () => {
		const items = await runAgentsList(client);
		const ids = items.map((i) => i.id);
		expect(ids).toContain("claude-code");
		expect(ids).toContain("sapling");
		expect(ids).toContain("codex");
	});

	test("renderAgentsList contains every id", async () => {
		const items = await runAgentsList(client);
		const out = renderAgentsList(items);
		expect(out).toContain("claude-code");
	});

	test("show throws NotFound for unknown agent", async () => {
		await expect(runAgentShow(client, "nope")).rejects.toThrow(NotFoundError);
	});

	test("show returns spawnPerTurn flag", async () => {
		const report = await runAgentShow(client, "claude-code");
		expect(report.runtime.id).toBe("claude-code");
		expect(report.runtime.spawnPerTurn).toBe(true);
		const text = renderAgentShow(report);
		expect(text).toContain("Agent claude-code");
	});

	test("validate accepts a well-formed config", async () => {
		const file = join(dataDir, "agent.json");
		writeFileSync(
			file,
			JSON.stringify({
				id: "my-agent",
				displayName: "My Agent",
				command: "./run.sh",
				args: ["--prompt", "{{prompt}}"],
				promptDelivery: "arg",
				outputFormat: "raw-text",
			}),
		);
		const result = await runAgentValidate(file);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.id).toBe("my-agent");
		expect(renderAgentValidate(result)).toContain("✓");
	});

	test("validate reports zod errors as a list", async () => {
		const file = join(dataDir, "bad.json");
		writeFileSync(file, JSON.stringify({ id: "" }));
		const result = await runAgentValidate(file);
		expect(result.ok).toBe(false);
		const text = renderAgentValidate(result);
		expect(text).toContain("✗");
	});

	test("validate fails loudly on non-JSON", async () => {
		const file = join(dataDir, "bad.txt");
		writeFileSync(file, "not json {");
		await expect(runAgentValidate(file)).rejects.toThrow(ValidationError);
	});
});
