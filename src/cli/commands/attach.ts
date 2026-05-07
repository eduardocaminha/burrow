/**
 * `burrow attach <id>` — re-activate a stopped burrow (SPEC §16).
 *
 * Just flips state stopped→active so the run loop can pick it up again. The
 * workspace already exists (it's never removed by `burrow stop`), so there's
 * no materialization to redo. Destroyed burrows can't be attached — the
 * workspace and event archive are gone.
 */

import { ValidationError } from "../../core/errors.ts";
import type { Burrow } from "../../core/types.ts";
import type { Client } from "../../lib/client.ts";

export interface AttachCommandOptions {
	json?: boolean;
}

export interface AttachCommandInput {
	client: Client;
	burrowId: string;
	options: AttachCommandOptions;
}

export interface AttachCommandResult {
	burrow: Burrow;
	wasAlreadyActive: boolean;
}

export function runAttachCommand(input: AttachCommandInput): AttachCommandResult {
	const current = input.client.burrows.get(input.burrowId);
	if (current.state === "destroyed") {
		throw new ValidationError(`cannot attach to destroyed burrow ${current.id}`, {
			recoveryHint: "destroyed burrows are gone — start a fresh one with `burrow up`",
		});
	}
	if (current.state === "active") {
		return { burrow: current, wasAlreadyActive: true };
	}
	const next = input.client.burrows.resume(input.burrowId);
	return { burrow: next, wasAlreadyActive: false };
}

export function renderAttachResult(result: AttachCommandResult): string {
	if (result.wasAlreadyActive) {
		return `- ${result.burrow.id} already active`;
	}
	return `✓ ${result.burrow.id} attached (state: active)`;
}
