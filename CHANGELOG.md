# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Phase 0 scaffold: library entry (`src/index.ts`), CLI entry (`src/cli/main.ts`),
  `BurrowError` hierarchy with stable codes and recovery hints, XDG-aware paths
  module, pino logger factory, and a `burrow doctor` stub that checks for the
  platform's sandbox primitive (`bwrap` on Linux, `sandbox-exec` on macOS).
- Phase 7 — public `Client` (lib/client.ts) with the five SPEC §15 namespaces
  (burrows / runs / inbox / events / agents); CLI wiring for `up`, `fork`,
  `attach`, `list`, `show`, `stop`, `destroy`, and `agents list/show/validate`;
  shared style helpers in `src/cli/style.ts` (status icons, TTY-aware color);
  exit codes per SPEC §16 (3 = invalid input, 2 = not found, 4 = sandbox).
