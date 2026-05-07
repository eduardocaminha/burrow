import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretResolutionError, ValidationError } from "../../core/errors.ts";
import { Client } from "../../lib/client.ts";
import type {
	MaterializedWorkspace,
	MaterializeProjectOptions,
} from "../../provider/local/workspace.ts";
import { type OpReadFn, OpResolver } from "../../secrets/op.ts";
import { parseNetworkPolicy, renderUpResult, runUpCommand } from "./up.ts";

describe("parseNetworkPolicy", () => {
	test("defaults to none", () => {
		expect(parseNetworkPolicy(undefined)).toBe("none");
	});
	test("rejects unknown values", () => {
		expect(() => parseNetworkPolicy("bogus")).toThrow(ValidationError);
	});
});

describe("runUpCommand", () => {
	let dataDir: string;
	let client: Client;
	let materializerCalls: MaterializeProjectOptions[];

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-up-"));
		client = await Client.open({ dataDir, configDir: dataDir });
		materializerCalls = [];
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	const fakeMaterializer = async (
		opts: MaterializeProjectOptions,
	): Promise<MaterializedWorkspace> => {
		materializerCalls.push(opts);
		return {
			workspacePath: opts.workspacePath,
			source: { kind: "worktree", branch: opts.branch, hostClonePath: "/host" },
			identity: null,
		};
	};

	test("creates a project burrow row with the materialized workspace", async () => {
		const result = await runUpCommand({
			client,
			projectRoot: "/repos/web-app",
			options: { name: "web", branch: "feature/x" },
			materializer: fakeMaterializer,
		});
		expect(result.burrow.kind).toBe("project");
		expect(result.burrow.name).toBe("web");
		expect(result.burrow.branch).toBe("feature/x");
		expect(result.burrow.workspacePath).toContain(result.burrow.id);
		expect(materializerCalls).toHaveLength(1);
		expect(materializerCalls[0]?.branch).toBe("feature/x");

		const row = client.burrows.get(result.burrow.id);
		expect(row.id).toBe(result.burrow.id);
		expect(row.providerStateJson).toMatchObject({
			workspaceSource: { kind: "worktree" },
		});
	});

	test("auto-generates a per-burrow branch when --branch is omitted", async () => {
		const result = await runUpCommand({
			client,
			projectRoot: "/repos/web-app",
			options: {},
			materializer: fakeMaterializer,
		});
		expect(result.burrow.branch.startsWith("burrow/")).toBe(true);
	});

	test("defaults to network=none with no toolchain mounts", async () => {
		const result = await runUpCommand({
			client,
			projectRoot: "/repos/web-app",
			options: {},
			materializer: fakeMaterializer,
		});
		const profile = result.burrow.profileJson as { network: string; toolchainPaths: unknown[] };
		expect(profile.network).toBe("none");
		expect(profile.toolchainPaths).toEqual([]);
	});

	test("renderUpResult prints the human summary", async () => {
		const result = await runUpCommand({
			client,
			projectRoot: "/repos/web-app",
			options: {},
			materializer: fakeMaterializer,
		});
		const out = renderUpResult(result);
		expect(out).toContain("up");
		expect(out).toContain(result.burrow.id);
	});
});

describe("runUpCommand — Phase 8 burrow.toml integration", () => {
	let dataDir: string;
	let projectRoot: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-up-p8-"));
		projectRoot = mkdtempSync(join(tmpdir(), "burrow-up-p8-proj-"));
		client = await Client.open({ dataDir, configDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(projectRoot, { recursive: true, force: true });
	});

	const fakeMaterializer = async (
		opts: MaterializeProjectOptions,
	): Promise<MaterializedWorkspace> => ({
		workspacePath: opts.workspacePath,
		source: { kind: "worktree", branch: opts.branch, hostClonePath: "/host" },
		identity: null,
	});

	test("loads burrow.toml: sandbox/network and project name lift onto the profile + burrow row", async () => {
		writeFileSync(
			join(projectRoot, "burrow.toml"),
			`
[project]
name = "web-app"
default_branch = "develop"

[sandbox]
network = "restricted"
allowed_domains = ["github.com"]
timeout_minutes = 30
memory_limit_mb = 4096
cpu_limit = 1.5
`,
		);
		const result = await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
		});
		expect(result.burrow.name).toBe("web-app");
		const profile = result.burrow.profileJson as {
			network: string;
			allowedDomains: string[];
			timeoutMs?: number;
			memoryLimitMb?: number;
			cpuLimit?: number;
		};
		expect(profile.network).toBe("restricted");
		expect(profile.allowedDomains).toEqual(["github.com"]);
		expect(profile.timeoutMs).toBe(30 * 60_000);
		expect(profile.memoryLimitMb).toBe(4096);
		expect(profile.cpuLimit).toBe(1.5);
	});

	test("CLI --network flag overrides burrow.toml [sandbox].network", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[sandbox]\nnetwork = "restricted"\n`);
		const result = await runUpCommand({
			client,
			projectRoot,
			options: { network: "open" },
			materializer: fakeMaterializer,
			skipDoctor: true,
		});
		const profile = result.burrow.profileJson as { network: string };
		expect(profile.network).toBe("open");
	});

	test("[env].defaults + host env land in profile.setEnv", async () => {
		writeFileSync(
			join(projectRoot, "burrow.toml"),
			`
[env]
required = ["DATABASE_URL"]
optional = ["LOG_LEVEL"]

[env.defaults]
NODE_ENV = "test"
LOG_LEVEL = "info"
`,
		);
		const result = await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
			hostEnv: { DATABASE_URL: "postgres://h" },
		});
		const profile = result.burrow.profileJson as { setEnv: Record<string, string> };
		expect(profile.setEnv.DATABASE_URL).toBe("postgres://h");
		expect(profile.setEnv.NODE_ENV).toBe("test");
		expect(profile.setEnv.LOG_LEVEL).toBe("info");
		expect(result.resolvedEnv).toEqual(profile.setEnv);
	});

	test("op:// secrets are resolved via the injected OpResolver", async () => {
		writeFileSync(
			join(projectRoot, "burrow.toml"),
			`
[secrets]
API_KEY = "op://Eng/web/api-key"
`,
		);
		const fake: OpReadFn = async ({ ref }) => {
			if (ref === "op://Eng/web/api-key") return { exitCode: 0, stdout: "abc-123", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "miss" };
		};
		const result = await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: fakeMaterializer,
			skipDoctor: true,
			opResolver: new OpResolver({ read: fake }),
		});
		const profile = result.burrow.profileJson as { setEnv: Record<string, string> };
		expect(profile.setEnv.API_KEY).toBe("abc-123");
	});

	test("missing required env throws SecretResolutionError without creating a burrow row", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[env]\nrequired = ["MUST_HAVE"]\n`);
		await expect(
			runUpCommand({
				client,
				projectRoot,
				options: {},
				materializer: fakeMaterializer,
				skipDoctor: true,
				hostEnv: {},
			}),
		).rejects.toBeInstanceOf(SecretResolutionError);
		expect(client.burrows.list({}).length).toBe(0);
	});

	test("doctor failure (toolchain mismatch) blocks `up` with a ValidationError", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[toolchain]\nbun = ">=999.0"\n`);
		await expect(
			runUpCommand({
				client,
				projectRoot,
				options: {},
				materializer: fakeMaterializer,
				doctorRunner: async () => ({
					platform: "linux",
					ok: false,
					checks: [
						{
							name: "toolchain.bun >=999.0",
							status: "fail",
							detail: "wanted >=999.0, found 1.1.30",
						},
					],
				}),
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(client.burrows.list({}).length).toBe(0);
	});

	test("default_branch from burrow.toml is used when --base-branch is omitted", async () => {
		writeFileSync(join(projectRoot, "burrow.toml"), `[project]\ndefault_branch = "trunk"\n`);
		let captured: MaterializeProjectOptions | undefined;
		await runUpCommand({
			client,
			projectRoot,
			options: {},
			materializer: async (opts) => {
				captured = opts;
				return fakeMaterializer(opts);
			},
			skipDoctor: true,
		});
		expect(captured?.baseBranch).toBe("trunk");
	});
});
