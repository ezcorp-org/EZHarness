/**
 * bus-registry.ts — a tiny indirection so the github-projects poller daemon
 * (`src/integrations/github-projects/daemon.ts`, started from
 * `src/startup/background-timers.ts`) can reach the LIVE conversation SSE
 * bus that lives in the web layer (`$lib/server/context`'s `getBus()`).
 *
 * The import direction forbids the backend from importing the web bus
 * directly, so the web layer REGISTERS a bus-backed `emit` here at init
 * (`ensureInitialized()` → `registerGithubProjectsEmit(...)`), and the
 * daemon-start site reads it back via `getGithubProjectsEmit()` and threads
 * it into the daemon's `opts.emit`. This is the exact pattern established by
 * `preview-bus-registry.ts` and `briefing/runtime-registry.ts`.
 *
 * When nothing has registered (a backend-only boot, or before web init),
 * `getGithubProjectsEmit()` returns `undefined` and the daemon's `emit`
 * defaults to a no-op — a logged-quiet degrade, never a crash. The Hub still
 * refreshes via the approve/dismiss API routes, which emit on the bus they
 * resolve from `getBriefingRuntime()` directly.
 */
import type { GITHUB_PROJECTS_EVENT } from "./types";

/** The Hub-refresh emitter the daemon calls: `emit(EVENT, { projectId })`. */
export type GithubProjectsEmit = (
  event: typeof GITHUB_PROJECTS_EVENT,
  payload: { projectId: string },
) => void;

let registeredEmit: GithubProjectsEmit | null = null;

/**
 * Register the live bus-backed emitter. Called once by the web layer's
 * `ensureInitialized()` after the SSE bus is constructed. Idempotent.
 */
export function registerGithubProjectsEmit(emit: GithubProjectsEmit): void {
  registeredEmit = emit;
}

/** Read the registered emitter, or `undefined` when none is registered yet. */
export function getGithubProjectsEmit(): GithubProjectsEmit | undefined {
  return registeredEmit ?? undefined;
}

/** Test-only: clear the registration. */
export function _resetGithubProjectsEmitForTests(): void {
  registeredEmit = null;
}
