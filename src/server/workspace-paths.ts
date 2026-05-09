/**
 * Path validation primitive for the workspace-mutation HTTP surface (R-07).
 *
 * `resolveWorkspaceFilePath(workspaceRoot, relPath)` returns the canonical
 * absolute path a handler should read or write, or throws `ValidationError`.
 * The contract is the union of every guard the seed/files endpoints have to
 * apply, so handlers can call this once at the top of the request and use the
 * returned path verbatim.
 *
 * Rejects:
 *   - empty path, NUL bytes, absolute paths
 *   - any `..` segment (no traversal up out of the workspace)
 *   - reserved paths burrow itself owns (`.git`, `.gitconfig.burrow` and any
 *     descendant) — overwriting these would corrupt worktree state or the
 *     per-burrow git identity (SPEC §11, §18.4).
 *   - any symlink anywhere along the resolved path whose realpath escapes
 *     `workspaceRoot`. Both dangling and live symlinks are followed via
 *     `readlink` so we don't depend on `fs.realpath` succeeding.
 *
 * The walk is segment-by-segment from `realpath(workspaceRoot)` down: each
 * existing segment is `lstat`-ed, symlinks are followed manually with a depth
 * cap, and the deepest existing ancestor's canonical form is joined with any
 * remaining (non-existent) trailing segments. This is correct for both reads
 * (where the file should exist) and writes (where the parent may not). Writers
 * MUST still open with `O_NOFOLLOW` to close the TOCTOU window between
 * validation and write — this primitive is the static check, not the write.
 */

import { lstat, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { ValidationError } from "../core/errors.ts";

/**
 * Path entries burrow itself writes into a workspace. Direct writes to these
 * (or any descendant) are rejected so callers can't break worktree state or
 * the per-burrow git identity (`.gitconfig.burrow` is consumed via
 * `GIT_CONFIG_GLOBAL` by every agent runtime).
 */
export const RESERVED_WORKSPACE_ENTRIES: readonly string[] = [".git", ".gitconfig.burrow"];

const MAX_SYMLINK_DEPTH = 40;

export async function resolveWorkspaceFilePath(
	workspaceRoot: string,
	relPath: string,
): Promise<string> {
	if (typeof relPath !== "string" || relPath.length === 0) {
		throw new ValidationError("path is empty");
	}
	if (relPath.includes("\0")) {
		throw new ValidationError("path contains NUL byte");
	}
	if (isAbsolute(relPath)) {
		throw new ValidationError(`path '${relPath}' must be workspace-relative, not absolute`);
	}

	const segments = relPath.split("/").filter((s) => s.length > 0 && s !== ".");
	if (segments.length === 0) {
		throw new ValidationError(`path '${relPath}' resolves to no file`);
	}
	if (segments.some((s) => s === "..")) {
		throw new ValidationError(`path '${relPath}' contains '..' traversal`);
	}

	const normalized = segments.join("/");
	for (const reserved of RESERVED_WORKSPACE_ENTRIES) {
		if (normalized === reserved || normalized.startsWith(`${reserved}/`)) {
			throw new ValidationError(`path '${relPath}' targets reserved workspace entry '${reserved}'`);
		}
	}

	let rootReal: string;
	try {
		rootReal = await realpath(workspaceRoot);
	} catch (err) {
		throw new ValidationError(`workspace root '${workspaceRoot}' is not accessible`, {
			cause: err,
		});
	}

	const canonical = await canonicalize(rootReal, segments, 0);

	if (canonical !== rootReal && !canonical.startsWith(`${rootReal}${sep}`)) {
		throw new ValidationError(`path '${relPath}' escapes workspace root`);
	}
	return canonical;
}

async function canonicalize(
	start: string,
	segments: readonly string[],
	depth: number,
): Promise<string> {
	if (depth > MAX_SYMLINK_DEPTH) {
		throw new ValidationError("too many symlink indirections");
	}
	let cur = start;
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (seg === undefined) continue;
		const next = join(cur, seg);
		let stats: Awaited<ReturnType<typeof lstat>>;
		try {
			stats = await lstat(next);
		} catch (err) {
			if (!isENOENT(err)) throw err;
			return join(cur, ...segments.slice(i));
		}
		if (stats.isSymbolicLink()) {
			const link = await readlink(next);
			const linkTarget = isAbsolute(link) ? link : resolve(cur, link);
			const resolvedTarget = await canonicalizeAbsolute(linkTarget, depth + 1);
			return canonicalize(resolvedTarget, segments.slice(i + 1), depth + 1);
		}
		cur = next;
	}
	return cur;
}

async function canonicalizeAbsolute(target: string, depth: number): Promise<string> {
	const parts = target.split(sep).filter((s) => s.length > 0);
	return canonicalize(sep, parts, depth);
}

function isENOENT(err: unknown): boolean {
	return (
		err !== null &&
		typeof err === "object" &&
		"code" in err &&
		(err as { code: unknown }).code === "ENOENT"
	);
}
