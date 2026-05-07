import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../../core/errors.ts";
import { Client } from "../../lib/client.ts";
import type {
	MaterializedWorkspace,
	MaterializeProjectOptions,
} from "../../provider/local/workspace.ts";
import { parseNetworkPolicy, renderUpResult, runUpCommand } from "./up.ts";

describe("parseNetworkPolicy", () => {
	test("defaults to none", () => {
		expect(parseNetworkPolicy(undefined)).toBe("none");
	});
	test("rejects unknown values", () => {
		expect(() => parseNetworkPolicy("bogus")).toThrow(ValidationError);
	});
});

describe("runUpCommand", () => {
	let dataDir: string;
	let client: Client;
	let materializerCalls: MaterializeProjectOptions[];

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-up-"));
		client = await Client.open({ dataDir, configDir: dataDir });
		materializerCalls = [];
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	const fakeMaterializer = async (
		opts: MaterializeProjectOptions,
	): Promise<MaterializedWorkspace> => {
		materializerCalls.push(opts);
		return {
			workspacePath: opts.workspacePath,
			source: { kind: "worktree", branch: opts.branch, hostClonePath: "/host" },
			identity: null,
		};
	};

	test("creates a project burrow row with the materialized workspace", async () => {
		const result = await runUpCommand({
			client,
			projectRoot: "/repos/web-app",
			options: { name: "web", branch: "feature/x" },
			materializer: fakeMaterializer,
		});
		expect(result.burrow.kind).toBe("project");
		expect(result.burrow.name).toBe("web");
		expect(result.burrow.branch).toBe("feature/x");
		expect(result.burrow.workspacePath).toContain(result.burrow.id);
		expect(materializerCalls).toHaveLength(1);
		expect(materializerCalls[0]?.branch).toBe("feature/x");

		const row = client.burrows.get(result.burrow.id);
		expect(row.id).toBe(result.burrow.id);
		expect(row.providerStateJson).toMatchObject({
			workspaceSource: { kind: "worktree" },
		});
	});

	test("auto-generates a per-burrow branch when --branch is omitted", async () => {
		const result = await runUpCommand({
			client,
			projectRoot: "/repos/web-app",
			options: {},
			materializer: fakeMaterializer,
		});
		expect(result.burrow.branch.startsWith("burrow/")).toBe(true);
	});

	test("defaults to network=none with no toolchain mounts", async () => {
		const result = await runUpCommand({
			client,
			projectRoot: "/repos/web-app",
			options: {},
			materializer: fakeMaterializer,
		});
		const profile = result.burrow.profileJson as { network: string; toolchainPaths: unknown[] };
		expect(profile.network).toBe("none");
		expect(profile.toolchainPaths).toEqual([]);
	});

	test("renderUpResult prints the human summary", async () => {
		const result = await runUpCommand({
			client,
			projectRoot: "/repos/web-app",
			options: {},
			materializer: fakeMaterializer,
		});
		const out = renderUpResult(result);
		expect(out).toContain("up");
		expect(out).toContain(result.burrow.id);
	});
});
