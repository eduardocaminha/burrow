/**
 * Resolve `burrow.toml [env]` + `[secrets]` → a concrete `setEnv` map for
 * the sandbox profile (SPEC §17, §18.5).
 *
 * Resolution order, per key (highest → lowest):
 *   1. CLI overrides passed via `overrides`.
 *   2. `burrow.toml [secrets]` literal or `op://...` (resolved via OpResolver).
 *   3. User secret store (`global.env` then `<project>.env`, project wins).
 *   4. Host process env (only for keys named in `[env].required` /
 *      `[env].optional`, so we don't accidentally bleed unrelated host vars).
 *   5. `[env].defaults`.
 *
 * Rules:
 *   - Every key in `[env].required` must resolve to a non-empty value or we
 *     throw `SecretResolutionError`.
 *   - Optional keys missing everywhere are silently dropped.
 *   - `[secrets]` literals starting with `op://` are routed to the resolver;
 *     anything else is taken as a literal string.
 *
 * The output is suitable for `SandboxProfile.setEnv` directly.
 */

import { SecretResolutionError } from "../core/errors.ts";
import type { BurrowToml } from "../schemas/burrow-toml.ts";
import { OpResolver } from "./op.ts";

export interface ResolveEnvInput {
	config: BurrowToml | null;
	/** Merged secrets-store map (output of `loadSecretStore({...}).merged`). */
	secretsStore?: Record<string, string>;
	/** Host process env. Tests pass a minimal map; CLI passes `process.env`. */
	hostEnv?: Record<string, string | undefined>;
	/** CLI-flag overrides. Win over everything else. */
	overrides?: Record<string, string>;
	/** Inject a custom OpResolver (or fake) for tests. */
	op?: OpResolver;
}

export interface ResolveEnvResult {
	/** Final resolved KEY → value map. Empty strings excluded. */
	values: Record<string, string>;
	/** Keys that were declared in [env].required + actually resolved. */
	requiredResolved: string[];
	/** Keys that were declared in [env].optional and resolved. */
	optionalResolved: string[];
	/** [env].optional keys that were missing everywhere (informational). */
	optionalMissing: string[];
}

/**
 * Resolve environment + secrets. Throws `SecretResolutionError` if any
 * required key is missing OR an `op://` lookup fails.
 */
export async function resolveEnv(input: ResolveEnvInput): Promise<ResolveEnvResult> {
	const config = input.config ?? null;
	const secrets = config?.secrets ?? {};
	const envSpec = config?.env ?? {};
	const required = envSpec.required ?? [];
	const optional = envSpec.optional ?? [];
	const defaults = envSpec.defaults ?? {};
	const overrides = input.overrides ?? {};
	const hostEnv = input.hostEnv ?? {};
	const store = input.secretsStore ?? {};
	const op = input.op ?? new OpResolver();

	const values: Record<string, string> = {};

	// Layer 5: defaults (lowest precedence, applied first).
	for (const [k, v] of Object.entries(defaults)) {
		if (v.length > 0) values[k] = v;
	}

	// The set of keys we actively pull from host env. We never copy unrelated
	// host vars into the burrow — that's what envPassthrough is for.
	const hostEnvKeys = new Set<string>([...required, ...optional]);

	// Layer 4: host env for declared required/optional keys.
	for (const k of hostEnvKeys) {
		const hv = hostEnv[k];
		if (typeof hv === "string" && hv.length > 0) values[k] = hv;
	}

	// Layer 3: secrets store (global + project, already merged).
	for (const [k, v] of Object.entries(store)) {
		if (v.length > 0) values[k] = v;
	}

	// Layer 2: [secrets] block — literals or op:// refs.
	const opErrors: string[] = [];
	for (const [k, raw] of Object.entries(secrets)) {
		if (OpResolver.isOpRef(raw)) {
			try {
				const v = await op.resolve(k, raw);
				if (v.length > 0) values[k] = v;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				opErrors.push(msg);
			}
		} else if (raw.length > 0) {
			values[k] = raw;
		}
	}
	if (opErrors.length > 0) {
		throw new SecretResolutionError(
			`failed to resolve ${opErrors.length} secret reference(s):\n  ${opErrors.join("\n  ")}`,
			{ recoveryHint: "see SPEC §18.5 — install `op` or remove the op:// entry" },
		);
	}

	// Layer 1: CLI overrides. Empty string clears the entry (lets users blank
	// out a default at the CLI without editing the file).
	for (const [k, v] of Object.entries(overrides)) {
		if (v.length === 0) {
			delete values[k];
		} else {
			values[k] = v;
		}
	}

	// Required-key gate. Missing required keys collected into one error.
	const missingRequired = required.filter((k) => !(k in values) || values[k]?.length === 0);
	if (missingRequired.length > 0) {
		throw new SecretResolutionError(
			`required env variable(s) not resolved: ${missingRequired.join(", ")}`,
			{
				recoveryHint:
					"set them in [env.defaults], [secrets], the user secrets file under configDir/secrets/<project>.env, or the host shell",
			},
		);
	}

	const requiredResolved = required.filter((k) => k in values);
	const optionalResolved = optional.filter((k) => k in values);
	const optionalMissing = optional.filter((k) => !(k in values));

	return { values, requiredResolved, optionalResolved, optionalMissing };
}
