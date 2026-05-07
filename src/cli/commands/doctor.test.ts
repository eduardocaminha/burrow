import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../../core/errors.ts";
import {
	assertDoctorOk,
	type DoctorReport,
	renderDoctorReport,
	runDoctor,
	sandboxPrimitiveMissingError,
} from "./doctor.ts";

describe("doctor — base checks", () => {
	test("runDoctor reports the host platform and resolved paths", async () => {
		const report = await runDoctor();
		expect(report.platform).toBe(process.platform);
		const platCheck = report.checks.find((c) => c.name === "platform");
		expect(platCheck).toBeDefined();
		expect(platCheck?.detail).toBe(process.platform);
		const dataCheck = report.checks.find((c) => c.name === "data dir");
		expect(dataCheck?.status).toBe("ok");
		expect(dataCheck?.detail.length).toBeGreaterThan(0);
	});

	test("renderDoctorReport prints one line per check with status icon", () => {
		const out = renderDoctorReport({
			platform: "linux",
			ok: false,
			checks: [
				{ name: "platform", status: "ok", detail: "linux" },
				{ name: "sandbox primitive (bwrap)", status: "fail", detail: "missing" },
				{ name: "burrow.toml", status: "warn", detail: "none found" },
			],
		});
		expect(out).toContain("platform: linux");
		expect(out).toContain("sandbox primitive (bwrap): missing");
		expect(out).toContain("burrow.toml: none found");
		expect(out).toContain("Some checks failed.");
	});

	test("sandboxPrimitiveMissingError carries a platform-specific hint", () => {
		const linux = sandboxPrimitiveMissingError("linux");
		expect(linux.code).toBe("bwrap_or_sb_missing");
		expect(linux.message).toContain("bwrap");
		expect(linux.recoveryHint).toContain("bubblewrap");

		const mac = sandboxPrimitiveMissingError("darwin");
		expect(mac.message).toContain("sandbox-exec");
		expect(mac.recoveryHint).toContain("/usr/bin");
	});
});

describe("doctor — project-scoped checks", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "burrow-doctor-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("warns when burrow.toml is missing in the project root", async () => {
		const report = await runDoctor({
			projectRoot,
			binaryProbe: async () => true,
		});
		const tomlCheck = report.checks.find((c) => c.name === "burrow.toml");
		expect(tomlCheck?.status).toBe("warn");
		// Warn doesn't break overall ok.
		expect(report.ok).toBe(true);
	});

	test("fails when burrow.toml is malformed", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[sandbox]\nnetwork = "bogus"\n`);
		const report = await runDoctor({
			projectRoot,
			binaryProbe: async () => true,
		});
		const tomlCheck = report.checks.find((c) => c.name === "burrow.toml");
		expect(tomlCheck?.status).toBe("fail");
		expect(report.ok).toBe(false);
	});

	test("runs toolchain checks when [toolchain] is declared", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[toolchain]\nbun = "1.1"\nnode = ">=20"\n`);
		const report = await runDoctor({
			projectRoot,
			binaryProbe: async () => true,
			toolchainProbe: async (binary) => {
				if (binary === "bun") return { resolvedPath: "/x/bun", versionOutput: "1.1.30" };
				if (binary === "node") return { resolvedPath: "/x/node", versionOutput: "v20.0.0" };
				return { resolvedPath: null, versionOutput: null };
			},
		});
		expect(report.toolchain?.ok).toBe(true);
		expect(report.checks.find((c) => c.name === "toolchain.bun 1.1")?.status).toBe("ok");
	});

	test("toolchain mismatch flips overall ok=false", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[toolchain]\nbun = ">=2.0"\n`);
		const report = await runDoctor({
			projectRoot,
			binaryProbe: async () => true,
			toolchainProbe: async () => ({ resolvedPath: "/x/bun", versionOutput: "1.1.30" }),
		});
		expect(report.ok).toBe(false);
		expect(report.checks.find((c) => c.name === "toolchain.bun >=2.0")?.status).toBe("fail");
	});

	test("flags missing 1Password CLI when [secrets] uses op://", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[secrets]\nDB = "op://Eng/db/url"\n`);
		const report = await runDoctor({
			projectRoot,
			binaryProbe: async (n) => n !== "op",
			toolchainProbe: async () => ({ resolvedPath: null, versionOutput: null }),
		});
		const opCheck = report.checks.find((c) => c.name === "1Password CLI (op)");
		expect(opCheck?.status).toBe("fail");
		expect(report.ok).toBe(false);
	});

	test("does not check `op` when [secrets] has only literals", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[secrets]\nLITERAL = "plain-value"\n`);
		const report = await runDoctor({
			projectRoot,
			binaryProbe: async (n) => n !== "op",
		});
		expect(report.checks.find((c) => c.name === "1Password CLI (op)")).toBeUndefined();
	});
});

describe("assertDoctorOk", () => {
	test("returns silently when report is ok", () => {
		const report: DoctorReport = {
			platform: "linux",
			ok: true,
			checks: [{ name: "platform", status: "ok", detail: "linux" }],
		};
		expect(() => assertDoctorOk(report)).not.toThrow();
	});

	test("throws ValidationError listing every failed check", () => {
		const report: DoctorReport = {
			platform: "linux",
			ok: false,
			checks: [
				{ name: "platform", status: "ok", detail: "linux" },
				{ name: "toolchain.bun 1.1", status: "fail", detail: "missing" },
				{ name: "burrow.toml", status: "warn", detail: "none" },
			],
		};
		try {
			assertDoctorOk(report);
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ValidationError);
			const msg = (err as Error).message;
			expect(msg).toContain("toolchain.bun 1.1");
			// warn is not a failure
			expect(msg).not.toContain("burrow.toml: none");
		}
	});
});
