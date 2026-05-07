import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import {
	type BurrowTomlParseResult,
	normalizeToolchainSpec,
	parseBurrowToml,
	parseBurrowTomlOrThrow,
} from "./burrow-toml.ts";

describe("parseBurrowToml", () => {
	test("accepts an empty document — every field is optional", () => {
		const res = parseBurrowToml("");
		expect(res.ok).toBe(true);
		expect(res.config).toEqual({});
	});

	test("parses the SPEC §17 reference example", () => {
		const raw = `
[project]
name = "web-app"
default_branch = "main"
origin = "git@github.com:org/web-app.git"

[sandbox]
network = "restricted"
allowed_domains = ["registry.npmjs.org", "github.com"]
timeout_minutes = 60
memory_limit_mb = 8192
cpu_limit = 2.0

[toolchain]
node = "20"
bun = "1.1"
python = "3.12"

[env]
required = ["DATABASE_URL", "ANTHROPIC_API_KEY"]
optional = ["SENTRY_DSN"]

[env.defaults]
NODE_ENV = "development"
LOG_LEVEL = "info"

[secrets]
DATABASE_URL = "op://Engineering/web-app-dev/db_url"
STRIPE_SECRET_KEY = "op://Engineering/web-app-dev/stripe"

[git]
identity = "user"
read_only_main_branch = true
credentials = "ssh-agent"

[hooks]
post_create = ["bun install"]

[[agents]]
id = "claude-code"

[[agents]]
id = "my-custom-agent"
displayName = "Custom"
command = "./scripts/agent.sh"
args = ["--prompt", "{{prompt}}"]
outputFormat = "raw-text"
promptDelivery = "arg"
`;
		const res = parseBurrowToml(raw);
		expect(res.ok).toBe(true);
		const cfg = res.config;
		expect(cfg?.project?.name).toBe("web-app");
		expect(cfg?.sandbox?.network).toBe("restricted");
		expect(cfg?.sandbox?.allowed_domains).toContain("github.com");
		expect(cfg?.toolchain?.node).toBe("20");
		expect(cfg?.env?.required).toEqual(["DATABASE_URL", "ANTHROPIC_API_KEY"]);
		expect(cfg?.env?.defaults?.NODE_ENV).toBe("development");
		expect(cfg?.secrets?.DATABASE_URL).toBe("op://Engineering/web-app-dev/db_url");
		expect(cfg?.git?.read_only_main_branch).toBe(true);
		expect(cfg?.hooks?.post_create).toEqual(["bun install"]);
		expect(cfg?.agents).toHaveLength(2);
		expect(cfg?.agents?.[0]?.id).toBe("claude-code");
		expect(cfg?.agents?.[1]?.command).toBe("./scripts/agent.sh");
	});

	test("accepts toolchain entries as objects with explicit binary", () => {
		const raw = `
[toolchain]
node = { version = "20", binary = "/opt/homebrew/bin/node" }
bun = "1.1"
`;
		const res = parseBurrowToml(raw);
		expect(res.ok).toBe(true);
		expect(res.config?.toolchain?.node).toEqual({
			version: "20",
			binary: "/opt/homebrew/bin/node",
		});
	});

	test("rejects unknown network policies", () => {
		const res: BurrowTomlParseResult = parseBurrowToml(`
[sandbox]
network = "bogus"
`);
		expect(res.ok).toBe(false);
		expect(res.errors?.[0]?.path).toEqual(["sandbox", "network"]);
	});

	test("rejects unknown top-level keys (catches typos)", () => {
		const res = parseBurrowToml(`
[unknown]
foo = "bar"
`);
		expect(res.ok).toBe(false);
		expect(res.errors?.[0]?.message).toMatch(/unrecognized|unknown/i);
	});

	test("surfaces TOML parse errors with a clear path", () => {
		const res = parseBurrowToml("not = valid = toml");
		expect(res.ok).toBe(false);
		expect(res.errors?.[0]?.message).toMatch(/TOML parse error/);
	});

	test("requires every [[agents]] entry to have an id", () => {
		const res = parseBurrowToml(`
[[agents]]
displayName = "missing-id"
`);
		expect(res.ok).toBe(false);
		expect(res.errors?.[0]?.path).toContain("agents");
	});
});

describe("parseBurrowTomlOrThrow", () => {
	test("returns the parsed config on success", () => {
		const cfg = parseBurrowTomlOrThrow(`[project]\nname = "x"\n`);
		expect(cfg.project?.name).toBe("x");
	});
	test("throws ValidationError with all field errors joined", () => {
		try {
			parseBurrowTomlOrThrow(
				`
[sandbox]
network = "bogus"
[env]
required = "not-an-array"
`,
				"/proj/burrow.toml",
			);
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ValidationError);
			const msg = (err as ValidationError).message;
			expect(msg).toContain("/proj/burrow.toml");
			expect(msg).toContain("sandbox.network");
			expect(msg).toContain("env.required");
		}
	});
});

describe("normalizeToolchainSpec", () => {
	test("string → uses key as binary name", () => {
		expect(normalizeToolchainSpec("bun", "1.1")).toEqual({ version: "1.1", binary: "bun" });
	});
	test("object → respects explicit binary", () => {
		expect(normalizeToolchainSpec("node", { version: "20", binary: "node20" })).toEqual({
			version: "20",
			binary: "node20",
		});
	});
	test("object without binary → falls back to key", () => {
		expect(normalizeToolchainSpec("python", { version: "3.12" })).toEqual({
			version: "3.12",
			binary: "python",
		});
	});
});
