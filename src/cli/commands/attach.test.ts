import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../../core/errors.ts";
import { Client } from "../../lib/client.ts";
import { runAttachCommand } from "./attach.ts";

describe("runAttachCommand", () => {
	let dataDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-attach-"));
		client = await Client.open({ dataDir, configDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("re-activates a stopped burrow", () => {
		const b = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		client.burrows.stop(b.id);

		const result = runAttachCommand({ client, burrowId: b.id, options: {} });
		expect(result.burrow.state).toBe("active");
		expect(result.wasAlreadyActive).toBe(false);
	});

	test("active burrows are reported as already-active", () => {
		const b = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const result = runAttachCommand({ client, burrowId: b.id, options: {} });
		expect(result.wasAlreadyActive).toBe(true);
	});

	test("destroyed burrows cannot be attached", () => {
		const b = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		client.repos.burrows.markDestroyed(b.id);
		expect(() => runAttachCommand({ client, burrowId: b.id, options: {} })).toThrow(
			ValidationError,
		);
	});
});
