/**
 * Expand a list of resolved binary paths into the set of host directories
 * that have to be visible inside the sandbox for those binaries to execute
 * (SPEC §8.4, §19).
 *
 * For each binary we contribute two directories:
 *   1. `dirname(path)` — where the binary (or its symlink) lives on PATH.
 *      Mounting this directory is what makes `execvp("claude")` succeed
 *      inside the sandbox: the bare-name lookup needs the directory to be
 *      readable and the entry to be present.
 *   2. `dirname(realpath(path))` — when the PATH entry is a symlink, the
 *      actual binary file lives elsewhere (`~/.local/bin/claude` →
 *      `~/.local/share/claude/versions/2.1.132`). Without admitting that
 *      target directory, the kernel can resolve the symlink but the read
 *      that follows is denied by the sandbox profile.
 *
 * Order is preserved (first-seen wins) so callers can prepend these to PATH
 * deterministically. Falsy/empty inputs are dropped — we only care about
 * paths that actually resolved.
 */

import { realpathSync } from "node:fs";
import { dirname } from "node:path";

export function expandToolchainBinDirs(paths: Iterable<string | null | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of paths) {
		if (!raw) continue;
		const original = dirname(raw);
		if (original.length > 0 && !seen.has(original)) {
			seen.add(original);
			out.push(original);
		}
		const realDir = realpathDirOrNull(raw);
		if (realDir && !seen.has(realDir)) {
			seen.add(realDir);
			out.push(realDir);
		}
	}
	return out;
}

function realpathDirOrNull(path: string): string | null {
	try {
		const resolved = realpathSync(path);
		const dir = dirname(resolved);
		return dir.length > 0 ? dir : null;
	} catch {
		return null;
	}
}
