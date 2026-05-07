/**
 * `burrow fork <id>` — fork a project burrow into a task burrow (SPEC §11).
 *
 * Carves a fresh `task/<bur-id>` worktree against the parent burrow's host
 * clone (or, when the parent itself materialized via clone, against the
 * cloned workspace). Inherits the parent's sandbox profile but writes a new
 * `providerStateJson` that destroy will use to remove the worktree later.
 *
 * The parent must be active or stopped — destroyed parents have no host
 * clone to fork from.
 */

import { join } from "node:path";
import { ValidationError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import type { Burrow, BurrowKind } from "../../core/types.ts";
import type { Client } from "../../lib/client.ts";
import {
	type MaterializedWorkspace,
	type MaterializedWorkspaceSource,
	type MaterializeTaskOptions,
	materializeTaskWorkspace,
} from "../../provider/local/workspace.ts";
import type { SandboxProfile } from "../../provider/types.ts";

export interface ForkCommandOptions {
	task?: string;
	branch?: string;
	baseBranch?: string;
	json?: boolean;
}

export interface ForkCommandInput {
	client: Client;
	parentId: string;
	options: ForkCommandOptions;
	/** Test seam for `materializeTaskWorkspace`. */
	materializer?: (opts: MaterializeTaskOptions) => Promise<MaterializedWorkspace>;
	projectsDir?: string;
}

export interface ForkCommandResult {
	burrow: Burrow;
	workspace: MaterializedWorkspace;
}

export async function runForkCommand(input: ForkCommandInput): Promise<ForkCommandResult> {
	const parent = input.client.burrows.get(input.parentId);
	if (parent.state === "destroyed") {
		throw new ValidationError(`cannot fork destroyed parent ${parent.id}`, {
			recoveryHint: "the parent's workspace is gone — pick an active burrow",
		});
	}
	const parentSource = extractSource(parent);
	if (!parentSource) {
		throw new ValidationError(
			`parent ${parent.id} has no recorded workspace source — was it created via burrow up?`,
		);
	}
	const parentClonePath = parentSource.hostClonePath ?? parent.workspacePath;

	const burrowId = generateId("burrow");
	const taskBranch = input.options.branch ?? `task/${burrowId}`;
	const workspacePath = join(
		input.projectsDir ?? input.client.paths.projectsDir,
		projectSlug(parent.projectRoot),
		"workspaces",
		burrowId,
	);

	const materializer = input.materializer ?? materializeTaskWorkspace;
	const workspace = await materializer({
		workspacePath,
		parentClonePath,
		taskBranch,
		baseBranch: input.options.baseBranch ?? parent.branch,
	});

	const profile: SandboxProfile = {
		...(parent.profileJson as SandboxProfile),
		workspace: workspace.workspacePath,
	};

	const providerState = {
		workspaceSource: workspace.source,
		identity: workspace.identity,
		taskDescription: input.options.task ?? null,
	};

	const burrow = input.client.repos.burrows.create({
		id: burrowId,
		parentId: parent.id,
		kind: "task" satisfies BurrowKind,
		name: input.options.task ?? null,
		projectRoot: parent.projectRoot,
		workspacePath: workspace.workspacePath,
		branch: taskBranch,
		provider: parent.provider,
		providerState,
		profile,
	});

	return { burrow, workspace };
}

export function renderForkResult(result: ForkCommandResult): string {
	const lines = [
		`✓ task burrow ${result.burrow.id} forked`,
		`  parent:    ${result.burrow.parentId}`,
		`  branch:    ${result.burrow.branch}`,
		`  workspace: ${result.burrow.workspacePath}`,
	];
	if (result.burrow.name) lines.push(`  task:      ${result.burrow.name}`);
	return lines.join("\n");
}

function extractSource(burrow: Burrow): MaterializedWorkspaceSource | null {
	const state = burrow.providerStateJson;
	if (!state || typeof state !== "object") return null;
	const candidate = (state as { workspaceSource?: unknown }).workspaceSource;
	if (!candidate || typeof candidate !== "object") return null;
	const c = candidate as { kind?: unknown; branch?: unknown };
	if ((c.kind !== "worktree" && c.kind !== "clone") || typeof c.branch !== "string") return null;
	return candidate as MaterializedWorkspaceSource;
}

function projectSlug(projectRoot: string): string {
	const trimmed = projectRoot.replace(/\/+$/, "");
	const last = trimmed.split("/").pop() ?? "project";
	return last.replace(/[^A-Za-z0-9_.-]+/g, "-").toLowerCase() || "project";
}
