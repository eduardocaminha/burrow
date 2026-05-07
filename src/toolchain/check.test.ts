import { describe, expect, test } from "bun:test";
import type { BurrowToml } from "../schemas/burrow-toml.ts";
import {
	checkToolchains,
	compareSemver,
	extractVersionToken,
	type ToolchainProbe,
	type ToolchainProbeResult,
	versionMatches,
} from "./check.ts";

describe("extractVersionToken", () => {
	test("pulls out semver from common --version shapes", () => {
		expect(extractVersionToken("1.1.30")).toBe("1.1.30");
		expect(extractVersionToken("v20.10.0")).toBe("20.10.0");
		expect(extractVersionToken("Python 3.12.1")).toBe("3.12.1");
		expect(extractVersionToken("git version 2.43.0 (Apple Git)")).toBe("2.43.0");
	});

	test("returns null when no numeric token is present", () => {
		expect(extractVersionToken("unknown")).toBeNull();
	});
});

describe("compareSemver", () => {
	test("compares numeric-dotted versions", () => {
		expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
		expect(compareSemver("1.0.1", "1.0.0")).toBe(1);
		expect(compareSemver("1.1", "1.1.0")).toBe(0);
		expect(compareSemver("2.0", "1.99.99")).toBe(1);
	});

	test("returns null for non-numeric inputs", () => {
		expect(compareSemver("abc", "1.0.0")).toBeNull();
		expect(compareSemver("1.0.0", "x.y.z")).toBeNull();
	});
});

describe("versionMatches", () => {
	test("bare spec is treated as prefix", () => {
		expect(versionMatches("1.1.30", "1.1")).toBe(true);
		expect(versionMatches("1.2.0", "1.1")).toBe(false);
		expect(versionMatches("1.1", "1.1")).toBe(true);
	});

	test("operator specs use numeric compare", () => {
		expect(versionMatches("1.1.30", ">=1.1")).toBe(true);
		expect(versionMatches("1.0.0", ">=1.1")).toBe(false);
		expect(versionMatches("1.1.0", "=1.1.0")).toBe(true);
		expect(versionMatches("0.9.0", "<1.0")).toBe(true);
	});
});

describe("checkToolchains", () => {
	function makeProbe(map: Record<string, ToolchainProbeResult>): ToolchainProbe {
		return async (binary: string) => map[binary] ?? { resolvedPath: null, versionOutput: null };
	}

	test("returns ok=true with empty results when [toolchain] is absent", async () => {
		const out = await checkToolchains({ config: { project: { name: "x" } } });
		expect(out.results).toHaveLength(0);
		expect(out.ok).toBe(true);
	});

	test("marks a tool missing when not on PATH", async () => {
		const config: BurrowToml = { toolchain: { node: "20" } };
		const out = await checkToolchains({
			config,
			probe: makeProbe({}),
		});
		expect(out.ok).toBe(false);
		expect(out.results[0]?.status).toBe("missing");
		expect(out.missing).toHaveLength(1);
	});

	test("marks a tool ok when version matches the prefix spec", async () => {
		const config: BurrowToml = { toolchain: { bun: "1.1" } };
		const out = await checkToolchains({
			config,
			probe: makeProbe({
				bun: { resolvedPath: "/usr/local/bin/bun", versionOutput: "1.1.30" },
			}),
		});
		expect(out.ok).toBe(true);
		expect(out.results[0]?.status).toBe("ok");
		expect(out.results[0]?.detected).toBe("1.1.30");
	});

	test("marks a tool version_mismatch when version is too low", async () => {
		const config: BurrowToml = { toolchain: { bun: ">=1.2" } };
		const out = await checkToolchains({
			config,
			probe: makeProbe({
				bun: { resolvedPath: "/x/bun", versionOutput: "v1.1.30" },
			}),
		});
		expect(out.ok).toBe(false);
		expect(out.results[0]?.status).toBe("version_mismatch");
		expect(out.mismatched).toHaveLength(1);
		expect(out.results[0]?.detail).toContain(">=1.2");
		expect(out.results[0]?.detail).toContain("1.1.30");
	});

	test("respects an explicit binary override on the toolchain entry", async () => {
		const config: BurrowToml = {
			toolchain: { node: { version: "20", binary: "node20" } },
		};
		const out = await checkToolchains({
			config,
			probe: async (binary) => {
				expect(binary).toBe("node20");
				return { resolvedPath: "/opt/node20", versionOutput: "v20.0.0" };
			},
		});
		expect(out.ok).toBe(true);
		expect(out.results[0]?.binary).toBe("node20");
	});

	test("flags version_unknown when --version output is unparseable", async () => {
		const config: BurrowToml = { toolchain: { weird: "1" } };
		const out = await checkToolchains({
			config,
			probe: makeProbe({
				weird: { resolvedPath: "/usr/bin/weird", versionOutput: "no version here" },
			}),
		});
		expect(out.results[0]?.status).toBe("version_unknown");
	});
});
