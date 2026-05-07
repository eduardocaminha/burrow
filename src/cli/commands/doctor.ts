/**
 * `burrow doctor` — Phase 8 health check (SPEC §19, §22).
 *
 * Layered checks:
 *   - Platform support + sandbox primitive on PATH (Phase 0 stub, retained).
 *   - Resolved data/config/cache/secrets/projects directories.
 *   - When run inside a project (or with --project <root>):
 *     - Validate `burrow.toml` (parse errors surface here, not at `up` time).
 *     - Run [toolchain] checks against host binaries.
 *     - If `[secrets]` declares any op:// refs, verify the `op` CLI exists.
 *
 * `burrow up` calls `runDoctor({ projectRoot, requireProjectConfig: false })`
 * before sandbox launch and refuses to proceed when any check fails.
 */

import { platform } from "node:os";
import { BURROW_TOML_FILENAME, loadBurrowToml } from "../../config/burrow-toml-loader.ts";
import { resolvePaths } from "../../config/paths.ts";
import { type BurrowError, SandboxPrimitiveMissing, ValidationError } from "../../core/errors.ts";
import type { BurrowToml } from "../../schemas/burrow-toml.ts";
import { OpResolver } from "../../secrets/op.ts";
import {
	checkToolchains,
	type ToolchainCheckResult,
	type ToolchainCheckSummary,
	type ToolchainProbe,
} from "../../toolchain/check.ts";
import { icon } from "../style.ts";

export type DoctorCheckStatus = "ok" | "fail" | "warn";

export interface DoctorCheck {
	name: string;
	status: DoctorCheckStatus;
	detail: string;
}

export interface DoctorReport {
	platform: NodeJS.Platform;
	checks: DoctorCheck[];
	ok: boolean;
	/** Source path of burrow.toml when one was found + parsed cleanly. */
	burrowTomlSource?: string;
	/** Toolchain rows when [toolchain] was present. */
	toolchain?: ToolchainCheckSummary;
}

export interface RunDoctorOptions {
	/** Resolve `burrow.toml` from this directory. Defaults to skipping the load. */
	projectRoot?: string;
	/** Inject a custom toolchain probe (tests). */
	toolchainProbe?: ToolchainProbe;
	/** Inject a custom binary-on-PATH probe (tests). Defaults to `command -v`. */
	binaryProbe?: (name: string) => Promise<boolean>;
}

const SUCCESS_MARK = (s: string): string => `${icon("ok")} ${s}`;
const FAIL_MARK = (s: string): string => `${icon("fail")} ${s}`;
const WARN_MARK = (s: string): string => `${icon("warn")} ${s}`;

export async function runDoctor(opts: RunDoctorOptions = {}): Promise<DoctorReport> {
	const plat = platform();
	const paths = resolvePaths();
	const binaryOnPath = opts.binaryProbe ?? defaultBinaryOnPath;

	const sandboxBin = plat === "darwin" ? "sandbox-exec" : "bwrap";
	const sandboxOk = await binaryOnPath(sandboxBin);

	const checks: DoctorCheck[] = [
		{
			name: "platform",
			status: plat === "linux" || plat === "darwin" ? "ok" : "fail",
			detail: plat,
		},
		{
			name: `sandbox primitive (${sandboxBin})`,
			status: sandboxOk ? "ok" : "fail",
			detail: sandboxOk ? "found on PATH" : "missing — install before `burrow up`",
		},
		{ name: "data dir", status: "ok", detail: paths.dataDir },
		{ name: "config dir", status: "ok", detail: paths.configDir },
		{ name: "cache dir", status: "ok", detail: paths.cacheDir },
	];

	const report: DoctorReport = { platform: plat, checks, ok: true };

	if (opts.projectRoot !== undefined) {
		await runProjectChecks({
			report,
			projectRoot: opts.projectRoot,
			toolchainProbe: opts.toolchainProbe,
			binaryOnPath,
		});
	}

	report.ok = !report.checks.some((c) => c.status === "fail");
	return report;
}

interface ProjectChecksContext {
	report: DoctorReport;
	projectRoot: string;
	toolchainProbe?: ToolchainProbe;
	binaryOnPath: (name: string) => Promise<boolean>;
}

async function runProjectChecks(ctx: ProjectChecksContext): Promise<void> {
	const { report, projectRoot, toolchainProbe, binaryOnPath } = ctx;
	let loaded: BurrowToml | null = null;
	try {
		const result = await loadBurrowToml(projectRoot);
		if (result === null) {
			report.checks.push({
				name: BURROW_TOML_FILENAME,
				status: "warn",
				detail: `none found in ${projectRoot} — running with built-in defaults`,
			});
			return;
		}
		loaded = result.config;
		report.burrowTomlSource = result.source;
		report.checks.push({
			name: BURROW_TOML_FILENAME,
			status: "ok",
			detail: result.source,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		report.checks.push({
			name: BURROW_TOML_FILENAME,
			status: "fail",
			detail: firstLineOf(message),
		});
		return;
	}

	const summary = await checkToolchains({
		config: loaded,
		...(toolchainProbe ? { probe: toolchainProbe } : {}),
	});
	report.toolchain = summary;
	for (const r of summary.results) {
		report.checks.push(toolchainRowToCheck(r));
	}

	const hasOpRefs = Object.values(loaded.secrets ?? {}).some((v) => OpResolver.isOpRef(v));
	if (hasOpRefs) {
		const opOk = await binaryOnPath("op");
		report.checks.push({
			name: "1Password CLI (op)",
			status: opOk ? "ok" : "fail",
			detail: opOk
				? "found on PATH"
				: "burrow.toml [secrets] uses op:// — install from https://developer.1password.com/docs/cli/get-started/",
		});
	}
}

function toolchainRowToCheck(r: ToolchainCheckResult): DoctorCheck {
	const name = `toolchain.${r.name} ${r.requested}`;
	switch (r.status) {
		case "ok":
			return { name, status: "ok", detail: r.detail };
		case "missing":
		case "version_mismatch":
			return { name, status: "fail", detail: r.detail };
		default:
			return { name, status: "warn", detail: r.detail };
	}
}

export function renderDoctorReport(report: DoctorReport): string {
	const lines = [`burrow doctor — platform: ${report.platform}`];
	for (const check of report.checks) {
		lines.push(`  ${formatCheckLine(check)}`);
	}
	lines.push("");
	lines.push(report.ok ? "All checks passed." : "Some checks failed.");
	return lines.join("\n");
}

function formatCheckLine(check: DoctorCheck): string {
	const head = `${check.name}: ${check.detail}`;
	if (check.status === "ok") return SUCCESS_MARK(head);
	if (check.status === "warn") return WARN_MARK(head);
	return FAIL_MARK(head);
}

export function sandboxPrimitiveMissingError(plat: NodeJS.Platform): SandboxPrimitiveMissing {
	const bin = plat === "darwin" ? "sandbox-exec" : "bwrap";
	return new SandboxPrimitiveMissing(`${bin} is required but was not found on PATH`, {
		recoveryHint:
			plat === "darwin"
				? "sandbox-exec ships with macOS — confirm /usr/bin is on PATH"
				: "install bubblewrap (e.g. `apt install bubblewrap`)",
	});
}

/**
 * Throw a single ValidationError summarising every failed check. Used by
 * `burrow up` to gate sandbox launch on toolchain + config health.
 */
export function assertDoctorOk(report: DoctorReport): void {
	if (report.ok) return;
	const failures = report.checks
		.filter((c) => c.status === "fail")
		.map((c) => `${c.name}: ${c.detail}`);
	if (failures.length === 0) return;
	throw new ValidationError(`burrow doctor failed:\n  ${failures.join("\n  ")}`, {
		recoveryHint: "run `burrow doctor` for details",
	});
}

function firstLineOf(s: string): string {
	const idx = s.indexOf("\n");
	return idx >= 0 ? s.slice(0, idx) : s;
}

async function defaultBinaryOnPath(name: string): Promise<boolean> {
	const proc = Bun.spawn(["sh", "-c", `command -v ${name}`], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const exit = await proc.exited;
	return exit === 0;
}

export type { BurrowError };
