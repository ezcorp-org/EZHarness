# Personal GitHub connections

A user connects GitHub in **Settings → GitHub**. The host stores the encrypted
credentials. It never sends them to a model, extension, browser, or sandbox.
Another project member, including an application administrator, cannot use that
connection or access its private sandbox. The host operator remains trusted:
access to the database and encryption keys can reveal stored credentials.

## Operator setup

Register a GitHub App for this deployment. Request repository permissions for
Metadata (read), Contents (read and write), and Pull requests (read and write).
Enable expiring user tokens. Make the App public if users outside its owner
account must install it. Install it for selected repositories. An organization
may require its owner to approve the installation before a repository is usable.
See GitHub's [user authorization guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
and [token refresh guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).

Set these values in the host environment or the Compose environment file:

| Variable | Value |
| --- | --- |
| `EZ_GITHUB_INSTANCE_ID` | Unique, stable deployment ID: 8–128 letters, digits, underscores or hyphens |
| `EZ_GITHUB_APP_ID` | Numeric App ID |
| `EZ_GITHUB_APP_SLUG` | App URL slug |
| `EZ_GITHUB_APP_CLIENT_ID` | OAuth client ID |
| `EZ_GITHUB_APP_CLIENT_SECRET` | OAuth client secret |
| `EZ_GITHUB_APP_CALLBACK_URL` | `https://<public-host>/api/github/callback` |

The callback origin must match `EZCORP_PUBLIC_URL` or `ORIGIN` when configured.
Register that exact callback in the App. Do not put these values in a project,
extension setting, or sandbox. The Compose stacks pass them only to the app.
Missing or invalid configuration disables connection setup.

Preserve the database, deployment ID, and encryption key material together.
The existing credential store uses `EZCORP_ENCRYPTION_SECRET` and
`EZCORP_ENCRYPTION_SALT`, or its persisted secret files. Changing keys without
migrating encrypted records requires affected users to reconnect. Restore tests
must check that existing credentials still decrypt before accepting traffic.

## User flow

1. Open **Settings → GitHub**, connect, and authorize the App on GitHub.
2. Install the App for the repositories you need. Request organization approval
   if required, then return and check repository access.
3. Create a private GitHub sandbox and select a repository. Wait for import to
   finish before opening its chat.
4. Make changes in that sandbox. One private sandbox has one owner conversation;
   later runs in that conversation build on its earlier changes.
5. Review the saved changes and confirm creation of a draft pull request.

The repository is imported at a fixed commit. PR review uses an immutable export,
bound to the owner, sandbox, conversation, and latest completed run. A different
run or account cannot substitute files. GitHub writes require a fresh confirmed
proposal and the same connection generation. Disconnect blocks new dispatches;
an already dispatched GitHub request can still complete and must be reconciled.

Import failure keeps the sandbox closed. Dispose of it before creating another.
This version does not merge PRs, publish Factory releases, or grant a sandbox
general GitHub credentials. Repository policy can still refuse a proposed write.

## Verification before use

Use a disposable private repository and a test App to check authorization,
repository selection, import, review, draft PR creation, reconnect, disconnect,
and denial for a second user. A test with a GitHub CLI token proves API behavior
only; it does not prove the App authorization or selected repository controls.

## Key files

- `src/integrations/github-user/`: authorization, token storage and host transport
- `src/integrations/github-personal-prs/`: import, snapshots, review and publication
- `src/runtime/sandbox/controller/`: private ownership and workspace access
- `web/src/routes/(app)/settings/github/`: connection settings
- `web/src/routes/api/github/`: authenticated user endpoints
