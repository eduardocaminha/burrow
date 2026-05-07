import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLOBAL_ENV_FILENAME, loadSecretStore, parseDotenv } from "./store.ts";

describe("parseDotenv", () => {
	test("parses bare KEY=value lines", () => {
		expect(parseDotenv("FOO=bar\nBAZ=qux\n")).toEqual({ FOO: "bar", BAZ: "qux" });
	});

	test("ignores comments + blank lines", () => {
		const raw = `
# top comment
FOO=bar

# another
BAZ=qux
`;
		expect(parseDotenv(raw)).toEqual({ FOO: "bar", BAZ: "qux" });
	});

	test("handles double-quoted values with escape sequences", () => {
		expect(parseDotenv(`A="line one\\nline two"\n`)).toEqual({ A: "line one\nline two" });
	});

	test("handles single-quoted values literally (no escapes)", () => {
		expect(parseDotenv(`A='no\\nescape'\n`)).toEqual({ A: "no\\nescape" });
	});

	test("strips trailing inline comments on unquoted values", () => {
		expect(parseDotenv(`KEY=value # inline comment\n`)).toEqual({ KEY: "value" });
	});

	test("does NOT strip # inside a quoted value", () => {
		expect(parseDotenv(`URL="https://example.com/#frag"\n`)).toEqual({
			URL: "https://example.com/#frag",
		});
	});

	test("rejects invalid keys silently", () => {
		expect(parseDotenv(`1BAD=x\nGOOD=y\n`)).toEqual({ GOOD: "y" });
	});

	test("later values override earlier ones (last write wins)", () => {
		expect(parseDotenv(`FOO=one\nFOO=two\n`)).toEqual({ FOO: "two" });
	});
});

describe("loadSecretStore", () => {
	let secretsDir: string;

	beforeEach(() => {
		secretsDir = mkdtempSync(join(tmpdir(), "burrow-secrets-"));
	});

	afterEach(() => {
		rmSync(secretsDir, { recursive: true, force: true });
	});

	test("returns nulls + empty merged map when nothing exists", async () => {
		const res = await loadSecretStore({ secretsDir, projectId: "web" });
		expect(res.global).toBeNull();
		expect(res.project).toBeNull();
		expect(res.merged).toEqual({});
	});

	test("loads global.env only when no projectId is given", async () => {
		writeFileSync(join(secretsDir, GLOBAL_ENV_FILENAME), `GLOBAL_KEY=g\n`);
		const res = await loadSecretStore({ secretsDir });
		expect(res.global?.values).toEqual({ GLOBAL_KEY: "g" });
		expect(res.project).toBeNull();
		expect(res.merged).toEqual({ GLOBAL_KEY: "g" });
	});

	test("project values override globals on the same key", async () => {
		writeFileSync(join(secretsDir, GLOBAL_ENV_FILENAME), `K=global\nONLY_GLOBAL=g\n`);
		writeFileSync(join(secretsDir, `web.env`), `K=project\nONLY_PROJECT=p\n`);
		const res = await loadSecretStore({ secretsDir, projectId: "web" });
		expect(res.merged).toEqual({ K: "project", ONLY_GLOBAL: "g", ONLY_PROJECT: "p" });
	});
});
