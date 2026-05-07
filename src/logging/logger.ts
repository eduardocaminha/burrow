/**
 * pino factory with bound burrow/run/agent context (SPEC §20.2).
 *
 * Auto-detects TTY: pretty in interactive shells, JSON otherwise.
 * Callers should derive child loggers with `.child({ burrowId, runId })`
 * so every log line carries the right correlation keys.
 */

import pino from "pino";

export type Logger = pino.Logger;

export interface CreateLoggerOptions {
	level?: pino.Level;
	pretty?: boolean;
	bindings?: Record<string, unknown>;
	destination?: pino.DestinationStream;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
	const level = options.level ?? (process.env.BURROW_LOG_LEVEL as pino.Level | undefined) ?? "info";
	const pretty = options.pretty ?? process.stdout.isTTY === true;

	const base: pino.LoggerOptions = {
		level,
		base: { ...options.bindings },
	};

	if (pretty && !options.destination) {
		base.transport = {
			target: "pino-pretty",
			options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
		};
		return pino(base);
	}

	return options.destination ? pino(base, options.destination) : pino(base);
}
