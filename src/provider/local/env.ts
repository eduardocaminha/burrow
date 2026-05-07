/**
 * Resolve the env a sandboxed process actually sees: a hardened baseline
 * (HOME, PATH) layered with declared host passthrough, an SSH_AUTH_SOCK
 * derived from the profile when present, profile setEnv overrides, and
 * finally per-command env. Used by both the bwrap and seatbelt wrappers so
 * they stay symmetric.
 *
 * `toolchainPaths` (SPEC §8.4) prepend onto PATH so the sandbox can locate
 * declared toolchains and agent binaries by bare name. The system fallback
 * (`/usr/bin:/bin`) stays at the tail so things like `/bin/sh` keep working
 * even when no toolchain mounts are declared. The override chain still wins
 * — `profile.setEnv.PATH` and `command.env.PATH` replace the computed value
 * verbatim, matching the resolution order documented in SPEC §17.1.
 */

import type { SandboxProfile, SpawnCommand } from "../types.ts";

const SYSTEM_PATH_FALLBACK = "/usr/bin:/bin";

export interface ResolveEnvOptions {
	/** "/workspace" inside bwrap; the host workspace path on macOS. */
	homePath: string;
	/** Used to resolve `envPassthrough` names. */
	hostEnv: Record<string, string | undefined>;
}

export function resolveSandboxEnv(
	profile: SandboxProfile,
	command: SpawnCommand,
	options: ResolveEnvOptions,
): Record<string, string> {
	const out: Record<string, string> = {
		HOME: options.homePath,
		PATH: composePath(profile.toolchainPaths),
	};

	for (const name of profile.envPassthrough) {
		const value = options.hostEnv[name];
		if (value !== undefined) out[name] = value;
	}

	if (profile.sshAuthSock) {
		out.SSH_AUTH_SOCK = profile.sshAuthSock;
	}

	for (const [name, value] of Object.entries(profile.setEnv)) {
		out[name] = value;
	}

	if (command.env) {
		for (const [name, value] of Object.entries(command.env)) {
			out[name] = value;
		}
	}

	return out;
}

function composePath(toolchainPaths: readonly string[]): string {
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const p of toolchainPaths) {
		if (p.length === 0 || seen.has(p)) continue;
		seen.add(p);
		parts.push(p);
	}
	parts.push(SYSTEM_PATH_FALLBACK);
	return parts.join(":");
}
