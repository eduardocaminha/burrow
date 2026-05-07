/**
 * Find + load `burrow.toml` for a project root (SPEC §17).
 *
 * `loadBurrowToml(projectRoot)` returns `{ source, config }` when a file is
 * present, or `null` when it's absent (every burrow.toml field is optional —
 * absence means "use built-in defaults").
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type BurrowToml, parseBurrowTomlOrThrow } from "../schemas/burrow-toml.ts";

export const BURROW_TOML_FILENAME = "burrow.toml";

export interface LoadedBurrowToml {
	source: string;
	config: BurrowToml;
}

/**
 * Look for `burrow.toml` directly under `projectRoot`. Returns `null` if the
 * file does not exist; throws `ValidationError` (via parseBurrowTomlOrThrow)
 * for malformed contents.
 *
 * The lookup is deliberately one level deep: walking parents would silently
 * load a sibling project's config when the user runs `burrow up` in a
 * subdirectory, so callers should pass the resolved project root.
 */
export async function loadBurrowToml(projectRoot: string): Promise<LoadedBurrowToml | null> {
	const source = resolve(join(projectRoot, BURROW_TOML_FILENAME));
	let raw: string;
	try {
		raw = await readFile(source, "utf8");
	} catch (err) {
		if (isNodeNotFoundError(err)) return null;
		throw err;
	}
	const config = parseBurrowTomlOrThrow(raw, source);
	return { source, config };
}

function isNodeNotFoundError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code?: unknown }).code === "ENOENT"
	);
}
