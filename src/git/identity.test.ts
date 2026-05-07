import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BURROW_GITCONFIG_FILENAME,
	readHostGitIdentity,
	renderBurrowGitconfig,
	resolveBurrowIdentity,
	writeBurrowGitconfig,
} from "./identity.ts";

describe("identity helpers", () => {
	let home: string;
	let workspace: string;
	let configPath: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "burrow-identity-home-"));
		workspace = mkdtempSync(join(tmpdir(), "burrow-identity-ws-"));
		configPath = join(home, ".gitconfig");
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(workspace, { recursive: true, force: true });
	});

	function isolatedEnv(): Record<string, string | undefined> {
		// Pin git to the temp HOME so the test doesn't depend on the developer's
		// real ~/.gitconfig — and disable system + xdg config sources that could
		// inject conflicting values on CI hosts.
		return {
			HOME: home,
			GIT_CONFIG_GLOBAL: configPath,
			GIT_CONFIG_NOSYSTEM: "1",
			XDG_CONFIG_HOME: join(home, ".config"),
			PATH: process.env.PATH,
		};
	}

	test("readHostGitIdentity returns the host name + email when both are set", async () => {
		writeFileSync(configPath, "[user]\n\tname = Alice Example\n\temail = alice@example.com\n");
		const identity = await readHostGitIdentity({ hostEnv: isolatedEnv() });
		expect(identity).toEqual({ name: "Alice Example", email: "alice@example.com" });
	});

	test("readHostGitIdentity returns null when only one half is configured", async () => {
		writeFileSync(configPath, "[user]\n\tname = OnlyName\n");
		const identity = await readHostGitIdentity({ hostEnv: isolatedEnv() });
		expect(identity).toBeNull();
	});

	test("resolveBurrowIdentity('bot') ignores host config and returns the supplied pair", async () => {
		writeFileSync(configPath, "[user]\n\tname = Should Not Win\n\temail = no@example.com\n");
		const identity = await resolveBurrowIdentity(
			{ mode: "bot", name: "Bot", email: "bot@example.com" },
			{ hostEnv: isolatedEnv() },
		);
		expect(identity).toEqual({ name: "Bot", email: "bot@example.com" });
	});

	test("renderBurrowGitconfig emits a [user] section parseable by git", () => {
		const body = renderBurrowGitconfig({ name: "Alice", email: "alice@example.com" });
		expect(body).toBe("[user]\n\tname = Alice\n\temail = alice@example.com\n");
	});

	test("writeBurrowGitconfig drops .gitconfig.burrow inside the workspace", async () => {
		const result = await writeBurrowGitconfig(workspace, {
			name: "Alice",
			email: "alice@example.com",
		});
		expect(result.configPath).toBe(join(workspace, BURROW_GITCONFIG_FILENAME));
		const text = await Bun.file(result.configPath).text();
		expect(text).toContain("name = Alice");
		expect(text).toContain("email = alice@example.com");
	});
});
