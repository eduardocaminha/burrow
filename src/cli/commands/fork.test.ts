import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../../core/errors.ts";
import { Client } from "../../lib/client.ts";
import type {
	MaterializedWorkspace,
	MaterializeTaskOptions,
} from "../../provider/local/workspace.ts";
import { runForkCommand } from "./fork.ts";

function seedParent(client: Client) {
	return client.repos.burrows.create({
		kind: "project",
		projectRoot: "/repos/web",
		workspacePath: "/repos/web/.ws",
		branch: "main",
		provider: "local",
		profile: { workspace: "/repos/web/.ws", network: "none" },
		providerState: {
			workspaceSource: { kind: "worktree", branch: "main", hostClonePath: "/host" },
		},
	});
}

describe("runForkCommand", () => {
	let dataDir: string;
	let client: Client;
	let calls: MaterializeTaskOptions[];

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-fork-"));
		client = await Client.open({ dataDir, configDir: dataDir });
		calls = [];
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	const fakeMaterializer = async (opts: MaterializeTaskOptions): Promise<MaterializedWorkspace> => {
		calls.push(opts);
		return {
			workspacePath: opts.workspacePath,
			source: {
				kind: "worktree",
				branch: opts.taskBranch,
				hostClonePath: opts.parentClonePath,
			},
			identity: null,
		};
	};

	test("creates a task burrow row, inheriting profile and project root", async () => {
		const parent = seedParent(client);
		const result = await runForkCommand({
			client,
			parentId: parent.id,
			options: { task: "fix login bug" },
			materializer: fakeMaterializer,
		});
		expect(result.burrow.kind).toBe("task");
		expect(result.burrow.parentId).toBe(parent.id);
		expect(result.burrow.projectRoot).toBe(parent.projectRoot);
		expect(result.burrow.name).toBe("fix login bug");
		expect(result.burrow.branch.startsWith("task/")).toBe(true);
		expect(calls[0]?.parentClonePath).toBe("/host");
	});

	test("worktree-backed materializer's gitCommonDir lifts onto child profile.workspaceGitdir (burrow-7a80)", async () => {
		const parent = seedParent(client);
		const withGitdir = async (opts: MaterializeTaskOptions): Promise<MaterializedWorkspace> => ({
			workspacePath: opts.workspacePath,
			source: {
				kind: "worktree",
				branch: opts.taskBranch,
				hostClonePath: opts.parentClonePath,
				gitCommonDir: `${opts.parentClonePath}/.git`,
			},
			identity: null,
		});
		const result = await runForkCommand({
			client,
			parentId: parent.id,
			options: {},
			materializer: withGitdir,
		});
		const profile = result.burrow.profileJson as { workspaceGitdir?: string };
		expect(profile.workspaceGitdir).toBe("/host/.git");
	});

	test("rejects forking a destroyed parent", async () => {
		const parent = seedParent(client);
		client.repos.burrows.markDestroyed(parent.id);
		await expect(
			runForkCommand({
				client,
				parentId: parent.id,
				options: {},
				materializer: fakeMaterializer,
			}),
		).rejects.toThrow(ValidationError);
	});

	test("rejects parent with no workspaceSource recorded", async () => {
		const parent = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		await expect(
			runForkCommand({
				client,
				parentId: parent.id,
				options: {},
				materializer: fakeMaterializer,
			}),
		).rejects.toThrow(ValidationError);
	});
});
