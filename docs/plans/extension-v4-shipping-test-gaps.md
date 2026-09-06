# Extension v4 shipping test gaps

Reviewed 2026-09-06 at `232cad4abdd3787cd698539b082ac0b8909d09f7`. Four Terra agents reviewed separate areas; the parent checked their findings against source and existing tests. This is a proposed test plan, not new passing evidence. No new product tests ran during this review.

The current candidate passes all 32 technical CI checks. Install, import, real tool output, failed-update retention, disable/reapproval, uninstall, and fresh-name storage isolation already have live proof. The strongest additions test how these parts behave together when work is interrupted.

## First additions

### 1. Upgrade from a real previous version

The current [two-image verifier](../../scripts/verify-docker-upgrade.sh#L95) builds both images from the same source with different version labels. Its data assertion compares directory-entry counts. It cannot prove that a real older schema and installed extension state survive this release.

Use an immutable previous release image and the exact candidate image, with an owned persistent volume. Seed an extension, owner, linked conversation, known stored value, and known tool output through that previous version's supported interface. Back up the state, boot the candidate, and verify exact user records and stored values. Restore the backup into a separate owned instance and verify the same values there.

Use separate expected outcomes:

- Legacy adoption preserves the explicit installation identity, owner, links, and data namespace. It removes old grants and requires a new verified release and human approval before execution. See [adoption assertions](../../src/extensions/__tests__/source-adoption.test.ts#L51).
- An existing compatible v4 release must retain its exact authority and data across a host restart or upgrade. A source update must remain a candidate until approved. The documented first-party source-lock rule still applies to managed ez-factory agents; do not require silent reapproval. See [import contract](../extensions/v4-imports.md#L43).

Local runner: production containers. Pin the intended supported previous version before collecting evidence. Extend the existing verifier instead of creating another upgrade implementation.

### 2. Hard process death during build or delivery

[Lifecycle tests](../../src/extensions/v4/lifecycle.test.ts#L401) reopen the actual database and test lease recovery. [Delivery tests](../../src/extensions/v4/deliveries.test.ts#L35) prevent replay of uncertain effects. These do not kill the running app or runner service.

Add two controlled production-container cases:

- Pause an upgrade build at an observed boundary; kill and restart the app with the same database and artifact store. The same operation must recover without duplicate releases. The old release remains callable until new approval and activation.
- Record an owned delivery effect, then kill its worker before acknowledgement. Recovery must expose the uncertain result and must not repeat that effect. A fresh, distinct invocation must still work. Keep a separate before-effect case to prove a killed worker cannot create an effect it never reached.

Use explicit process/handler barriers. Do not use sleeps as proof that the kill occurred at the intended point. A database rollback cannot undo an external effect already admitted.

### 3. Disable or uninstall during a real invocation

The [File Organizer test](../../web/e2e/file-organizer-real.spec.ts#L582) denies new actions after disable and uninstall. Queue tests cover generation changes. Add the missing live race: pause a real handler before it asks the broker to admit a new file or storage effect, disable or uninstall, then release the handler.

Require denial of that new effect, a terminal invocation result, retained history/data, and no automatic replay. A separate fresh approval/reactivation case must work. Do not expect revocation to undo an effect already admitted before the revocation.

Local runner: existing real-auth and rootless runner fixtures; repeat against the production image.

### 4. Stale tabs and reload during a build

The [visible lifecycle](../../web/e2e/real-auth/extension-lifecycle-flow.spec.ts#L150) waits for build completion in one page. Add two same-session tabs: keep an old review open while the other tab activates a newer release or uninstalls. A stale action must fail without replacing the current release or restoring a removed installation. Refresh must show the authoritative state. Retained history and source are allowed.

Reload another page only after observing that its build is pending. Recover its existing operation, then review, activate, and invoke it. Require correct output and no duplicate candidate. Reuse the current real-auth fixtures.

## Keep this evidence running

The 13 production-image File Organizer cases passed during this audit, but [PR CI](../../.github/workflows/ci.yml#L159) skips them without `DOCKER_TEST`. The [image release workflow](../../.github/workflows/release-image.yml#L96) runs packaging, rollback, and upgrade checks, not that browser suite. Add the existing suite to a required candidate-image job. This is a CI coverage gap, not an untested claim for the audited image.

## Next priority

- **Interrupted source download:** fail a later GitHub blob fetch before staging; verify unchanged active release, storage, and candidate count. Retry the same immutable input, then changed input. Require one reused candidate for the identical input and a distinct unapproved candidate for changed input. Existing [adoption tests](../../src/extensions/__tests__/source-adoption.test.ts#L51) cover already-collected source.
- **Visible build-error recovery:** enter invalid source in the real editor, inspect diagnostics, correct it, rebuild, approve, and invoke. [Existing real failure coverage](../../web/e2e/real-auth/extension-release-gate.spec.ts#L78) uses the API to edit/build and the browser for invocation.
- **Long-running resource check:** repeat install/use/disable cycles and reconnects while measuring worker/container cleanup, open connections, and memory. Bounded resource and concurrency tests already exist; no sustained-load result is claimed.
- **Browser engines:** reuse the lifecycle spec on Firefox/WebKit if they are supported release targets. [Current real-auth CI](../../web/playwright.real.config.ts#L109) covers Chromium, including narrow layouts.

## Remaining external proof and decisions

Kernel audit ingestion and PID attribution remain unproved on the current runner. Stage2 raw-socket, IPv6, and connection-tracking tests still contain TODO bodies; merely enabling them supplies no assertions. They need implemented checks on an isolated Linux runner with the required controls. Some live provider tests need scoped test accounts or credentials. These are listed in the [independent validation report](../extension-v4-independent-validation-report.md#handoff-gap-dispositions).

The 84 Gate integrity findings and six product decisions remain separate from new test coverage. Extra passing tests do not supply maintainer approval or settle removed-feature requirements.
