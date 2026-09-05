# Extensions

Extensions add tools, skills, agents, workflows, pages, and background behavior. Source is built in rootless isolation. A human approves the exact verified release before activation.

## Start here

- [Getting started](getting-started.md): create source and test the active feature.
- [Authoring](AUTHORING.md): the harness build, repair, review, and activation loop.
- [API reference](api-reference.md): the small host control surface and SDK entrypoints.
- [Manifest reference](manifest-schema.md): declarative v4 contributions and permissions.
- [Security](security.md): trust boundaries, approval, and explicit limits.
- [Storage](data-storage.md): persistent state, private data, and virtual paths.
- [Imports](v4-imports.md): supported source collectors and migration limits.

## Contributions

Tools are invoked through the host broker. Skills and agents enter the live catalog only from an acknowledged active release. Pages, cards, toolbar actions, schedules, webhooks, and loops use the same release and permission boundary.

Feature guides describe the retained registration helpers:

- [Hub pages](pages.md)
- [Canvas cards](canvas-cards.md)
- [Message toolbar](message-toolbar.md)
- [Settings](settings.md)
- [Loops](loops.md)
- [Logging](logging.md)

Use their contribution fragments inside a v4 scaffold. The current schema and SDK guide take precedence over historical configuration examples. Do not revive executable host configuration, direct install, raw host environment access, or handwritten stdin loops.

## One lifecycle

`workspace → locked revision → isolated build and tests → verified release → human review → activation`

Editing or importing source does not change the active release. Failed builds do not replace working code. Approval is bound to source, artifact, grants, policy, and scope. Uninstall disables execution while retaining history and data.

First-party source is subject to the same build and approval boundary. The source lock identifies expected code; it is not an automatic permission grant.
