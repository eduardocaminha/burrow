/**
 * Read user-scoped secret KV files (SPEC §18.5).
 *
 * Layout (under `${configDir}/secrets/`):
 *   - `global.env`          — applies to every project
 *   - `<project>.env`       — applies to that project's burrows
 *
 * File format is the standard "dotenv" KV shape — one `KEY=value` per line,
 * `#` comments, optional surrounding quotes, blank lines ignored. We
 * deliberately keep this dependency-free instead of pulling in a dotenv
 * package: the format is small enough that an explicit parser is clearer than
 * importing a 500-line library for `KEY=value`.
 *
 * File-not-present is normal — callers expect to call this on every `up` and
 * just receive an empty map.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const GLOBAL_ENV_FILENAME = "global.env";

export interface SecretStoreOptions {
	/** `${configDir}/secrets/` per resolvePaths. */
	secretsDir: string;
	/** Project identifier. Typically the project root's basename. */
	projectId?: string;
}

export interface LoadedSecretFile {
	source: string;
	values: Record<string, string>;
}

export interface SecretStoreResult {
	global: LoadedSecretFile | null;
	project: LoadedSecretFile | null;
	/** `global` first, then `project`, so project values override globals. */
	merged: Record<string, string>;
}

export async function loadSecretStore(opts: SecretStoreOptions): Promise<SecretStoreResult> {
	const global = await readEnvFile(join(opts.secretsDir, GLOBAL_ENV_FILENAME));
	const project = opts.projectId
		? await readEnvFile(join(opts.secretsDir, `${opts.projectId}.env`))
		: null;
	const merged: Record<string, string> = {};
	if (global) Object.assign(merged, global.values);
	if (project) Object.assign(merged, project.values);
	return { global, project, merged };
}

export async function readEnvFile(path: string): Promise<LoadedSecretFile | null> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		if (isNodeNotFoundError(err)) return null;
		throw err;
	}
	return { source: path, values: parseDotenv(raw) };
}

/**
 * Minimal dotenv parser. Handles:
 *   - `KEY=value`
 *   - `KEY="value with spaces"` (double quotes)
 *   - `KEY='literal'` (single quotes — no escapes)
 *   - blank lines and `#` comments
 *   - trailing comments after unquoted values (split on first `#`)
 *
 * Returns the last value when a key is repeated (matches dotenv semantics).
 * Lines that don't match `KEY=...` are silently ignored — keeping the parser
 * tolerant of human-edited files.
 */
export function parseDotenv(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of raw.split(/\r?\n/)) {
		const line = rawLine.trimStart();
		if (line.length === 0 || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 1) continue;
		const key = line.slice(0, eq).trim();
		if (!isValidEnvKey(key)) continue;
		let value = line.slice(eq + 1);
		value = stripInlineCommentAndQuote(value);
		out[key] = value;
	}
	return out;
}

function stripInlineCommentAndQuote(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return "";
	const first = trimmed[0];
	if (first === '"' || first === "'") {
		const end = trimmed.lastIndexOf(first);
		if (end > 0) {
			const inner = trimmed.slice(1, end);
			return first === '"' ? unescapeDoubleQuoted(inner) : inner;
		}
	}
	const hash = trimmed.indexOf("#");
	const slice = hash >= 0 ? trimmed.slice(0, hash) : trimmed;
	return slice.trim();
}

function unescapeDoubleQuoted(raw: string): string {
	return raw.replace(/\\(["\\nrt])/g, (_, ch: string) => {
		if (ch === "n") return "\n";
		if (ch === "r") return "\r";
		if (ch === "t") return "\t";
		return ch;
	});
}

function isValidEnvKey(key: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function isNodeNotFoundError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code?: unknown }).code === "ENOENT"
	);
}
