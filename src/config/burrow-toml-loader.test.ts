import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../core/errors.ts";
import { BURROW_TOML_FILENAME, loadBurrowToml } from "./burrow-toml-loader.ts";

describe("loadBurrowToml", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "burrow-toml-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
	});

	test("returns null when burrow.toml is absent", async () => {
		const res = await loadBurrowToml(projectRoot);
		expect(res).toBeNull();
	});

	test("loads + parses a valid burrow.toml", async () => {
		writeFileSync(
			join(projectRoot, BURROW_TOML_FILENAME),
			`[project]\nname = "test-app"\n[toolchain]\nbun = "1.1"\n`,
		);
		const res = await loadBurrowToml(projectRoot);
		expect(res).not.toBeNull();
		expect(res?.config.project?.name).toBe("test-app");
		expect(res?.config.toolchain?.bun).toBe("1.1");
		expect(res?.source).toContain(BURROW_TOML_FILENAME);
	});

	test("throws ValidationError for invalid contents (with source path in message)", async () => {
		writeFileSync(join(projectRoot, BURROW_TOML_FILENAME), `[sandbox]\nnetwork = "bogus"\n`);
		try {
			await loadBurrowToml(projectRoot);
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ValidationError);
			expect((err as Error).message).toContain(BURROW_TOML_FILENAME);
		}
	});
});
