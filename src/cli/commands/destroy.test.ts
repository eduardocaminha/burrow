import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../../lib/client.ts";
import type { RemoveWorkspaceOptions } from "../../provider/local/workspace.ts";
import { runDestroyCommand } from "./destroy.ts";

describe("runDestroyCommand", () => {
	let dataDir: string;
	let client: Client;
	const removed: RemoveWorkspaceOptions[] = [];

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-destroy-"));
		client = await Client.open({ dataDir, configDir: dataDir });
		removed.length = 0;
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("archives, removes workspace, and marks destroyed", async () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: join(dataDir, "ws"),
			branch: "main",
			provider: "local",
			profile: {},
			providerState: {
				workspaceSource: { kind: "clone", branch: "main", originUrl: "u" },
			},
		});

		const result = await runDestroyCommand({
			client,
			burrowIds: [burrow.id],
			options: {},
			removeWorkspace: async (opts) => {
				removed.push(opts);
			},
		});

		expect(result.outcomes[0]).toMatchObject({
			ok: true,
			workspaceRemoved: true,
		});
		expect(removed).toHaveLength(1);
		expect(client.burrows.get(burrow.id).state).toBe("destroyed");
		expect(result.outcomes[0]?.archive?.archived).not.toBeNull();
	});

	test("--no-archive skips the archive write", async () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: join(dataDir, "ws2"),
			branch: "main",
			provider: "local",
			profile: {},
		});
		const result = await runDestroyCommand({
			client,
			burrowIds: [burrow.id],
			options: { noArchive: true, keepWorkspace: true },
			removeWorkspace: async () => {},
		});
		expect(result.outcomes[0]?.archive?.archived).toBeNull();
	});

	test("idempotent on already-destroyed burrows", async () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: join(dataDir, "ws3"),
			branch: "main",
			provider: "local",
			profile: {},
		});
		client.repos.burrows.markDestroyed(burrow.id);
		const result = await runDestroyCommand({
			client,
			burrowIds: [burrow.id],
			options: { keepWorkspace: true },
		});
		expect(result.outcomes[0]?.ok).toBe(true);
	});

	test("workspace removal failure doesn't abort archival", async () => {
		const burrow = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: join(dataDir, "ws4"),
			branch: "main",
			provider: "local",
			profile: {},
			providerState: {
				workspaceSource: { kind: "clone", branch: "main", originUrl: "u" },
			},
		});
		const result = await runDestroyCommand({
			client,
			burrowIds: [burrow.id],
			options: {},
			removeWorkspace: async () => {
				throw new Error("permission denied");
			},
		});
		expect(result.outcomes[0]?.ok).toBe(true);
		expect(result.outcomes[0]?.workspaceRemoved).toBe(false);
		expect(client.burrows.get(burrow.id).state).toBe("destroyed");
	});
});
