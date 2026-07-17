# Example Extensions

Working examples that demonstrate EZCorp extension capabilities, from simple tools to multi-agent orchestration. Each example is a complete, installable extension with tests and documentation.

> **Data storage convention:** every example that writes persistent data stores it under `<projectRoot>/.ezcorp/extension-data/<extension-name>/`. See [../data-storage.md](../data-storage.md) for the full guide.

## Learning Path

Start simple and build up to composition patterns:

1. **[harness-smoke-test](harness-smoke-test/)** -- Smallest possible install/invoke smoke test, no permissions
2. **[github-stats](github-stats/)** -- Network permissions, environment variables, resource limits
3. **[project-analyzer](project-analyzer/)** -- Filesystem/shell access, postinstall lifecycle script
4. **[markdown-utils](markdown-utils/)** -- Multi-component package (tools + skill + agent), persistent process
5. **[research-agent](research-agent/)** -- Agent-only manifest, model requirements, example conversations
6. **[code-quality](code-quality/)** -- Cross-extension composition via ezcorp/invoke, dependencies, preuninstall script
7. **[code-review-delegator](code-review-delegator/)** -- Delegator pattern, multiple dependencies, combining results
8. **[multi-agent-orchestrator](multi-agent-orchestrator/)** -- Forward-looking sub-agent manifest shape (runtime pending)

### Additional Examples

These examples demonstrate advanced input schema features (combo boxes, tag inputs, date filters, file path pickers) and real-world tool patterns:

9. **[file-refactor](file-refactor/)** -- File rename previews with convention selection (combo-box, tag-input)
10. **[log-analyzer](log-analyzer/)** -- Log file search with level and date filters (search, combo-box, date)
11. **[todo-tracker](todo-tracker/)** -- Scan for TODO/FIXME/HACK comments with priority and tag filters
12. **[task-stack](task-stack/)** -- Comprehensive task management (25 tools, filesystem access)
13. **[kokoro-tts](kokoro-tts/)** -- `messageToolbar` contribution + `appendMessages` reverse-RPC for in-browser TTS
14. **[weather](weather/)** -- Network-only API fetch + custom web component card for inline weather UI

### More Bundled & Reference Extensions

Additional bundled and reference extensions spanning Hub dashboards, the Loop SDK, human-in-the-loop, multi-agent coordination, and domain-specific agents:

15. **[ask-user](ask-user/)** -- Pause execution to ask the user a question; renders inline in the assistant bubble with clickable options or free-text (human-in-the-loop)
16. **[auto-note](auto-note/)** -- Jot a quick note and watch it auto-organize into a linked vault: categorized, tagged, and connected
17. **[cash-recovery-agent](cash-recovery-agent/)** -- Autonomously surfaces unbilled change orders, underbilled jobs, releasable retainage, and overdue receivables across a construction portfolio
18. **[claude-design](claude-design/)** -- Extract a project-specific design system from your codebase, generate HTML drafts, and package a Claude-Code-ready handoff bundle (canvas primitives)
19. **[cron-dashboard](cron-dashboard/)** -- Reference Hub-page extension: a dashboard tab visualizing this extension's own scheduled heartbeat runs, refreshed live via pushPage
20. **[excel](excel/)** -- Read `.xlsx` workbooks attached to chat: sheet manifest, A1-range reads, or full sheets as markdown tables (operates on attachment handles)
21. **[extension-author](extension-author/)** -- Scaffold, preview, and install new EZCorp extensions from inside a chat, paired with an editable preview page
22. **[ez-code](ez-code/)** -- Warren-style control plane for ephemeral coding-agent runs: dispatch/steer/cancel/list from a live Hub dashboard, with cron triggers and branch→PR automation
23. **[ez-code-factory](ez-code-factory/)** -- A local git "gate" in front of your real remote: `git push gate <branch>` lands in a bare gate repo whose post-receive hook records a run and materializes a disposable worktree, surfaced on a live Hub dashboard (M0 gate bring-up)
24. **[file-organizer](file-organizer/)** -- Proposes file moves, renames, and cleanup you accept or reject; auto-handles watched folders and flags clutter. 100% local, no network
25. **[github-projects](github-projects/)** -- Connect a GitHub Projects v2 board to the active project and execute its tickets; live Hub dashboard for proposals and connection health (token stays host-side)
26. **[graded-card-scanner](graded-card-scanner/)** -- Scan PSA graded-card slabs with your phone for price + population by grade; camera web app + `lookup_card` tool + Hub dashboard
27. **[openai-image-gen-2](openai-image-gen-2/)** -- Generate or edit raster images with OpenAI's gpt-image-* models; persists files and returns markdown URL references to keep bytes out of context
28. **[orchestration](orchestration/)** -- Multi-agent orchestration primitives: `invoke_agent` for delegating to a sub-agent within a conversation
29. **[ping-loop](ping-loop/)** -- Watchable Loop SDK demo: fire a deterministic, LLM-free loop from the Hub dashboard and watch run rows appear (built on defineLoop)
30. **[price-chart](price-chart/)** -- Renders interactive stock (Yahoo Finance) and crypto (CoinGecko) price charts inline in chat via a host card, with client-side range switching
31. **[property-intelligence-agent](property-intelligence-agent/)** -- Analyzes a commercial real-estate portfolio for risk and opportunity (expiring leases, defaults, CAM under-recovery, covenants), each finding quantified with a tool citation
32. **[sample-loop](sample-loop/)** -- Reference Loop SDK example: summarizes each completed chat run in one line and mirrors it to an artifact (built on defineLoop)
33. **[scratchpad](scratchpad/)** -- Ephemeral key-value store for sharing data between agents within a conversation
34. **[substack-engagement](substack-engagement/)** -- Draft-and-approve Substack engagement: comment replies, welcome DMs + follow-up sequences, and Notes commenting, all queued for human review
35. **[substack-pilot](substack-pilot/)** -- Manage Substack post types with custom system prompts and AI-summarize-and-draft from URLs
36. **[substack-pipeline](substack-pipeline/)** -- Summarize a URL, draft a Substack article through a bounded approve/revise loop, then generate a cover image (deterministic role-prompted stages)
37. **[task-tracking](task-tracking/)** -- Multi-task planning and sub-agent coordination for a conversation
38. **[web-search](web-search/)** -- Free-text web search + URL-to-markdown reader; a thin shim over the host `ctx.search` capability (keyless by default, BYOK host-side)

## Feature Matrix

| Example | Tools | Skills | Agent | Scripts | Network | FS/Shell | Env | Dependencies | Persistent | Resources | SubAgents |
|---------|:-----:|:------:|:-----:|:-------:|:-------:|:--------:|:---:|:------------:|:----------:|:---------:|:---------:|
| harness-smoke-test | 1 | -- | -- | -- | -- | -- | -- | -- | -- | -- | -- |
| github-stats | 3 | -- | -- | -- | Y | -- | Y | -- | -- | Y | -- |
| project-analyzer | 2 | -- | -- | postinstall | -- | Y | -- | -- | -- | -- | -- |
| markdown-utils | 2 | 1 | Y | -- | -- | -- | -- | -- | Y | -- | -- |
| research-agent | -- | -- | Y | -- | -- | -- | -- | -- | -- | -- | -- |
| code-quality | 2 | -- | -- | preuninstall | -- | -- | -- | 1 | -- | -- | -- |
| code-review-delegator | 1 | -- | Y | -- | -- | -- | -- | 2 | -- | -- | -- |
| multi-agent-orchestrator | -- | -- | Y | -- | -- | -- | -- | -- | -- | -- | Y |
| file-refactor | 1 | -- | -- | -- | -- | Y | -- | -- | -- | -- | -- |
| log-analyzer | 1 | -- | -- | -- | -- | Y | -- | -- | -- | -- | -- |
| todo-tracker | 1 | -- | -- | -- | -- | Y | -- | -- | -- | -- | -- |
| task-stack | 25 | -- | -- | -- | -- | Y | -- | -- | -- | -- | -- |
| weather | 1 | -- | Y | -- | Y | -- | -- | -- | -- | Y | -- |

## Shared Variables

Extension tool schemas can use `x-shared` to auto-populate fields with contextual values. Fields with `x-shared` are pre-filled in the inline tool form and auto-injected server-side for agent-run calls. Users can still edit the pre-filled values.

### Available Variables

| Variable | Value | Example |
|----------|-------|---------|
| `project.cwd` | Current working directory | `/home/user/my-project` |
| `project.name` | Project directory name | `my-project` |

### Usage

Add `"x-shared"` to any string property in your tool's `inputSchema`:

```ts
inputSchema: {
  type: "object",
  properties: {
    sourcePath: {
      type: "string",
      description: "File or directory to analyze",
      "x-shared": "project.cwd",
    },
  },
}
```

## Quick Install

Install any example locally:

```bash
ezcorp ext install ./docs/extensions/examples/<name>
```

Run tests for an example:

```bash
bun test ./docs/extensions/examples/<name>/index.test.ts
```
