# Local factory publication tests

The private repository [`ezcorp-org/factory-platform-publication-tests`](https://github.com/ezcorp-org/factory-platform-publication-tests) is the disposable target for GitHub publication tests. Its default branch is `main`. GitHub creation and an API read confirmed private visibility on 2026-09-13. The user explicitly authorized creating this test repository.

The existing local GitHub CLI credential reference is `/home/dev/.config/gh/hosts.yml`, under the active `EZArchy` account. This is a reference only. Keep credential values out of logs, commits, test reports, workflow payloads, supervisors, and runners. The trusted release broker obtains the credential through its private service configuration.

Use unique test branches and release operation identities. Retain the exact candidate commit/tree, resulting pull request receipt, and remote content verification. Repository creation alone does not satisfy the real factory release-adapter proof; that test remains part of the platform integration gates.

Local object publication uses the versioned S3 services described in [factory-local-storage.md](factory-local-storage.md). The initial tenant test population is ten, as requested.
