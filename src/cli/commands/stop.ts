/**
 * `burrow stop <id>...` — mark one or more burrows stopped (SPEC §16).
 *
 * Workspace persists; the row stays in the DB. Idempotent for already-stopped
 * burrows so a stale CLI doesn't error on re-run; destroyed burrows are
 * surfaced as a per-id failure but don't abort the batch.
 */

import type { Burrow } from "../../core/types.ts";
import type { Client } from "../../lib/client.ts";

export interface StopCommandOptions {
	json?: boolean;
}

export interface StopCommandInput {
	client: Client;
	burrowIds: string[];
	options: StopCommandOptions;
}

export interface StopCommandOutcome {
	id: string;
	ok: boolean;
	state: Burrow["state"];
	error?: string;
}

export interface StopCommandResult {
	outcomes: StopCommandOutcome[];
}

export function runStopCommand(input: StopCommandInput): StopCommandResult {
	const outcomes: StopCommandOutcome[] = [];
	for (const id of input.burrowIds) {
		try {
			const current = input.client.burrows.get(id);
			if (current.state === "stopped") {
				outcomes.push({ id, ok: true, state: "stopped" });
				continue;
			}
			const next = input.client.burrows.stop(id);
			outcomes.push({ id, ok: true, state: next.state });
		} catch (err) {
			outcomes.push({
				id,
				ok: false,
				state: "active",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return { outcomes };
}

export function renderStopResult(result: StopCommandResult): string {
	return result.outcomes
		.map((o) => (o.ok ? `✓ ${o.id} stopped` : `✗ ${o.id}: ${o.error ?? "failed"}`))
		.join("\n");
}
