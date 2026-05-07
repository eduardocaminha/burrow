/**
 * Resolve XDG / home / data dirs per SPEC §21.
 *
 * Platform conventions:
 *   - Linux: ~/.local/share/burrow, ~/.config/burrow, ~/.cache/burrow
 *   - macOS: ~/Library/Application Support/burrow, ~/.config/burrow,
 *            ~/Library/Caches/burrow
 *
 * Env overrides (BURROW_DATA_DIR / BURROW_CONFIG_DIR / BURROW_CACHE_DIR) win
 * over XDG, which wins over platform defaults. All paths are absolute.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface BurrowPaths {
	dataDir: string;
	configDir: string;
	cacheDir: string;
	dbPath: string;
	archiveDir: string;
	projectsDir: string;
	secretsDir: string;
	logsDir: string;
}

export interface ResolvePathsOptions {
	dataDir?: string;
	configDir?: string;
	cacheDir?: string;
	env?: Record<string, string | undefined>;
	platform?: NodeJS.Platform;
	home?: string;
}

const APP_NAME = "burrow";

export function resolvePaths(options: ResolvePathsOptions = {}): BurrowPaths {
	const env = options.env ?? process.env;
	const plat = options.platform ?? platform();
	const home = options.home ?? homedir();

	const dataDir =
		options.dataDir ?? env.BURROW_DATA_DIR ?? defaultDataDir(plat, home, env.XDG_DATA_HOME);

	const configDir =
		options.configDir ?? env.BURROW_CONFIG_DIR ?? defaultConfigDir(home, env.XDG_CONFIG_HOME);

	const cacheDir =
		options.cacheDir ?? env.BURROW_CACHE_DIR ?? defaultCacheDir(plat, home, env.XDG_CACHE_HOME);

	return {
		dataDir,
		configDir,
		cacheDir,
		dbPath: join(dataDir, "db.sqlite"),
		archiveDir: join(dataDir, "archive"),
		projectsDir: join(dataDir, "projects"),
		secretsDir: join(configDir, "secrets"),
		logsDir: join(cacheDir, "logs"),
	};
}

function defaultDataDir(plat: NodeJS.Platform, home: string, xdg: string | undefined): string {
	if (xdg) return join(xdg, APP_NAME);
	if (plat === "darwin") return join(home, "Library", "Application Support", APP_NAME);
	return join(home, ".local", "share", APP_NAME);
}

function defaultConfigDir(home: string, xdg: string | undefined): string {
	if (xdg) return join(xdg, APP_NAME);
	return join(home, ".config", APP_NAME);
}

function defaultCacheDir(plat: NodeJS.Platform, home: string, xdg: string | undefined): string {
	if (xdg) return join(xdg, APP_NAME);
	if (plat === "darwin") return join(home, "Library", "Caches", APP_NAME);
	return join(home, ".cache", APP_NAME);
}
