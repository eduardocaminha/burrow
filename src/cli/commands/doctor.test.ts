import { describe, expect, test } from "bun:test";
import { renderDoctorReport, runDoctor, sandboxPrimitiveMissingError } from "./doctor.ts";

describe("doctor stub", () => {
	test("runDoctor reports the host platform and resolved paths", async () => {
		const report = await runDoctor();
		expect(report.platform).toBe(process.platform);
		const platCheck = report.checks.find((c) => c.name === "platform");
		expect(platCheck).toBeDefined();
		expect(platCheck?.detail).toBe(process.platform);
		const dataCheck = report.checks.find((c) => c.name === "data dir");
		expect(dataCheck?.ok).toBe(true);
		expect(dataCheck?.detail.length).toBeGreaterThan(0);
	});

	test("renderDoctorReport prints one line per check with status icon", () => {
		const out = renderDoctorReport({
			platform: "linux",
			ok: false,
			checks: [
				{ name: "platform", ok: true, detail: "linux" },
				{ name: "sandbox primitive (bwrap)", ok: false, detail: "missing" },
			],
		});
		expect(out).toContain("✓ platform: linux");
		expect(out).toContain("✗ sandbox primitive (bwrap): missing");
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
