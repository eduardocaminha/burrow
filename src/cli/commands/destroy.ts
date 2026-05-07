/**
 * `burrow destroy <id>...` — tear down workspace + archive events (SPEC §14.4, §16).
 *
 * Six-step flow per SPEC §14.4:
 *   1. Stop (transition active→stopped if needed).
 *   2-4. Archive events / messages / runs (handled by destroyBurrowStorage).
 *   5. Remove the workspace.
 *   6. Mark burrow destroyed + prune live rows (also in destroyBurrowStorage).
 *
 * Workspace removal is a side-effect that the storage layer can't perform on
 * its own — we resolve `MaterializedWorkspaceSource` from the persisted
 * `providerStateJson` and delegate to `removeMaterializedWorkspace`. Failures
 * during workspace removal are recorded but don't prevent the row from being
 * archived; the user can re-run with a manual cleanup if needed.
 */

import type { Burrow } from "../../core/types.ts";
import type { DestroyBurrowResult } from "../../events/destroy.ts";
import type { Client } from "../../lib/client.ts";
import {
	type MaterializedWorkspaceSource,
	type RemoveWorkspaceOptions,
	removeMaterializedWorkspace,
} from "../../provider/local/workspace.ts";

export interface DestroyCommandOptions {
	noArchive?: boolean;
	force?: boolean;
	keepWorkspace?: boolean;
	json?: boolean;
}

export interface DestroyCommandInput {
	client: Client;
	burrowIds: string[];
	options: DestroyCommandOptions;
	/** Test seam: override the workspace remover. */
	removeWorkspace?: (opts: RemoveWorkspaceOptions) => Promise<void>;
}

export interface DestroyCommandOutcome {
	id: string;
	ok: boolean;
	archive: DestroyBurrowResult | null;
	workspaceRemoved: boolean;
	error?: string;
}

export interface DestroyCommandResult {
	outcomes: DestroyCommandOutcome[];
}

export async function runDestroyCommand(input: DestroyCommandInput): Promise<DestroyCommandResult> {
	const remover = input.removeWorkspace ?? removeMaterializedWorkspace;
	const outcomes: DestroyCommandOutcome[] = [];

	for (const id of input.burrowIds) {
		const outcome: DestroyCommandOutcome = {
			id,
			ok: false,
			archive: null,
			workspaceRemoved: false,
		};
		try {
			const burrow = input.client.burrows.get(id);
			if (burrow.state === "destroyed") {
				outcome.ok = true;
				outcomes.push(outcome);
				continue;
			}
			if (burrow.state === "active") {
				input.client.burrows.stop(id);
			}
			if (!input.options.keepWorkspace) {
				outcome.workspaceRemoved = await tryRemoveWorkspace(burrow, remover, input.options.force);
			}
			outcome.archive = await input.client.burrows.destroy(id, {
				archive: !input.options.noArchive,
			});
			outcome.ok = true;
		} catch (err) {
			outcome.error = err instanceof Error ? err.message : String(err);
		}
		outcomes.push(outcome);
	}

	return { outcomes };
}

async function tryRemoveWorkspace(
	burrow: Burrow,
	remover: (opts: RemoveWorkspaceOptions) => Promise<void>,
	force: boolean | undefined,
): Promise<boolean> {
	const source = extractWorkspaceSource(burrow);
	if (!source) return false;
	try {
		await remover({
			workspacePath: burrow.workspacePath,
			source,
			...(force !== undefined ? { force } : {}),
		});
		return true;
	} catch {
		return false;
	}
}

function extractWorkspaceSource(burrow: Burrow): MaterializedWorkspaceSource | null {
	const state = burrow.providerStateJson;
	if (!state || typeof state !== "object") return null;
	const candidate = (state as { workspaceSource?: unknown }).workspaceSource;
	if (!candidate || typeof candidate !== "object") return null;
	const c = candidate as { kind?: unknown; branch?: unknown };
	if ((c.kind !== "worktree" && c.kind !== "clone") || typeof c.branch !== "string") return null;
	return candidate as MaterializedWorkspaceSource;
}

export function renderDestroyResult(result: DestroyCommandResult): string {
	return result.outcomes
		.map((o) => {
			if (!o.ok) return `✗ ${o.id}: ${o.error ?? "failed"}`;
			const ws = o.workspaceRemoved ? "workspace removed" : "workspace kept";
			const archive = o.archive?.archived ? "archived" : "no archive";
			return `✓ ${o.id} destroyed (${ws}, ${archive})`;
		})
		.join("\n");
}
