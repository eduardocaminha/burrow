import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../../lib/client.ts";
import { runStopCommand } from "./stop.ts";

describe("runStopCommand", () => {
	let dataDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-stop-"));
		client = await Client.open({ dataDir, configDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("stops an active burrow and is idempotent on re-run", () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});

		let result = runStopCommand({ client, burrowIds: [burrow.id], options: {} });
		expect(result.outcomes[0]).toMatchObject({ id: burrow.id, ok: true, state: "stopped" });

		result = runStopCommand({ client, burrowIds: [burrow.id], options: {} });
		expect(result.outcomes[0]).toMatchObject({ ok: true, state: "stopped" });
	});

	test("captures per-id failures without aborting the batch", () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const result = runStopCommand({
			client,
			burrowIds: ["bur_missing", burrow.id],
			options: {},
		});
		expect(result.outcomes[0]?.ok).toBe(false);
		expect(result.outcomes[1]?.ok).toBe(true);
	});
});
