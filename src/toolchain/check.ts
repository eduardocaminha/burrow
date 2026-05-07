/**
 * Toolchain version checks (SPEC §19).
 *
 * `burrow.toml [toolchain]` declares required toolchains and version specs;
 * `checkToolchains` resolves each declared binary on the host PATH, runs
 * `<binary> --version`, and compares against the spec. The result feeds
 * `burrow doctor` (renders a per-toolchain status row) and `burrow up` (must
 * be all-green before sandbox launch — SPEC §19).
 *
 * Version specs accepted in V1:
 *   - bare semver-ish ("20", "1.1", "3.12") → matched as a version *prefix*.
 *     Common case: `bun = "1.1"` should pass for any `1.1.x`.
 *   - `>=X.Y.Z` / `>X.Y.Z` / `=X.Y.Z` → numeric comparison (semver-ish).
 *
 * The spec parser is deliberately small. We're not pretending to be semver:
 * Burrow needs "is this version close enough to what the team agreed on?"
 * and prefix matching covers the long tail without pulling in a 50KB lib.
 */

import {
	type BurrowToml,
	type BurrowTomlToolchainSpec,
	normalizeToolchainSpec,
} from "../schemas/burrow-toml.ts";

export type ToolchainStatus = "ok" | "missing" | "version_mismatch" | "version_unknown";

export interface ToolchainCheckResult {
	/** Logical key from [toolchain] (e.g. "node", "bun"). */
	name: string;
	/** Resolved binary name (defaults to name; overridden via `{binary}`). */
	binary: string;
	/** Version spec from burrow.toml (verbatim). */
	requested: string;
	/** Detected version string (raw `--version` line, trimmed). */
	detected?: string;
	/** Resolved absolute path on host (when present). */
	resolvedPath?: string;
	status: ToolchainStatus;
	/** Human-readable detail, used by doctor renderer. */
	detail: string;
}

export interface ToolchainCheckSummary {
	results: ToolchainCheckResult[];
	ok: boolean;
	missing: ToolchainCheckResult[];
	mismatched: ToolchainCheckResult[];
}

export interface CheckToolchainsInput {
	config: BurrowToml | null;
	probe?: ToolchainProbe;
}

export type ToolchainProbe = (binary: string) => Promise<ToolchainProbeResult>;

export interface ToolchainProbeResult {
	/** Absolute path resolved from PATH, or null when not on PATH. */
	resolvedPath: string | null;
	/** Output of `<binary> --version`, trimmed. Null when probe failed. */
	versionOutput: string | null;
}

export async function checkToolchains(input: CheckToolchainsInput): Promise<ToolchainCheckSummary> {
	const toolchain = input.config?.toolchain ?? {};
	const probe = input.probe ?? defaultToolchainProbe;
	const results: ToolchainCheckResult[] = [];
	for (const [name, spec] of Object.entries(toolchain)) {
		results.push(await checkOne(name, spec, probe));
	}
	const missing = results.filter((r) => r.status === "missing");
	const mismatched = results.filter((r) => r.status === "version_mismatch");
	return {
		results,
		missing,
		mismatched,
		ok: results.every((r) => r.status === "ok"),
	};
}

async function checkOne(
	name: string,
	rawSpec: BurrowTomlToolchainSpec,
	probe: ToolchainProbe,
): Promise<ToolchainCheckResult> {
	const { version, binary } = normalizeToolchainSpec(name, rawSpec);
	const result = await probe(binary);
	if (!result.resolvedPath) {
		return {
			name,
			binary,
			requested: version,
			status: "missing",
			detail: `not on PATH — install ${binary} ${version}`,
		};
	}
	const detected = result.versionOutput ?? "";
	const out: Pick<ToolchainCheckResult, "name" | "binary" | "requested" | "resolvedPath"> = {
		name,
		binary,
		requested: version,
		resolvedPath: result.resolvedPath,
	};
	if (detected.length === 0) {
		return {
			...out,
			status: "version_unknown",
			detail: `found at ${result.resolvedPath} but \`${binary} --version\` returned no output`,
		};
	}
	const versionToken = extractVersionToken(detected);
	if (!versionToken) {
		return {
			...out,
			detected,
			status: "version_unknown",
			detail: `found at ${result.resolvedPath} (could not parse version from "${detected}")`,
		};
	}
	if (versionMatches(versionToken, version)) {
		return {
			...out,
			detected: versionToken,
			status: "ok",
			detail: `found ${versionToken} at ${result.resolvedPath}`,
		};
	}
	return {
		...out,
		detected: versionToken,
		status: "version_mismatch",
		detail: `wanted ${version}, found ${versionToken} at ${result.resolvedPath}`,
	};
}

/**
 * Default probe: `command -v` + `<binary> --version`. Tests inject a fake
 * via the `probe` parameter on `checkToolchains`.
 */
export const defaultToolchainProbe: ToolchainProbe = async (binary) => {
	const resolvedPath = await resolveOnPath(binary);
	if (!resolvedPath) return { resolvedPath: null, versionOutput: null };
	const versionOutput = await runVersion(binary);
	return { resolvedPath, versionOutput };
};

async function resolveOnPath(binary: string): Promise<string | null> {
	const proc = Bun.spawn(["sh", "-c", `command -v ${shellEscape(binary)}`], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (exitCode !== 0) return null;
	const path = out.trim();
	return path.length > 0 ? path : null;
}

async function runVersion(binary: string): Promise<string | null> {
	try {
		const proc = Bun.spawn([binary, "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (exitCode !== 0) return null;
		const combined = (stdout || stderr).trim();
		return combined.length > 0 ? combined : null;
	} catch {
		return null;
	}
}

/**
 * Pull the first dotted-numeric token out of a `--version` line. Handles:
 *   - "1.1.30"
 *   - "v20.10.0"
 *   - "Python 3.12.1"
 *   - "git version 2.43.0"
 */
export function extractVersionToken(line: string): string | null {
	const m = line.match(/(\d+(?:\.\d+){0,3})/);
	return m ? (m[1] ?? null) : null;
}

/**
 * Match a detected version against a spec.
 *   - operators >=, >, =, ==
 *   - bare strings are treated as prefix matches (e.g. "1.1" matches 1.1.x).
 */
export function versionMatches(detected: string, spec: string): boolean {
	const trimmed = spec.trim();
	if (trimmed.length === 0) return true;
	const opMatch = trimmed.match(/^(>=|>|<=|<|==|=)\s*(.+)$/);
	if (opMatch) {
		const op = opMatch[1] ?? "=";
		const rest = (opMatch[2] ?? "").trim();
		const cmp = compareSemver(detected, rest);
		if (cmp === null) return false;
		switch (op) {
			case ">":
				return cmp > 0;
			case ">=":
				return cmp >= 0;
			case "<":
				return cmp < 0;
			case "<=":
				return cmp <= 0;
			default:
				return cmp === 0;
		}
	}
	return detected === trimmed || detected.startsWith(`${trimmed}.`);
}

/**
 * Lexicographic numeric compare. Returns null when the inputs are not
 * numeric-dotted. Treats missing components as zero, so `1.1` ≡ `1.1.0`.
 */
export function compareSemver(a: string, b: string): number | null {
	const ap = a.split(".").map((p) => Number.parseInt(p, 10));
	const bp = b.split(".").map((p) => Number.parseInt(p, 10));
	if (ap.some((n) => Number.isNaN(n))) return null;
	if (bp.some((n) => Number.isNaN(n))) return null;
	const len = Math.max(ap.length, bp.length);
	for (let i = 0; i < len; i++) {
		const av = ap[i] ?? 0;
		const bv = bp[i] ?? 0;
		if (av < bv) return -1;
		if (av > bv) return 1;
	}
	return 0;
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
