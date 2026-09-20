import { join } from "node:path";
import { provisionToolchain, TrustedLocalRunner, type TrustedLocalApproval } from "@ezcorp/extension-runner";
import { extensionLogger } from "../logger";
import { getProjectRoot } from "./project-root";
import { trustedLocalBunDigest } from "./runner-mode";
import { LifecycleError } from "./v4/types";

const log = extensionLogger("trusted-local", "runner");

/**
 * Host wiring for `TrustedLocalRunner` — the ignition the package never had.
 *
 * The runner itself owns every refusal: the platform and non-root account
 * check, the pinned bun digest, and the per-(phase, digest) approval with
 * approver, expiry and acknowledged omitted controls (`authorize()`), plus the
 * audit call after each grant. This module only supplies what those hooks
 * read from and where artifacts live. It never decides "may I"; the runner
 * does.
 *
 * It deliberately imports NOTHING from `db/`. `runner-connection.ts` is a pure
 * connection module, and a static path from it into `db/connection` closes
 * the repository's known import cycle (`migrate → bundled → … → connection`,
 * see `project-root.ts`), which the server bundle then breaks with deferred
 * module evaluation — with the runner package's classes arriving as lazily
 * initialised bindings. The two database-backed hooks are therefore INJECTED
 * by the lifecycle service at initialisation
 * (`configureTrustedLocalRunner`), which already loads every `db/` module
 * lazily for the same reason; `trusted-local-hooks.ts` builds them.
 *
 * Constructed at most once per process, lazily, because initialising it reads
 * ~100 MB of bun to digest it and bundles the trusted SDK. A failed
 * construction is forgotten so the next call retries rather than caching the
 * error forever.
 */
export interface TrustedLocalHooks {
  /** The live approval for this exact digest and phase, or null. */
  approvalFor(phase: "build" | "execute", digest: string): Promise<TrustedLocalApproval | null>;
  /** Called by the runner after every granted build or worker start. */
  audit(event: { mode: "trusted-local"; approval: TrustedLocalApproval }): Promise<void>;
}

export const TRUSTED_LOCAL_ROOT = join(".ezcorp", "extension-trusted-local");

/** Artifact store: `EZCORP_TRUSTED_LOCAL_ROOT` (absolute) or `<projectRoot>/.ezcorp/extension-trusted-local` — the same override shape `EZCORP_EXTENSION_BLOB_ROOT` gives the release blobs. */
export function trustedLocalRoot(projectRoot: string): string {
  return process.env.EZCORP_TRUSTED_LOCAL_ROOT ?? join(projectRoot, TRUSTED_LOCAL_ROOT);
}

let hooks: TrustedLocalHooks | undefined;
let runner: Promise<TrustedLocalRunner> | undefined;

/** Install the approval store and audit sink. Idempotent; a later call replaces the earlier one for any runner not yet constructed. */
export function configureTrustedLocalRunner(next: TrustedLocalHooks): void {
  hooks = next;
}

export function resolveTrustedLocalRunner(): Promise<TrustedLocalRunner> {
  // Also what the CLI's offline verify hits in this mode: it has no human
  // acknowledgement to record, so it cannot build here by design.
  if (!hooks) return Promise.reject(new LifecycleError("runner_unconfigured", "The trusted-local runner has no approval store in this process. The application installs it at startup; the CLI cannot build in trusted-local mode — use the web workspace, which records your acknowledgement, or configure the isolated runner."));
  runner ??= construct(hooks).catch((error: unknown) => {
    runner = undefined;
    throw error;
  });
  return runner;
}

async function construct(host: TrustedLocalHooks): Promise<TrustedLocalRunner> {
  const projectRoot = getProjectRoot();
  const bunDigest = await trustedLocalBunDigest();
  // Everything the runner reads from the installed release is named
  // EXPLICITLY from the project root rather than left to the package's
  // `import.meta.url` defaults. Inside the bundled server
  // (`web/build/server/…`) those defaults point into the bundle: the seccomp
  // profile — never APPLIED by this runner, but digested into every
  // artifact's recipe — does not exist there, and the toolchain walk finds
  // `web/node_modules` (a different `typescript` major, no `@types/bun`)
  // before the pinned root closure. The SDK entry keeps the same env
  // override the runner's own tests use. Caught by the trusted-local
  // Playwright lane, which runs the production build; the source-mode
  // integration test cannot see any of it.
  const packages = join(projectRoot, "packages", "@ezcorp");
  const toolchain = await provisionToolchain({ sdkEntrypoint: process.env.EZ_EXTENSION_RUNNER_SDK_ENTRY ?? join(packages, "sdk", "src", "v4", "index.ts"), toolchainRoot: projectRoot });
  const instance = new TrustedLocalRunner({
    root: trustedLocalRoot(projectRoot),
    seccompPath: join(packages, "extension-runner", "seccomp.json"),
    bunPath: process.execPath,
    bunDigest,
    // The app's own uid. The runner refuses 0 and refuses a mismatch; the
    // prod image runs as uid 1000 (`USER bun`). This is the "dedicated
    // non-root account" reading the decision record names as looser than
    // the plan's wording: same account as the app, still never root.
    dedicatedUid: process.getuid?.() ?? -1,
    ...toolchain,
    approvalFor: async (phase, digest) => {
      const approval = await host.approvalFor(phase, digest);
      // The runner's refusal names neither the phase nor the digest; this is
      // the line an operator reads to learn WHICH acknowledgement is missing
      // or expired. A digest is not a secret.
      if (!approval) log.warn("No live trusted-local approval — the runner will refuse", { phase, digest });
      return approval;
    },
    audit: host.audit,
  });
  await instance.initialize();
  return instance;
}
