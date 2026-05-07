/**
 * State transitions for runs and burrows (SPEC §10).
 *
 * The run loop and repos call `assertRunTransition` / `assertBurrowTransition`
 * before mutating state so an illegal transition fails loudly instead of
 * corrupting the table. Terminal states are documented per machine.
 */

import { BURROW_STATES, type BurrowState, RUN_STATES, type RunState } from "../db/schema.ts";
import { ValidationError } from "./errors.ts";

const RUN_TRANSITIONS: Record<RunState, ReadonlySet<RunState>> = {
	queued: new Set(["running", "cancelled"]),
	running: new Set(["succeeded", "failed", "cancelled"]),
	succeeded: new Set(),
	failed: new Set(),
	cancelled: new Set(),
};

const BURROW_TRANSITIONS: Record<BurrowState, ReadonlySet<BurrowState>> = {
	active: new Set(["stopped", "destroyed"]),
	stopped: new Set(["active", "destroyed"]),
	destroyed: new Set(),
};

export const RUN_TERMINAL_STATES = new Set<RunState>(["succeeded", "failed", "cancelled"]);
export const BURROW_TERMINAL_STATES = new Set<BurrowState>(["destroyed"]);

export function canTransitionRun(from: RunState, to: RunState): boolean {
	return RUN_TRANSITIONS[from].has(to);
}

export function canTransitionBurrow(from: BurrowState, to: BurrowState): boolean {
	return BURROW_TRANSITIONS[from].has(to);
}

export function assertRunTransition(from: RunState, to: RunState): void {
	if (!canTransitionRun(from, to)) {
		throw new ValidationError(
			`illegal run transition: ${from} → ${to} (allowed from ${from}: ${listAllowed(RUN_TRANSITIONS[from])})`,
		);
	}
}

export function assertBurrowTransition(from: BurrowState, to: BurrowState): void {
	if (!canTransitionBurrow(from, to)) {
		throw new ValidationError(
			`illegal burrow transition: ${from} → ${to} (allowed from ${from}: ${listAllowed(BURROW_TRANSITIONS[from])})`,
		);
	}
}

function listAllowed(set: ReadonlySet<string>): string {
	return set.size === 0 ? "<terminal>" : [...set].join(", ");
}

export type { BurrowState, RunState };
export { BURROW_STATES, RUN_STATES };
