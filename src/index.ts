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
export { generateId, type IdKind, isId } from "./core/ids.ts";
export {
	assertBurrowTransition,
	assertRunTransition,
	BURROW_TERMINAL_STATES,
	canTransitionBurrow,
	canTransitionRun,
	RUN_TERMINAL_STATES,
} from "./core/state-machine.ts";
export {
	type Burrow,
	type BurrowKind,
	type BurrowState,
	type EventStream,
	eventRowToEvent,
	type Message,
	type MessagePriority,
	type MessageState,
	type Run,
	type RunEvent,
	type RunState,
} from "./core/types.ts";
export { type BurrowDb, type OpenDatabaseOptions, openDatabase } from "./db/client.ts";
export {
	CRASH_ERROR_MESSAGE,
	type RecoverySweepResult,
	runStartupRecovery,
} from "./db/recovery.ts";
export {
	BurrowsRepo,
	createRepos,
	EventsRepo,
	MessagesRepo,
	MetaRepo,
	type Repos,
	RunsRepo,
} from "./db/repos/index.ts";
export { detectSshAgent, type SshAgentPassthrough } from "./git/ssh.ts";
export { createLogger, type Logger } from "./logging/logger.ts";
export { buildBwrapArgv, SYSTEM_RO_MOUNTS } from "./provider/local/bwrap.ts";
export { type RunSandboxedOptions, runSandboxed } from "./provider/local/sandbox.ts";
export {
	buildSeatbeltArgv,
	buildSeatbeltProfile,
	SYSTEM_READ_SUBPATHS,
} from "./provider/local/seatbelt.ts";
export type {
	NetworkPolicy,
	SandboxProfile,
	SpawnCommand,
	SpawnResult,
} from "./provider/types.ts";
export {
	type RunHandler,
	type RunHandlerContext,
	RunLoop,
	type RunLoopOptions,
	type RunOutcome,
} from "./runner/run-loop.ts";
