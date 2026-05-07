/**
 * `burrow list` — surface every known burrow (SPEC §16).
 *
 * Filters: --kind project|task, --state active|stopped|destroyed, --all
 * defaults to non-destroyed when no state filter is set. Pretty mode emits
 * a TTY-friendly table; --json emits an array of Burrow rows.
 */

import { ValidationError } from "../../core/errors.ts";
import type { Burrow, BurrowKind, BurrowState } from "../../core/types.ts";
import { BURROW_KINDS, BURROW_STATES } from "../../db/schema.ts";
import type { BurrowsClient } from "../../lib/client.ts";

export interface ListCommandOptions {
	all?: boolean;
	kind?: string;
	state?: string;
	json?: boolean;
}

export interface ListCommandInput {
	client: { burrows: BurrowsClient };
	options: ListCommandOptions;
}

export function parseKindFilter(raw: string | undefined): BurrowKind | undefined {
	if (raw === undefined) return undefined;
	if (!(BURROW_KINDS as readonly string[]).includes(raw)) {
		throw new ValidationError(
			`unknown kind '${raw}' — expected one of: ${BURROW_KINDS.join(", ")}`,
		);
	}
	return raw as BurrowKind;
}

export function parseStateFilter(raw: string | undefined): BurrowState | undefined {
	if (raw === undefined) return undefined;
	if (!(BURROW_STATES as readonly string[]).includes(raw)) {
		throw new ValidationError(
			`unknown state '${raw}' — expected one of: ${BURROW_STATES.join(", ")}`,
		);
	}
	return raw as BurrowState;
}

export function runListCommand(input: ListCommandInput): Burrow[] {
	const filter: { kind?: BurrowKind; state?: BurrowState } = {};
	const kind = parseKindFilter(input.options.kind);
	const state = parseStateFilter(input.options.state);
	if (kind) filter.kind = kind;
	if (state) filter.state = state;

	let rows = input.client.burrows.list(filter);
	if (!input.options.all && !state) {
		rows = rows.filter((b) => b.state !== "destroyed");
	}
	return rows;
}

export function renderListTable(rows: Burrow[]): string {
	if (rows.length === 0) return "no burrows.";
	const header = ["ID", "KIND", "STATE", "NAME", "BRANCH", "PROJECT"];
	const data = rows.map((b) => [b.id, b.kind, b.state, b.name ?? "-", b.branch, b.projectRoot]);
	const widths = header.map((h, i) =>
		Math.max(h.length, ...data.map((row) => (row[i] ?? "").length)),
	);
	const fmt = (cells: string[]): string =>
		cells
			.map((c, i) => c.padEnd(widths[i] ?? c.length))
			.join("  ")
			.trimEnd();
	const lines = [fmt(header), ...data.map(fmt)];
	return lines.join("\n");
}
