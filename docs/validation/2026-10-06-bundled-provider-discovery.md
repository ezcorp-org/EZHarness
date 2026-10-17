# Bundled provider discovery — 6 October 2026

Status: reproduced in the isolated app and fixed in source. Installation and live import of the corrected bundle remain pending.

The guarded update to app source `97461bdf0` passed database preservation, startup, both selected verifier checks and the actual loader check. Its supported bundled Incus import then returned HTTP 500. Inspection confirmed that it had not created a workspace or queued a build. The prior active provider was preserved; the request was not repeated.

The actual installed source collector rejected `incus-sandbox` as unknown. It discovered directories only when they contained `ezcorp.config.ts`. The authoring contract supports canonical `extension.ts` with an inline or imported manifest; the legacy config file is optional. Both Incus and Infisical use that canonical form. Importing the installed directory as a local path would also fall outside the approved local roots, so that was not used as a workaround.

Fix `b0db31ccc` updates the shared collector to discover a canonical entry point or retained legacy config under its existing fixed roots. Every marker that is present must be a regular file. The collector does not evaluate source. Symlink refusal, permission errors, snapshot bounds and ambiguous-name rejection remain enforced. The generated source lock adds the actual Incus and Infisical snapshots.

Verification includes the original failing snapshot and route cases, actual shipped provider snapshots, and a route test that creates a draft and queues its build without activating it. The snapshot suite passed 14 tests; installer tests passed 16; route tests passed 18. Changed executable lines were covered. Independent review, lint, source-lock checks and normal commit hooks passed.

The direct helper/image checks remain valid because this change does not alter the image or provider implementation. It does require a new app bundle. Final repository gates and the updated app's live provider import, approval, qualification and native workflow remain required.
