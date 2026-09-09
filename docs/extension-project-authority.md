# Extension project access

An extension cannot select a host directory or approve its own GitHub changes.

## Bind a project

Open the extension workspace after activation. Under **Project access**, select a project that you can access. Review the exact release, select the checkbox, then approve.

Leave the write paths empty for read-only access. To permit documentation proposals, use `README.md, docs/`. A file entry permits that file only. A directory entry must end in `/`. Parent paths and wildcards are not accepted.

The human-session endpoint is `POST /api/extensions/releases/{installationId}/project`:

```json
{"projectId":"project-id","releaseId":"exact-release-id","generation":4,"writePaths":["README.md","docs/"]}
```

Use `projectId: null` to revoke access. A new release, disable, uninstall, or binding replacement invalidates queued background calls. Binding replacement creates a new random ID, even for the same project. API keys and extension RPC cannot approve bindings.

## Read project information

The host resolves the project from an owned conversation or the exact approved background binding. It rechecks the user, membership, release and policy for each operation.

- `ezcorp/project.gitHead {}` returns the HEAD hash and subject.
- `ezcorp/project.commitSubjects {sinceHash?}` returns at most 1,000 subjects. The optional starting hash must be a full commit hash.
- `ezcorp/project.origin {}` returns a credential-free, exact GitHub origin or `null`.

These operations accept no host path, command, environment or arbitrary arguments. Git output and execution time are bounded. Indirect repository configuration is rejected.

## Review GitHub changes

`ezcorp/project.pullRequest` accepts fixed `files`, `status`, `propose`, `finalize` and `close` actions. `propose` records a host-read snapshot and returns a host review URL. The extension's own approval records do not grant permission.

The human review displays the repository, PR number, exact head and base commits, changed and renamed files, and requested effect. The human can approve the stated effect, close the PR, or reject it without a GitHub write. The host rechecks the snapshot, approved write paths, current project binding, active owner, membership and policy before effects. A review expires after 24 hours.

The host can mark a PR ready and post the fixed approval comment. An explicitly reviewed merge uses the exact head SHA and squash method. The harness's own project can never be merged by this broker. The project GitHub token stays inside the host. Requests use pinned, guarded HTTPS with no redirects or write retries.

`finalize` and `close` RPC calls only observe the matching host decision. They cannot perform or approve effects. After the host review completes, return to the extension dashboard to update the loop status.

An interrupted or failed write can have partial effects. The durable record prevents replay. Check GitHub manually before requesting another proposal. The system does not report a partial write as complete.

GitHub's merge API checks the expected head SHA. Mark-ready, comment and close act on the reviewed PR, but do not provide the same atomic head check. The host checks the snapshot before these requests; a concurrent GitHub update can still occur between requests. These effects are not an atomic transaction over one commit. See [GitHub pull request REST operations](https://docs.github.com/en/rest/pulls/pulls) and [mark-ready mutation input](https://docs.github.com/en/graphql/reference/input-objects#markpullrequestreadyforreviewinput).
