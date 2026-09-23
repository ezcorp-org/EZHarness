# Personal GitHub connections

A user connects GitHub in **Settings → GitHub** using a code approved on GitHub.
The self-hosted installation requests, receives, and refreshes its tokens directly
with GitHub. It stores them encrypted and never sends them to a model, extension,
browser, sandbox, or the EZCorp public Worker.
Another project member, including an application administrator, cannot use that
connection or access its private sandbox. The host operator remains trusted:
access to the database and encryption keys can reveal stored credentials.

## Shared App setup

The shared App is owned by `ezcorp-org`. Its public App ID is `5049328` and its
public Client ID is `Iv23linp84AzzvCGxstF`. Different installation addresses do not
need separate callback registrations. Configure the GitHub App as follows:

Its verified public URL is [EZCorp Github Auth](https://github.com/apps/ezcorp-github-auth)
and its slug is `ezcorp-github-auth`. These public values ship as defaults; users
do not need to configure them separately on each installation.

| GitHub App field | Setting |
| --- | --- |
| Homepage URL | `https://github-auth.ezcorp.org` after Worker deployment; use `https://github.com/ezcorp-org` before deployment |
| Callback URL | Empty |
| Expire user authorization tokens | Enabled |
| Request user authorization during installation | Disabled |
| Enable Device Flow | Enabled |
| Setup URL | Empty |
| Redirect on update | Disabled |
| Webhook Active | Disabled |
| Repository Metadata | Read-only |
| Repository Contents | Read and write |
| Repository Pull requests | Read and write |
| All other repository, organization, and account permissions | No access |
| Where can this App be installed? | Any account |

Install the App for selected repositories. An organization may require its owner
to approve access. No App client secret or private key is needed for device
authorization or refresh. See GitHub's [device authorization guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
and [refresh rules](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).

The Cloudflare Worker publishes a public setup page and public App metadata only.
It has no token exchange, user database, callbacks, webhooks, cookies, analytics,
or application request logging. The supported flows send it no codes, tokens,
local session identifiers, installation URLs, or repository content. It is not
in the authorization, refresh, import, or PR request path. Cloudflare platform
traffic processing and retention are separate from application storage.

Never use the Worker as the App Setup URL: GitHub adds installation identifiers
to that redirect. Public metadata is setup information; installations must not
fetch it at runtime to change their trusted App identity.

## Installation configuration

To override the built-in public App settings, use the host environment or Compose file:

| Variable | Value |
| --- | --- |
| `EZ_GITHUB_AUTH_MODE` | `device` (shared-App default) |
| `EZ_GITHUB_INSTANCE_ID` | Optional stable identity override; preserve an existing configured value |
| `EZ_GITHUB_APP_ID` | Numeric App ID |
| `EZ_GITHUB_APP_SLUG` | App URL slug |
| `EZ_GITHUB_APP_CLIENT_ID` | OAuth client ID |

Device mode does not use `EZ_GITHUB_APP_CLIENT_SECRET` or
`EZ_GITHUB_APP_CALLBACK_URL`. Use HTTPS for exposed browser sessions; device flow
removes the inbound callback requirement, not the need to protect local sessions.
GitHub must be reachable from the self-hosted backend and the user's browser.

Existing per-installation OAuth Apps can use explicit `EZ_GITHUB_AUTH_MODE=oauth`
with their own client secret and exact HTTPS `/api/github/callback` URL. Its origin
must match `EZCORP_PUBLIC_URL` or `ORIGIN` when configured. Do not distribute the
shared App's secret to installations. Tokens retain their original authorization
method; an old OAuth token must not be refreshed as a device-flow token.

Preserve the database, deployment ID, and encryption key material together.
The existing credential store uses `EZCORP_ENCRYPTION_SECRET` and
`EZCORP_ENCRYPTION_SALT`, or its persisted secret files. Changing keys without
migrating encrypted records requires affected users to reconnect. Restore tests
must check that existing credentials still decrypt before accepting traffic.

## User flow

1. Open **Settings → GitHub** and select **Connect GitHub**.
2. Open the displayed GitHub verification link and enter the code shown by this
   installation. Only enter a code that you just requested here. Approve the App
   for the correct GitHub account, then return to the Settings tab.
3. Install the App for the repositories you need. Request organization approval
   if required, then return and check repository access.
4. Create a private GitHub sandbox and select a repository. Wait for import to
   finish before opening its chat.
5. Make changes in that sandbox. One private sandbox has one owner conversation;
   later runs in that conversation build on its earlier changes.
6. Select **Prepare PR review**, review the saved changes, and confirm creation
   of a draft pull request. The UI states when no verified checks are recorded.

V1 accepts up to 2,000 regular files, 256 KiB per file, and 32 MiB of file content.
It rejects links, submodules, special files, and changes to GitHub workflow files.
An unsupported repository fails before its sandbox becomes usable.

The repository is imported at a fixed commit. PR review uses an immutable export,
bound to the owner, sandbox, conversation, and latest completed run. A different
run or account cannot substitute files. GitHub writes require a fresh confirmed
proposal and the same connection generation. Disconnect blocks new dispatches;
an already dispatched GitHub request can still complete and must be reconciled.

Device-flow disconnect removes this installation's saved credentials and blocks
new local dispatches. It does not claim to revoke GitHub authorization remotely.
To revoke the App on GitHub, use GitHub **Settings → Applications → Authorized
GitHub Apps**. Revoking the shared App can affect other installations where the
same GitHub account authorized it.

Import failure keeps the sandbox closed. Dispose of it before creating another.
This version does not merge PRs, publish Factory releases, or grant a sandbox
general GitHub credentials. Repository policy can still refuse a proposed write.

## Verification before use

Use a disposable private repository and the shared App to check device approval,
direct token refresh, selected repository access, import, review, draft PR
creation, reconnect, disconnect, cancellation, and denial for a second user.
The public Worker must receive none of this flow's codes or tokens. A test with a
GitHub CLI token proves API behavior only; it does not prove device authorization,
refresh, or selected repository controls.

## Key files

- `src/integrations/github-user/`: authorization, token storage and host transport
- `src/integrations/github-personal-prs/`: import, snapshots, review and publication
- `src/runtime/sandbox/controller/`: private ownership and workspace access
- `web/src/routes/(app)/settings/github/`: connection settings
- `web/src/routes/api/github/`: authenticated user endpoints
- `src/integrations/github-app-directory/`: public Worker request handler
- `worker/github-connect/`: public Worker configuration and deployment instructions
- [Shared App implementation plan](../../plans/2026-09-23-shared-github-device-flow.md)
