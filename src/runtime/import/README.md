# Imported skills in v4

The import route accepts skills only from an administrator browser session.
It creates a temporary private source directory, emits the v4 manifest and
entrypoint, and collects a bounded source snapshot without importing its config.
The temporary source is removed after collection. The lifecycle service stores
the workspace and queues an isolated build. The response includes a build ID and
a review link. Import never grants permission or activates a release.

The generated tests load the actual entrypoint, validate its catalog, read the
bundled instructions, and list scripts. They do not execute uploaded scripts as
part of source collection. Script calls run inside the selected release sandbox,
with a 30-second maximum, invocation cancellation, and a combined 64 KiB output
limit. Available interpreters depend on the approved runner image. There is no
host interpreter fallback.

## Unresolved compatibility limits

- Source workspaces currently contain UTF-8 text only. Binary assets are rejected
  with an explicit error; they are not converted to ambiguous base64 strings.
  Full binary import support requires a canonical typed blob representation.
- A script that needs an interpreter absent from the approved runner image must
  use a reviewed image that provides it. This path does not install interpreters
  on the host or execute installation scripts there.
- Host API access, project files, credentials, and networking remain brokered
  capabilities. Existing standalone scripts do not acquire host access merely
  because they were imported.
