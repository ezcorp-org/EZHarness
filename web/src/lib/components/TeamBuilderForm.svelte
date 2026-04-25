<script lang="ts">
	import { onMount } from "svelte";
	import { inputClass } from "$lib/styles.js";
	import { CURRENT_MODEL_SENTINEL, type AgentConfig, type TeamMember, type TeamMemberOverrides, type TeamToolScope } from "$lib/api";
	import AgentSearchPicker from "$lib/components/AgentSearchPicker.svelte";
	import ModelSearchPicker from "$lib/components/ModelSearchPicker.svelte";
	import ModeSearchPicker from "$lib/components/ModeSearchPicker.svelte";
	import ToolSearchPicker from "$lib/components/ToolSearchPicker.svelte";
	import Tooltip from "$lib/components/Tooltip.svelte";

	let {
		initial = {},
		agentConfigs,
		onsubmit,
		submitting = false,
	}: {
		initial?: Record<string, unknown>;
		agentConfigs: AgentConfig[];
		onsubmit: (data: Record<string, unknown>) => void;
		submitting?: boolean;
	} = $props();

	const initialRefs = (initial?.references ?? null) as
		| { agents?: string[]; extensions?: string[]; members?: TeamMember[]; autoSpinUp?: boolean; teamToolScope?: TeamToolScope }
		| null
		| undefined;

	// If members array exists, use it. Otherwise, fall back to flat agents array
	// (backwards compat for teams created before the members feature)
	function resolveInitialMembers(): TeamMember[] {
		if (Array.isArray(initialRefs?.members) && initialRefs.members.length > 0) {
			return initialRefs.members;
		}
		if (Array.isArray(initialRefs?.agents) && initialRefs.agents.length > 0) {
			return initialRefs.agents.map((id) => ({ agentConfigId: id }));
		}
		return [];
	}

	let name = $state((initial?.name as string) ?? "");
	let description = $state((initial?.description as string) ?? "");
	let prompt = $state((initial?.prompt as string) ?? "");
	let autoSpinUp = $state<boolean>(initialRefs?.autoSpinUp ?? false);
	let members = $state<TeamMember[]>(JSON.parse(JSON.stringify(resolveInitialMembers())));
	// Team-level tool scope (optional). When either list is non-empty, it
	// overrides every member's per-member tool configuration at invocation time.
	let teamAllowedTools = $state<string[]>(initialRefs?.teamToolScope?.allowedTools ?? []);
	let teamDeniedTools = $state<string[]>(initialRefs?.teamToolScope?.deniedTools ?? []);
	let errorMsg = $state("");

	// Track which members have their override panel expanded (by path key)
	let expandedOverrides = $state<Set<string>>(new Set());

	function flattenMemberIds(tree: TeamMember[]): string[] {
		const ids: string[] = [];
		for (const m of tree) {
			ids.push(m.agentConfigId);
			if (m.subAgents?.length) {
				ids.push(...flattenMemberIds(m.subAgents));
			}
		}
		return ids;
	}

	let availableAgents = $derived(
		agentConfigs.filter((c) => c.category !== "team"),
	);

	function resolveAgent(id: string): AgentConfig | undefined {
		return agentConfigs.find((c) => c.id === id);
	}

	// Extensions + tool catalogs — fetched once.
	//   extensionNameById: map ext ID → ext NAME (pills + "extension__tool" keys).
	//   toolNamesByExtension: map ext NAME → list of fully-qualified tool keys.
	// Together they let us compute, for any agent, the full set of tool keys
	// the agent has access to by default (its extensions' tools). That set
	// pre-populates the per-member "Allowed Tools" picker so users see the
	// agent's effective defaults instead of an empty input.
	// All fetches are non-fatal.
	let extensionNameById = $state<Map<string, string>>(new Map());
	let toolNamesByExtension = $state<Map<string, string[]>>(new Map());
	onMount(async () => {
		try {
			const res = await fetch("/api/extensions");
			if (res.ok) {
				const data = await res.json();
				const list: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.extensions) ? data.extensions : [];
				const m = new Map<string, string>();
				for (const e of list as Array<{ id: string; name?: string }>) {
					if (e?.id) m.set(e.id, e.name ?? e.id);
				}
				extensionNameById = m;
			}
		} catch { /* non-fatal */ }
		try {
			const res = await fetch("/api/tools");
			if (res.ok) {
				const data = await res.json();
				const tools: Array<{ name: string; extension: string }> =
					Array.isArray(data?.tools) ? data.tools : Array.isArray(data) ? data : [];
				const m = new Map<string, string[]>();
				for (const t of tools) {
					if (!t?.extension || !t?.name) continue;
					const arr = m.get(t.extension) ?? [];
					arr.push(`${t.extension}__${t.name}`);
					m.set(t.extension, arr);
				}
				toolNamesByExtension = m;
			}
		} catch { /* non-fatal */ }
	});

	function defaultExtensionNames(agent: AgentConfig | undefined): string[] {
		const ids = agent?.extensions ?? [];
		if (!ids.length) return [];
		return ids.map((id) => extensionNameById.get(id) ?? id);
	}

	/**
	 * Compute the set of fully-qualified tool keys an agent can use by default.
	 * Used to pre-populate the per-member Allowed Tools picker so users see
	 * the agent's effective baseline when no override is set.
	 */
	function defaultAllowedToolsFor(agent: AgentConfig | undefined): string[] {
		const extIds = agent?.extensions ?? [];
		if (!extIds.length) return [];
		const out: string[] = [];
		for (const extId of extIds) {
			const extName = extensionNameById.get(extId) ?? extId;
			const tools = toolNamesByExtension.get(extName);
			if (tools) out.push(...tools);
		}
		return out;
	}

	function addMember(agentConfigId: string) {
		members = [...members, { agentConfigId }];
	}

	function removeMemberAt(path: number[]) {
		members = removeAtPath(members, path);
	}

	function removeAtPath(tree: TeamMember[], path: number[]): TeamMember[] {
		if (path.length === 1) {
			return tree.filter((_, i) => i !== path[0]);
		}
		return tree.map((m, i) => {
			if (i === path[0]) {
				return { ...m, subAgents: removeAtPath(m.subAgents ?? [], path.slice(1)) };
			}
			return m;
		});
	}

	function addSubAgent(path: number[], agentConfigId: string) {
		members = addSubAtPath(members, path, agentConfigId);
	}

	function addSubAtPath(tree: TeamMember[], path: number[], agentConfigId: string): TeamMember[] {
		return tree.map((m, i) => {
			if (i === path[0]) {
				if (path.length === 1) {
					return { ...m, subAgents: [...(m.subAgents ?? []), { agentConfigId }] };
				}
				return { ...m, subAgents: addSubAtPath(m.subAgents ?? [], path.slice(1), agentConfigId) };
			}
			return m;
		});
	}

	function updateOverrides(path: number[], overrides: TeamMemberOverrides | undefined) {
		members = updateOverridesAtPath(members, path, overrides);
	}

	function updateOverridesAtPath(
		tree: TeamMember[],
		path: number[],
		overrides: TeamMemberOverrides | undefined,
	): TeamMember[] {
		return tree.map((m, i) => {
			if (i === path[0]) {
				if (path.length === 1) {
					const updated = { ...m };
					if (overrides && Object.keys(overrides).length > 0) {
						updated.overrides = overrides;
					} else {
						delete updated.overrides;
					}
					return updated;
				}
				return { ...m, subAgents: updateOverridesAtPath(m.subAgents ?? [], path.slice(1), overrides) };
			}
			return m;
		});
	}

	function displayModelValue(value: string | undefined | null): string {
		if (value === CURRENT_MODEL_SENTINEL) return "current chat model";
		return value || "system default";
	}

	function hasOverrides(member: TeamMember): boolean {
		if (!member.overrides) return false;
		return Object.values(member.overrides).some((v) =>
			v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0),
		);
	}

	/**
	 * Build a short, human-readable summary of a member's overrides so users can
	 * see pre-populated configuration at a glance without expanding the panel.
	 * Returns a list of { label, title } pill descriptors.
	 */
	function summarizeOverrides(ov: TeamMemberOverrides | undefined): Array<{ label: string; title: string }> {
		if (!ov) return [];
		const out: Array<{ label: string; title: string }> = [];
		if (ov.model) {
			out.push({ label: `model: ${displayModelValue(ov.model)}`, title: "Model override" });
		}
		if (ov.modeId) {
			out.push({ label: "mode override", title: `modeId: ${ov.modeId}` });
		}
		if (ov.toolRestriction && ov.toolRestriction !== "all") {
			out.push({ label: ov.toolRestriction === "read-only" ? "read-only" : "no tools", title: "Tool restriction" });
		}
		if (ov.permissionMode) {
			out.push({ label: ov.permissionMode, title: "Permission mode" });
		}
		if (ov.allowedTools?.length) {
			out.push({ label: `${ov.allowedTools.length} allowed`, title: `Allowed tools: ${ov.allowedTools.join(", ")}` });
		}
		if (ov.deniedTools?.length) {
			out.push({ label: `${ov.deniedTools.length} denied`, title: `Denied tools: ${ov.deniedTools.join(", ")}` });
		}
		if (ov.systemPromptAppend?.trim()) {
			out.push({ label: "prompt append", title: "Additional system prompt" });
		}
		return out;
	}

	function toggleExpanded(key: string) {
		const next = new Set(expandedOverrides);
		if (next.has(key)) {
			next.delete(key);
		} else {
			next.add(key);
		}
		expandedOverrides = next;
	}

	// Sub-agent picker state per path
	let addingSubAt = $state<string | null>(null);

	function handleSubmit(e: Event) {
		e.preventDefault();
		errorMsg = "";

		if (!name.trim()) {
			errorMsg = "Name is required";
			return;
		}
		if (!prompt.trim()) {
			errorMsg = "Coordination instructions are required";
			return;
		}
		if (members.length === 0) {
			errorMsg = "Add at least one team member";
			return;
		}

		const teamToolScope: TeamToolScope | undefined =
			teamAllowedTools.length > 0 || teamDeniedTools.length > 0
				? {
					...(teamAllowedTools.length > 0 ? { allowedTools: teamAllowedTools } : {}),
					...(teamDeniedTools.length > 0 ? { deniedTools: teamDeniedTools } : {}),
				}
				: undefined;

		onsubmit({
			name: name.trim(),
			description: description.trim(),
			prompt: prompt.trim(),
			category: "team",
			references: {
				agents: flattenMemberIds(members),
				extensions: [],
				members,
				...(autoSpinUp ? { autoSpinUp: true } : {}),
				...(teamToolScope ? { teamToolScope } : {}),
			},
		});
	}
</script>

{#snippet memberRow(member: TeamMember, path: number[], depth: number)}
	{@const agent = resolveAgent(member.agentConfigId)}
	{@const pathKey = path.join("-")}
	{@const isExpanded = expandedOverrides.has(pathKey)}
	{@const availableForSub = agentConfigs.filter(
		(c) => c.category !== "team",
	)}

	<div class="relative" style="padding-left: {depth * 2}rem;">
		{#if depth > 0}
			<div
				class="absolute top-0 bottom-0 border-l border-[var(--color-border)]"
				style="left: {depth * 2 - 1}rem;"
			></div>
		{/if}

		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="flex cursor-pointer items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-2 transition-colors hover:border-[var(--color-text-muted)]"
			onclick={() => toggleExpanded(pathKey)}
		>
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-2">
					<Tooltip text="{agent?.prompt ? agent.prompt.slice(0, 200) + (agent.prompt.length > 200 ? '...' : '') : 'No prompt'}{agent?.provider ? ` | Provider: ${displayModelValue(agent.provider)}` : ''}{agent?.model ? ` | Model: ${displayModelValue(agent.model)}` : ''}" position="right">
						<span class="cursor-help font-medium text-[var(--color-text-primary)] underline decoration-dotted decoration-[var(--color-text-muted)] underline-offset-4">{agent?.name ?? "Unknown"}</span>
					</Tooltip>
					{#if hasOverrides(member)}
						<span class="inline-block h-2 w-2 rounded-full bg-amber-400" title="Has overrides"></span>
					{/if}
					{#if agent?.description}
						<span class="truncate text-xs text-[var(--color-text-muted)]">{agent.description}</span>
					{/if}
				</div>
				<!-- Agent's DEFAULT tools (extensions it brings to the team). Distinct
				     visual treatment from override pills so users can tell at a glance
				     what's baseline vs what's been customized. -->
				{#if !isExpanded}
					{@const defaults = defaultExtensionNames(agent)}
					{#if defaults.length > 0}
						<div class="mt-1 flex flex-wrap items-center gap-1" data-testid="member-default-tools">
							<span class="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">tools:</span>
							{#each defaults as toolName}
								<span
									class="inline-flex items-center rounded-full border border-[var(--color-border)] bg-transparent px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]"
									title="Extension attached to {agent?.name ?? 'this agent'}"
								>
									{toolName}
								</span>
							{/each}
						</div>
					{:else if agent}
						<!-- Agent has no extensions attached. Tell users exactly what to do
						     instead of leaving the row bare — the pre-fix backend silently
						     dropped the extensions field, so many existing agents show up
						     here with no tools until they re-save in the agent editor. -->
						<div class="mt-1 flex items-center gap-1" data-testid="member-default-tools-empty">
							<span class="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">tools:</span>
							<a
								href="/agents/{encodeURIComponent(agent.name)}"
								class="text-[10px] italic text-[var(--color-text-muted)] underline decoration-dotted hover:text-[var(--color-text-primary)]"
								onclick={(e) => e.stopPropagation()}
								title="Open {agent.name}'s editor to attach extensions"
							>
								no extensions attached — edit {agent.name} to add some
							</a>
						</div>
					{/if}
				{/if}
				<!-- Pre-populated override summary (collapsed state only — expanded panel
				     already shows the full detail via pickers). -->
				{#if !isExpanded && hasOverrides(member)}
					{@const summary = summarizeOverrides(member.overrides)}
					{#if summary.length > 0}
						<div class="mt-1 flex flex-wrap gap-1">
							{#each summary as pill}
								<span
									class="inline-flex items-center rounded-full bg-[var(--color-surface-secondary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]"
									title={pill.title}
								>
									{pill.label}
								</span>
							{/each}
						</div>
					{/if}
				{/if}
			</div>
			<div class="flex shrink-0 items-center gap-1">
				<svg class="h-4 w-4 text-[var(--color-text-secondary)] transition-transform {isExpanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
				</svg>
				{#if depth < 3}
					<button
						type="button"
						onclick={(e) => { e.stopPropagation(); addingSubAt = addingSubAt === pathKey ? null : pathKey; }}
						class="rounded p-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)]"
						title="Add sub-agent"
					>
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
						</svg>
					</button>
				{/if}
				<button
					type="button"
					onclick={(e) => { e.stopPropagation(); removeMemberAt(path); }}
					class="rounded p-1 text-red-400 hover:bg-red-900/30 hover:text-red-300"
					title="Remove member"
				>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>
		</div>

		<!-- Override panel -->
		{#if isExpanded}
			{@const ov = member.overrides ?? {}}
			{@const agentProvider = displayModelValue(agent?.provider)}
			{@const agentModel = displayModelValue(agent?.model)}
			{@const hasModelOverride = !!(ov.provider && ov.model)}
			{@const hasToolsOverride = !!(ov.allowedTools && ov.allowedTools.length > 0)}
			{@const agentDefaultTools = defaultAllowedToolsFor(agent)}
			<div class="mt-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3" style="margin-left: {depth > 0 ? '1rem' : '0'};">
				<div class="space-y-3">
					<div>
						<label class="mb-1 block text-xs text-[var(--color-text-muted)]">Mode</label>
						<ModeSearchPicker
							selected={ov.modeId ?? null}
							placeholder="Search modes..."
							onselect={(mode) => updateOverrides(path, { ...ov, modeId: mode?.id ?? undefined })}
						/>
					</div>
					<div>
						<label class="mb-1 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
							Allowed Tools
							{#if !hasToolsOverride && agentDefaultTools.length > 0}
								<span class="text-[10px] italic">(showing agent defaults — interact to override)</span>
							{/if}
						</label>
						<ToolSearchPicker
							selected={hasToolsOverride ? ov.allowedTools! : agentDefaultTools}
							placeholder="Search tools to allow..."
							onchange={(toolNames) => updateOverrides(path, { ...ov, allowedTools: toolNames.length > 0 ? toolNames : undefined })}
						/>
						{#if hasToolsOverride}
							<button
								type="button"
								class="mt-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
								onclick={() => updateOverrides(path, { ...ov, allowedTools: undefined })}
							>
								Reset to agent defaults ({agentDefaultTools.length} tool{agentDefaultTools.length === 1 ? '' : 's'})
							</button>
						{/if}
					</div>
					<div class="col-span-2">
						<label class="mb-1 block text-xs text-[var(--color-text-muted)]">
							Model &amp; Provider
							{#if !hasModelOverride}
								<span class="text-[var(--color-text-muted)]">— showing agent default ({agentProvider}/{agentModel})</span>
							{/if}
						</label>
						<ModelSearchPicker
							selected={hasModelOverride
								? { provider: ov.provider!, model: ov.model! }
								: (agent?.provider && agent?.model ? { provider: agent.provider, model: agent.model } : null)}
							placeholder="Search models... ({agentProvider}/{agentModel})"
							onselect={(provider, model) => updateOverrides(path, { ...ov, provider, model })}
							onclear={hasModelOverride
								? () => updateOverrides(path, { ...ov, provider: undefined, model: undefined })
								: undefined}
						/>
						{#if hasModelOverride}
							<button
								type="button"
								class="mt-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
								onclick={() => updateOverrides(path, { ...ov, provider: undefined, model: undefined })}
							>
								Reset to inherited ({agentProvider}/{agentModel})
							</button>
						{/if}
					</div>
				</div>
				<div class="mt-3">
					<label class="mb-1 block text-xs text-[var(--color-text-muted)]">System Prompt Append</label>
					<textarea
						class={inputClass}
						rows="2"
						value={ov.systemPromptAppend ?? ""}
						placeholder="Additional instructions for this member..."
						onchange={(e) => updateOverrides(path, { ...ov, systemPromptAppend: e.currentTarget.value || undefined })}
					></textarea>
				</div>
				{#if hasOverrides(member)}
					<button
						type="button"
						class="mt-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
						onclick={() => updateOverrides(path, undefined)}
					>
						Reset to defaults
					</button>
				{/if}
			</div>
		{/if}

		<!-- Sub-agent typeahead picker -->
		{#if addingSubAt === pathKey}
			<div class="mt-1" style="margin-left: {depth > 0 ? '1rem' : '0'};">
				{#if availableForSub.length === 0}
					<p class="text-xs text-[var(--color-text-muted)]">No available agents to add.</p>
				{:else}
					<AgentSearchPicker
						agents={availableForSub}
						placeholder="Search for sub-agent..."
						onselect={(agent) => { addSubAgent(path, agent.id); addingSubAt = null; }}
					/>
				{/if}
			</div>
		{/if}

		<!-- Recursive sub-agents -->
		{#if member.subAgents?.length}
			{#each member.subAgents as sub, subIdx (sub.agentConfigId + subIdx)}
				{@render memberRow(sub, [...path, subIdx], depth + 1)}
			{/each}
		{/if}
	</div>
{/snippet}

<form onsubmit={handleSubmit} class="space-y-6">
	<!-- A. Team Metadata -->
	<div class="space-y-4">
		<div>
			<label for="team-name" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Name</label>
			<input id="team-name" type="text" bind:value={name} class={inputClass} placeholder="my-team" />
		</div>

		<div>
			<label for="team-desc" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Description</label>
			<input id="team-desc" type="text" bind:value={description} class={inputClass} placeholder="What does this team do?" />
		</div>

		<div>
			<label for="team-prompt" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Coordination Instructions</label>
			<textarea id="team-prompt" bind:value={prompt} rows="5" class={inputClass} placeholder="Describe how this team should coordinate its members..."></textarea>
		</div>

		<label class="flex items-start gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] p-3">
			<input type="checkbox" bind:checked={autoSpinUp}
				class="mt-0.5 h-4 w-4 rounded border-[var(--color-border)] text-blue-600" />
			<div>
				<span class="text-sm font-medium text-[var(--color-text-primary)]">Auto-invoke all members</span>
				<p class="mt-0.5 text-xs text-[var(--color-text-muted)]">When enabled, all team members are invoked in parallel with the user's message before the orchestrator runs. Results are pre-computed and the orchestrator synthesizes them into a unified response. Best for teams where every member should always contribute.</p>
			</div>
		</label>
	</div>

	<!-- A2. Team-Level Tool Scope (optional) — overrides each member's tool config -->
	<div class="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] p-3">
		<div>
			<span class="text-sm font-medium text-[var(--color-text-primary)]">Team Tool Scope</span>
			<span class="ml-2 text-xs text-[var(--color-text-muted)]">(optional)</span>
			<p class="mt-0.5 text-xs text-[var(--color-text-muted)]">
				When set, these lists apply to every team member and override any tool restrictions configured on the member itself. Orchestration tools (invoke_agent, task tracking, scratchpad) are always preserved.
			</p>
		</div>

		<div>
			<label class="mb-1 block text-xs text-[var(--color-text-muted)]">
				Allowed Tools <span class="text-[var(--color-text-muted)]">(leave empty to allow all)</span>
			</label>
			<ToolSearchPicker
				selected={teamAllowedTools}
				placeholder="Search tools to allow..."
				onchange={(toolNames) => { teamAllowedTools = toolNames; }}
			/>
		</div>

		<div>
			<label class="mb-1 block text-xs text-[var(--color-text-muted)]">Denied Tools</label>
			<ToolSearchPicker
				selected={teamDeniedTools}
				placeholder="Search tools to deny..."
				onchange={(toolNames) => { teamDeniedTools = toolNames; }}
			/>
		</div>
	</div>

	<!-- B. Team Members Tree -->
	<div>
		<label class="mb-2 block text-sm font-medium text-[var(--color-text-secondary)]">Team Members</label>

		{#if members.length === 0}
			<p class="mb-3 text-sm text-[var(--color-text-muted)]">No members added yet. Add agents to build your team.</p>
		{:else}
			<div class="mb-3 space-y-2">
				{#each members as member, idx (member.agentConfigId + idx)}
					{@render memberRow(member, [idx], 0)}
				{/each}
			</div>
		{/if}

		{#if availableAgents.length > 0}
			<AgentSearchPicker
				agents={availableAgents}
				placeholder="Search and add a member..."
				onselect={(agent) => addMember(agent.id)}
			/>
		{/if}
	</div>

	<!-- C. Submit -->
	{#if errorMsg}
		<p class="text-sm text-red-400">{errorMsg}</p>
	{/if}

	<button
		type="submit"
		disabled={submitting}
		class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
	>
		{submitting ? "Saving..." : "Save Team"}
	</button>
</form>
