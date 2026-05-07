/**
 * `burrow up` — create + start a project burrow (SPEC §16, §11).
 *
 * V1 minimum (Phase 7): materialize a workspace via `git worktree`/clone,
 * persist a burrow row, return it. Toolchain doctoring + burrow.toml secrets
 * land in Phase 8; for now the user passes flags directly or accepts defaults
 * (no network, ssh-agent passthrough off, no toolchain mounts).
 *
 * The burrow row stores enough state for later phases to pick it up:
 *   - `providerStateJson.workspaceSource` so destroy can remove the worktree.
 *   - `profileJson` so the runner can rebuild the sandbox profile per turn.
 */

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ValidationError } from "../../core/errors.ts";
import { generateId } from "../../core/ids.ts";
import type { Burrow, BurrowKind } from "../../core/types.ts";
import type { Client } from "../../lib/client.ts";
import {
	type MaterializedWorkspace,
	type MaterializeProjectOptions,
	materializeProjectWorkspace,
} from "../../provider/local/workspace.ts";
import type { NetworkPolicy, SandboxProfile } from "../../provider/types.ts";

const DEFAULT_BRANCH_PREFIX = "burrow";
const NETWORK_POLICIES: readonly NetworkPolicy[] = ["none", "restricted", "open"];

export interface UpCommandOptions {
	name?: string;
	branch?: string;
	baseBranch?: string;
	originUrl?: string;
	network?: string;
	provider?: string;
	json?: boolean;
}

export interface UpCommandInput {
	client: Client;
	projectRoot: string;
	options: UpCommandOptions;
	/** Test seam for `materializeProjectWorkspace`. */
	materializer?: (opts: MaterializeProjectOptions) => Promise<MaterializedWorkspace>;
	/** Override the projects base directory. Defaults to `client.paths.projectsDir`. */
	projectsDir?: string;
}

export interface UpCommandResult {
	burrow: Burrow;
	workspace: MaterializedWorkspace;
}

export function parseNetworkPolicy(raw: string | undefined): NetworkPolicy {
	if (raw === undefined) return "none";
	if (!(NETWORK_POLICIES as readonly string[]).includes(raw)) {
		throw new ValidationError(
			`unknown network policy '${raw}' — expected one of: ${NETWORK_POLICIES.join(", ")}`,
		);
	}
	return raw as NetworkPolicy;
}

export async function runUpCommand(input: UpCommandInput): Promise<UpCommandResult> {
	const projectRoot = resolve(input.projectRoot);
	const network = parseNetworkPolicy(input.options.network);
	const provider = input.options.provider ?? "local";

	// Generate the burrow id up front so the workspace path can include it.
	// The id is supplied to BurrowsRepo.create below so insert + workspace
	// dir share the same identifier.
	const burrowId = generateId("burrow");
	const workspacePath = computeWorkspacePath(
		input.projectsDir ?? input.client.paths.projectsDir,
		projectRoot,
		burrowId,
	);
	const branch = input.options.branch ?? `${DEFAULT_BRANCH_PREFIX}/${burrowId}`;

	const materializer = input.materializer ?? materializeProjectWorkspace;
	const matOpts: MaterializeProjectOptions = {
		workspacePath,
		branch,
		createBranch: true,
		baseBranch: input.options.baseBranch ?? "main",
		projectRoot,
	};
	if (input.options.originUrl !== undefined) matOpts.originUrl = input.options.originUrl;
	const workspace = await materializer(matOpts);

	const profile: SandboxProfile = {
		workspace: workspace.workspacePath,
		readOnlyMounts: [],
		network,
		allowedDomains: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: [],
	};

	const providerState = {
		workspaceSource: workspace.source,
		identity: workspace.identity,
	};

	const burrow = input.client.repos.burrows.create({
		id: burrowId,
		kind: "project" satisfies BurrowKind,
		name: input.options.name ?? null,
		projectRoot,
		workspacePath: workspace.workspacePath,
		branch,
		provider,
		providerState,
		profile,
	});

	return { burrow, workspace };
}

export function renderUpResult(result: UpCommandResult): string {
	const lines = [
		`✓ burrow ${result.burrow.id} up`,
		`  branch:    ${result.burrow.branch}`,
		`  workspace: ${result.burrow.workspacePath}`,
		`  source:    ${result.workspace.source.kind}`,
	];
	if (result.workspace.identity) {
		lines.push(
			`  identity:  ${result.workspace.identity.name} <${result.workspace.identity.email}>`,
		);
	}
	return lines.join("\n");
}

function computeWorkspacePath(projectsDir: string, projectRoot: string, burrowId: string): string {
	const slug = projectSlug(projectRoot);
	return join(projectsDir, slug, "workspaces", burrowId);
}

function projectSlug(projectRoot: string): string {
	const trimmed = projectRoot.replace(/\/+$/, "");
	const last = trimmed.split("/").pop() ?? "project";
	return last.replace(/[^A-Za-z0-9_.-]+/g, "-").toLowerCase() || "project";
}

/** Exported helper used by other commands that need to ensure projectsDir exists. */
export async function ensureProjectsDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}
