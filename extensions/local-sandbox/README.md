# Local sandbox provider

This provider connects the reviewed extension lifecycle to the local sandbox
controller. It accepts only previously admitted operations. The host owns the
runtime image, limits, workspace paths, credentials, and process supervision.

Build, review, approve, and activate this source through the normal v4
extension lifecycle. Installing source does not grant approval. The provider
requests one host API route and no network, filesystem, or secret access.

The MVP supports native EZHarness tools in an offline persistent workspace.
External hosts, Infisical, previews, Compose services, and Claude/Codex guest
workers are outside this release.
