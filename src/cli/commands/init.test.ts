import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BURROW_TOML_FILENAME } from "../../config/burrow-toml-loader.ts";
import { ValidationError } from "../../core/errors.ts";
import { parseBurrowToml } from "../../schemas/burrow-toml.ts";
import { renderInitResult, runInitCommand } from "./init.ts";

describe("runInitCommand", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "burrow-init-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("writes a burrow.toml that parses cleanly back via parseBurrowToml", async () => {
		const result = await runInitCommand({ projectRoot });
		expect(result.written).toBe(true);
		expect(existsSync(join(projectRoot, BURROW_TOML_FILENAME))).toBe(true);
		const raw = readFileSync(join(projectRoot, BURROW_TOML_FILENAME), "utf8");
		const parsed = parseBurrowToml(raw);
		expect(parsed.ok).toBe(true);
		expect(parsed.config?.project?.name).toBe(result.source.split("/").at(-2));
	});

	test("dry-run emits contents without writing", async () => {
		const result = await runInitCommand({ projectRoot, dryRun: true });
		expect(result.written).toBe(false);
		expect(existsSync(join(projectRoot, BURROW_TOML_FILENAME))).toBe(false);
		expect(result.contents).toContain("[sandbox]");
	});

	test("detects toolchains from project signals", async () => {
		writeFileSync(join(projectRoot, "package.json"), `{"name":"x"}`);
		writeFileSync(join(projectRoot, "bun.lock"), `{}`);
		writeFileSync(join(projectRoot, "pyproject.toml"), ``);
		const result = await runInitCommand({ projectRoot });
		expect(result.detected.hasNode).toBe(true);
		expect(result.detected.hasBun).toBe(true);
		expect(result.detected.hasPython).toBe(true);
		expect(result.contents).toContain(`bun = "1.1"`);
		expect(result.contents).toContain(`node = ">=20"`);
		expect(result.contents).toContain(`python = "3.12"`);
	});

	test("refuses to overwrite an existing burrow.toml without --force", async () => {
		writeFileSync(join(projectRoot, BURROW_TOML_FILENAME), `[project]\nname = "x"\n`);
		await expect(runInitCommand({ projectRoot })).rejects.toBeInstanceOf(ValidationError);
	});

	test("--force overwrites an existing file", async () => {
		writeFileSync(join(projectRoot, BURROW_TOML_FILENAME), `# old\n`);
		const result = await runInitCommand({ projectRoot, force: true, name: "fresh" });
		expect(result.written).toBe(true);
		const raw = readFileSync(join(projectRoot, BURROW_TOML_FILENAME), "utf8");
		expect(raw).toContain(`name = "fresh"`);
	});
});

describe("renderInitResult", () => {
	test("written result mentions the source path + next-step hint", () => {
		const out = renderInitResult({
			source: "/x/burrow.toml",
			contents: "...",
			written: true,
			detected: { hasNode: true, hasBun: false, hasPython: false, hasRust: false, hasGo: false },
		});
		expect(out).toContain("/x/burrow.toml");
		expect(out).toContain("burrow doctor");
		expect(out).toContain("node");
	});

	test("dry-run result mentions (dry-run)", () => {
		const out = renderInitResult({
			source: "/x/burrow.toml",
			contents: "...",
			written: false,
			detected: { hasNode: false, hasBun: false, hasPython: false, hasRust: false, hasGo: false },
		});
		expect(out).toContain("dry-run");
	});
});
