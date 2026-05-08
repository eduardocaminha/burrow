/**
 * Bearer-token auth for `burrow serve` (pl-5b40 step 4 / acceptance #5).
 *
 * V1 posture is single-user (SPEC §3.2): one bearer token from
 * `BURROW_API_TOKEN`, missing/invalid → 401. The `AuthProvider` seam exists so
 * a future multi-user landing (per-user tokens, OIDC, …) can plug in
 * additively without rewriting handlers — risk #3 in pl-5b40.
 *
 * `--no-auth` is the loopback-only escape hatch. Plumbed through
 * `resolveAuth({ noAuth: true })` from the CLI; the server itself doesn't
 * inspect the flag (auth is an opaque `AuthProvider` to the dispatch layer).
 */

import { timingSafeEqual } from "node:crypto";
import { ValidationError } from "../core/errors.ts";

export interface AuthOk {
	readonly ok: true;
}

export interface AuthDenied {
	readonly ok: false;
	readonly status: number;
	readonly code: string;
	readonly message: string;
	/** Value for the `WWW-Authenticate` header on the 401 response. */
	readonly challenge?: string;
}

export type AuthOutcome = AuthOk | AuthDenied;

export interface AuthProvider {
	/**
	 * Inspect the request and decide whether to allow it. Pure / side-effect
	 * free — never logs the token, never reads outside `request.headers`.
	 */
	authorize(request: Request): AuthOutcome;
}

const ALLOW: AuthOk = { ok: true };

class NoAuthProvider implements AuthProvider {
	authorize(): AuthOutcome {
		return ALLOW;
	}
}

class BearerTokenAuth implements AuthProvider {
	private readonly tokenBytes: Uint8Array;

	constructor(token: string) {
		if (token.length === 0) {
			throw new Error("bearerAuth: token must be a non-empty string");
		}
		this.tokenBytes = new TextEncoder().encode(token);
	}

	authorize(request: Request): AuthOutcome {
		const header = request.headers.get("authorization");
		if (header === null) {
			return {
				ok: false,
				status: 401,
				code: "unauthorized",
				message: "missing Authorization header",
				challenge: 'Bearer realm="burrow"',
			};
		}
		const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
		if (!match?.[1]) {
			return {
				ok: false,
				status: 401,
				code: "unauthorized",
				message: "expected 'Bearer <token>' Authorization header",
				challenge: 'Bearer realm="burrow", error="invalid_request"',
			};
		}
		if (!constantTimeEqualString(match[1], this.tokenBytes)) {
			return {
				ok: false,
				status: 401,
				code: "unauthorized",
				message: "invalid bearer token",
				challenge: 'Bearer realm="burrow", error="invalid_token"',
			};
		}
		return ALLOW;
	}
}

/** Allow every request. Used by `--no-auth` / loopback-only deploys. */
export const NO_AUTH: AuthProvider = new NoAuthProvider();

/** Build an AuthProvider that requires a single bearer token. */
export function bearerAuth(token: string): AuthProvider {
	return new BearerTokenAuth(token);
}

export interface ResolveAuthOptions {
	/** Skip auth entirely (CLI `--no-auth`). Wins over every other field. */
	noAuth?: boolean;
	/** Explicit token (test fixtures, mostly). Wins over env. */
	token?: string;
	/** Environment to read from. Defaults to `process.env`. */
	env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolve auth from the inputs the CLI would pass.
 *
 * Precedence: `noAuth` > `token` > `env.BURROW_API_TOKEN`. Throws
 * `ValidationError` if no token is found and `noAuth` is not set — the CLI
 * surfaces this as exit code 3 (mx-2362a5).
 */
export function resolveAuth(opts: ResolveAuthOptions = {}): AuthProvider {
	if (opts.noAuth) return NO_AUTH;
	const env = opts.env ?? process.env;
	const token = opts.token ?? env.BURROW_API_TOKEN;
	if (token === undefined || token.length === 0) {
		throw new ValidationError("BURROW_API_TOKEN is not set", {
			recoveryHint: "export BURROW_API_TOKEN=<token> or pass --no-auth (loopback only)",
		});
	}
	return bearerAuth(token);
}

function constantTimeEqualString(candidate: string, expected: Uint8Array): boolean {
	const candidateBytes = new TextEncoder().encode(candidate);
	if (candidateBytes.length !== expected.length) return false;
	return timingSafeEqual(candidateBytes, expected);
}
