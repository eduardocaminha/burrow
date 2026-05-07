import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../../core/errors.ts";
import { Client } from "../../lib/client.ts";
import { parseKindFilter, parseStateFilter, renderListTable, runListCommand } from "./list.ts";

describe("parseKindFilter", () => {
	test("accepts known kinds", () => {
		expect(parseKindFilter("project")).toBe("project");
		expect(parseKindFilter("task")).toBe("task");
	});
	test("rejects unknown kinds", () => {
		expect(() => parseKindFilter("bogus")).toThrow(ValidationError);
	});
});

describe("parseStateFilter", () => {
	test("rejects unknown states", () => {
		expect(() => parseStateFilter("rotting")).toThrow(ValidationError);
	});
});

describe("runListCommand", () => {
	let dataDir: string;
	let client: Client;

	beforeEach(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "burrow-list-"));
		client = await Client.open({ dataDir, configDir: dataDir });
	});

	afterEach(async () => {
		await client.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("filters out destroyed burrows by default", () => {
		const a = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r",
			workspacePath: "/r/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		const b = client.repos.burrows.create({
			kind: "project",
			projectRoot: "/r2",
			workspacePath: "/r2/.ws",
			branch: "main",
			provider: "local",
			profile: {},
		});
		client.repos.burrows.markDestroyed(b.id);

		const result = runListCommand({ client, options: {} });
		expect(result.map((r) => r.id)).toEqual([a.id]);

		const all = runListCommand({ client, options: { all: true } });
		expect(all.length).toBe(2);
	});
});

describe("renderListTable", () => {
	test("returns 'no burrows.' on empty input", () => {
		expect(renderListTable([])).toBe("no burrows.");
	});
});
