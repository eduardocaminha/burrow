import { describe, expect, test } from "bun:test";
import type { SandboxProfile, SpawnCommand } from "../types.ts";
import { resolveSandboxEnv } from "./env.ts";

function profile(over: Partial<SandboxProfile> = {}): SandboxProfile {
	return {
		workspace: "/ws",
		readOnlyMounts: [],
		network: "none",
		allowedDomains: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: [],
		...over,
	};
}

const cmd = (over: Partial<SpawnCommand> = {}): SpawnCommand => ({
	argv: ["echo", "hi"],
	...over,
});

describe("resolveSandboxEnv", () => {
	test("falls back to /usr/bin:/bin when no toolchain paths are declared", () => {
		const env = resolveSandboxEnv(profile(), cmd(), { homePath: "/ws", hostEnv: {} });
		expect(env.PATH).toBe("/usr/bin:/bin");
	});

	test("prepends toolchainPaths to PATH in declaration order, with the system fallback last", () => {
		const env = resolveSandboxEnv(
			profile({ toolchainPaths: ["/opt/homebrew/bin", "/Users/me/.local/bin"] }),
			cmd(),
			{ homePath: "/ws", hostEnv: {} },
		);
		expect(env.PATH).toBe("/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin:/bin");
	});

	test("dedupes repeated toolchain entries", () => {
		const env = resolveSandboxEnv(
			profile({ toolchainPaths: ["/a/bin", "/a/bin", "/b/bin"] }),
			cmd(),
			{ homePath: "/ws", hostEnv: {} },
		);
		expect(env.PATH).toBe("/a/bin:/b/bin:/usr/bin:/bin");
	});

	test("setEnv.PATH overrides the computed value verbatim", () => {
		const env = resolveSandboxEnv(
			profile({ toolchainPaths: ["/a/bin"], setEnv: { PATH: "/only/this" } }),
			cmd(),
			{ homePath: "/ws", hostEnv: {} },
		);
		expect(env.PATH).toBe("/only/this");
	});

	test("command.env.PATH wins over setEnv.PATH and the toolchain-derived default", () => {
		const env = resolveSandboxEnv(
			profile({ toolchainPaths: ["/a/bin"], setEnv: { PATH: "/setenv/bin" } }),
			cmd({ env: { PATH: "/cmd/bin" } }),
			{ homePath: "/ws", hostEnv: {} },
		);
		expect(env.PATH).toBe("/cmd/bin");
	});

	test("envPassthrough forwards declared host env values; missing hosts are dropped", () => {
		const env = resolveSandboxEnv(
			profile({ envPassthrough: ["ANTHROPIC_API_KEY", "MISSING"] }),
			cmd(),
			{ homePath: "/ws", hostEnv: { ANTHROPIC_API_KEY: "sk-test" } },
		);
		expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
		expect(env.MISSING).toBeUndefined();
	});

	test("HOME comes from options.homePath, not hostEnv", () => {
		const env = resolveSandboxEnv(profile(), cmd(), {
			homePath: "/workspace",
			hostEnv: { HOME: "/host/home" },
		});
		expect(env.HOME).toBe("/workspace");
	});

	test("sshAuthSock auto-exports SSH_AUTH_SOCK", () => {
		const env = resolveSandboxEnv(profile({ sshAuthSock: "/tmp/agent.sock" }), cmd(), {
			homePath: "/ws",
			hostEnv: {},
		});
		expect(env.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
	});
});
