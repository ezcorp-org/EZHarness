# file-organizer

A 100%-local, secure file-organization bundled extension. It proposes file
moves, renames, and garbage cleanup you accept or reject; auto-handles new
files in watched folders; recognizes junk/duplicate/stale clutter; lets you
co-design a workflow with an agent; and alerts you when a file falls outside
that workflow. **No network access** — nothing calls home.

> Full usage, the modes table, the garbage presets, and the Docker
> add/remove model are documented in Phase 5. This file is the scaffold.

## At a glance

- **Watcher** runs host-side (a background daemon), not inside the sandbox.
- **Deletes are never hard** — they move to a reversible quarantine.
- **Three Hub pages**: Overview, Review, Folders & Rules.
- **Three modes**: ask-everything (default), approve-non-destructive-only,
  fully-auto.

See `knowledge/preset-rules.md` for the presets and the quick-rule mini-DSL.
