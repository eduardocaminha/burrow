/**
 * `burrow doctor` — Phase 0 stub.
 *
 * Reports platform, resolved paths, and whether the platform's sandbox
 * primitive (bwrap on Linux, sandbox-exec on macOS) is on PATH. Phase 8
 * extends this with toolchain and provider checks per SPEC §22.
 */

import { platform } from "node:os";
import { resolvePaths } from "../../config/paths.ts";
import { SandboxPrimitiveMissing } from "../../core/errors.ts";

export interface DoctorCheck {
	name: string;
	ok: boolean;
	detail: string;
}

export interface DoctorReport {
	platform: NodeJS.Platform;
	checks: DoctorCheck[];
	ok: boolean;
}

export async function runDoctor(): Promise<DoctorReport> {
	const plat = platform();
	const paths = resolvePaths();

	const sandboxBin = plat === "darwin" ? "sandbox-exec" : "bwrap";
	const sandboxOk = await binaryOnPath(sandboxBin);

	const checks: DoctorCheck[] = [
		{ name: "platform", ok: plat === "linux" || plat === "darwin", detail: plat },
		{
			name: `sandbox primitive (${sandboxBin})`,
			ok: sandboxOk,
			detail: sandboxOk ? "found on PATH" : "missing — install before `burrow up`",
		},
		{ name: "data dir", ok: true, detail: paths.dataDir },
		{ name: "config dir", ok: true, detail: paths.configDir },
		{ name: "cache dir", ok: true, detail: paths.cacheDir },
	];

	return {
		platform: plat,
		checks,
		ok: checks.every((c) => c.ok),
	};
}

export function renderDoctorReport(report: DoctorReport): string {
	const lines = [`burrow doctor — platform: ${report.platform}`];
	for (const check of report.checks) {
		const mark = check.ok ? "✓" : "✗";
		lines.push(`  ${mark} ${check.name}: ${check.detail}`);
	}
	lines.push(report.ok ? "\nAll checks passed." : "\nSome checks failed.");
	return lines.join("\n");
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

async function binaryOnPath(name: string): Promise<boolean> {
	const proc = Bun.spawn(["sh", "-c", `command -v ${name}`], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const exit = await proc.exited;
	return exit === 0;
}
