/**
 * Shared CLI rendering helpers (SPEC §16.1 branding).
 *
 * All renderers go through these helpers so the status icons and color choices
 * stay consistent across commands. Color is opt-in: `colorize` only paints
 * when stdout is a TTY (or when forced via `BURROW_COLOR=1`), so JSON/CI
 * output stays plain — matching SPEC §16.1's "TTY auto-detected" behavior.
 *
 * Status icons (Set D in SPEC §16.1):
 *   - "-"  pending / no-change
 *   - ">"  in-progress
 *   - "x"  cancelled
 *   - "!"  warning / attention
 *   - "✓"  success
 *   - "✗"  failure
 */

import chalk from "chalk";

export type IconKind = "ok" | "fail" | "pending" | "progress" | "cancel" | "warn";

const SYMBOLS: Record<IconKind, string> = {
	ok: "✓",
	fail: "✗",
	pending: "-",
	progress: ">",
	cancel: "x",
	warn: "!",
};

const COLORS: Record<IconKind, (s: string) => string> = {
	ok: chalk.green,
	fail: chalk.red,
	pending: chalk.dim,
	progress: chalk.cyan,
	cancel: chalk.dim,
	warn: chalk.yellow,
};

export interface StyleOptions {
	/** Force color on / off. Default: detect via stdout.isTTY + BURROW_COLOR env. */
	color?: boolean;
}

export function shouldColor(opts: StyleOptions = {}): boolean {
	if (opts.color !== undefined) return opts.color;
	if (process.env.NO_COLOR) return false;
	if (process.env.BURROW_COLOR === "1") return true;
	return Boolean(process.stdout.isTTY);
}

export function icon(kind: IconKind, opts: StyleOptions = {}): string {
	const sym = SYMBOLS[kind];
	return shouldColor(opts) ? COLORS[kind](sym) : sym;
}

export function brandHeader(): string {
	const tag = "burrow — OS-isolated sandbox runtime for coding agents";
	return shouldColor() ? chalk.bold(tag) : tag;
}
