import { describe, expect, test } from "bun:test";
import { resolvePaths } from "./paths.ts";

describe("resolvePaths", () => {
	test("linux defaults follow XDG", () => {
		const p = resolvePaths({ platform: "linux", home: "/home/u", env: {} });
		expect(p.dataDir).toBe("/home/u/.local/share/burrow");
		expect(p.configDir).toBe("/home/u/.config/burrow");
		expect(p.cacheDir).toBe("/home/u/.cache/burrow");
		expect(p.dbPath).toBe("/home/u/.local/share/burrow/db.sqlite");
		expect(p.archiveDir).toBe("/home/u/.local/share/burrow/archive");
		expect(p.projectsDir).toBe("/home/u/.local/share/burrow/projects");
		expect(p.secretsDir).toBe("/home/u/.config/burrow/secrets");
		expect(p.logsDir).toBe("/home/u/.cache/burrow/logs");
	});

	test("macOS defaults use Library", () => {
		const p = resolvePaths({ platform: "darwin", home: "/Users/u", env: {} });
		expect(p.dataDir).toBe("/Users/u/Library/Application Support/burrow");
		expect(p.cacheDir).toBe("/Users/u/Library/Caches/burrow");
		expect(p.configDir).toBe("/Users/u/.config/burrow");
	});

	test("XDG env wins over platform default", () => {
		const p = resolvePaths({
			platform: "linux",
			home: "/home/u",
			env: {
				XDG_DATA_HOME: "/data",
				XDG_CONFIG_HOME: "/cfg",
				XDG_CACHE_HOME: "/cache",
			},
		});
		expect(p.dataDir).toBe("/data/burrow");
		expect(p.configDir).toBe("/cfg/burrow");
		expect(p.cacheDir).toBe("/cache/burrow");
	});

	test("BURROW_* env wins over XDG", () => {
		const p = resolvePaths({
			platform: "linux",
			home: "/home/u",
			env: {
				XDG_DATA_HOME: "/data",
				BURROW_DATA_DIR: "/explicit/data",
				BURROW_CONFIG_DIR: "/explicit/cfg",
				BURROW_CACHE_DIR: "/explicit/cache",
			},
		});
		expect(p.dataDir).toBe("/explicit/data");
		expect(p.configDir).toBe("/explicit/cfg");
		expect(p.cacheDir).toBe("/explicit/cache");
	});

	test("explicit options win over env", () => {
		const p = resolvePaths({
			platform: "linux",
			home: "/home/u",
			env: { BURROW_DATA_DIR: "/from/env" },
			dataDir: "/from/option",
		});
		expect(p.dataDir).toBe("/from/option");
	});
});
