/**
 * @os-eco/burrow-cli — OS-isolated sandbox runtime for coding agents.
 *
 * This module is the public library entry. The CLI lives at src/cli/main.ts
 * and consumes the same surface a programmatic caller would.
 */

export const VERSION = "0.0.0";

export { type BurrowPaths, resolvePaths } from "./config/paths.ts";
export {
	AgentNotInstalled,
	AgentRuntimeError,
	BurrowError,
	CredentialError,
	formatError,
	NotFoundError,
	SandboxError,
	SandboxPrimitiveMissing,
	SecretResolutionError,
	ToolchainMismatch,
	ValidationError,
	WorkspaceMaterializationError,
} from "./core/errors.ts";

export { createLogger, type Logger } from "./logging/logger.ts";
