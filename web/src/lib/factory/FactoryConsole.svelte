<script lang="ts">
	import {
		AlertTriangle,
		Archive,
		CheckCircle2,
		ChevronLeft,
		ChevronRight,
		Download,
		FilePlus2,
		GitBranch,
		History,
		Plus,
		Save,
		Upload,
		X,
	} from "lucide-svelte";
	import {
		type CompilerDiagnostic,
		type FactoryDefinition,
		type FactoryDraftDetails,
		type FactoryDraftSummary,
		type FactoryVersionDetails,
		type FactoryVersionSummary,
	} from "@ezcorp/factory-sdk/types";
	import { isFactoryDefinition } from "@ezcorp/factory-sdk/schema";
	import { FactoryApiClient, FactoryApiClientError, blankFactory, type FactoryAuthoringApi } from "./client";
	import { downloadFactorySource } from "./download";
	import FactoryGraphBoundary from "./FactoryGraphBoundary.svelte";
	import {
		FACTORY_NODE_KINDS,
		ROOT_GRAPH_SCOPE,
		addFactoryNode,
		connectFactoryNodes,
		diffFactoryDefinitions,
		findFactoryNodeScope,
		newFactoryNode,
		parseFactoryNode,
		projectFactoryGraph,
		readFactoryNode,
		removeFactoryEdge,
		removeFactoryNode,
		replaceFactoryNode,
		snapshotFactoryValue,
		type DefinitionDiff,
		type FactoryNodeKind,
		type GraphScope,
	} from "./model";

	export interface FactoryConsoleProject {
		readonly id: string;
		readonly name: string;
	}

	let {
		projects,
		projectId,
		onProjectChange,
		api = new FactoryApiClient(),
	}: {
		projects: readonly FactoryConsoleProject[];
		projectId: string;
		onProjectChange: (projectId: string) => void;
		api?: FactoryAuthoringApi;
	} = $props();

	let drafts = $state<readonly FactoryDraftSummary[]>([]);
	let selected = $state<FactoryDraftDetails | null>(null);
	let source = $state<FactoryDefinition | null>(null);
	let sourceText = $state("");
	let dirty = $state(false);
	let loading = $state(false);
	let saving = $state(false);
	let message = $state("");
	let errorMessage = $state("");
	let createId = $state("");
	let search = $state("");
	let diagnostics = $state<readonly CompilerDiagnostic[]>([]);
	let selectedNodeId = $state<string | null>(null);
	let nodeText = $state("");
	let addKind = $state<FactoryNodeKind>("task");
	let addNodeId = $state("");
	let dependencySource = $state("");
	let scopeStack = $state<Array<{ label: string; scope: GraphScope }>>([{ label: "Root", scope: ROOT_GRAPH_SCOPE }]);
	let tab = $state<"graph" | "source" | "versions">("graph");
	let versions = $state<readonly FactoryVersionSummary[]>([]);
	let publishOpen = $state(false);
	let baselineVersion = $state("");
	let baseline = $state<FactoryVersionDetails | null>(null);
	let definitionDiff = $state<DefinitionDiff | null>(null);
	let publishing = $state(false);
	let conflict = $state<{ mine: FactoryDefinition; server: FactoryDraftDetails } | null>(null);
	let loadedProject = "";
	let importInput: HTMLInputElement;

	let scope = $derived(scopeStack.at(-1)?.scope ?? ROOT_GRAPH_SCOPE);
	let projection = $derived(source ? projectFactoryGraph(source, scope, diagnostics) : { nodes: [], edges: [], childGraphs: [] });
	let selectedNode = $derived(source && selectedNodeId ? readFactoryNode(source, scope, selectedNodeId) : null);
	let filteredDrafts = $derived(drafts.filter(draft => draft.factoryId.toLowerCase().includes(search.trim().toLowerCase())));

	$effect(() => {
		const current = projectId;
		if (!current || current === loadedProject) return;
		void loadDrafts(current);
	});

	async function loadDrafts(targetProject: string): Promise<void> {
		loadedProject = targetProject;
		loading = true;
		errorMessage = "";
		selected = null;
		source = null;
		try {
			drafts = await api.listDrafts(targetProject, { archived: false, limit: 200 });
		} catch (error) {
			errorMessage = describeError(error);
		} finally {
			loading = false;
		}
	}

	async function openDraft(factoryId: string): Promise<void> {
		loading = true;
		errorMessage = "";
		try {
			const details = await api.getDraft(projectId, factoryId);
			installDraft(details);
			versions = await api.listVersions(projectId, factoryId);
		} catch (error) {
			errorMessage = describeError(error);
		} finally {
			loading = false;
		}
	}

	function installDraft(details: FactoryDraftDetails): void {
		selected = details;
		source = snapshotFactoryValue(details.source);
		sourceText = JSON.stringify(details.source, null, 2);
		dirty = false;
		diagnostics = [];
		selectedNodeId = null;
		nodeText = "";
		scopeStack = [{ label: "Root", scope: ROOT_GRAPH_SCOPE }];
		conflict = null;
		message = "";
	}

	function updateSource(next: FactoryDefinition): void {
		source = next;
		sourceText = JSON.stringify(next, null, 2);
		dirty = true;
		diagnostics = [];
		if (selectedNodeId) {
			const node = readFactoryNode(next, scope, selectedNodeId);
			nodeText = node ? JSON.stringify(node, null, 2) : "";
		}
	}

	async function createDraft(): Promise<void> {
		const id = createId.trim();
		if (!id) return;
		loading = true;
		errorMessage = "";
		try {
			const created = await api.createDraft(projectId, blankFactory(id));
			createId = "";
			await loadDrafts(projectId);
			await openDraft(created.factoryId);
		} catch (error) {
			errorMessage = describeError(error);
		} finally {
			loading = false;
		}
	}

	async function importDraft(file: File): Promise<void> {
		const format = file.name.toLowerCase().endsWith(".yaml") || file.name.toLowerCase().endsWith(".yml") ? "yaml" : "json";
		loading = true;
		errorMessage = "";
		try {
			const imported = await api.importDraft(projectId, format, await file.text());
			await loadDrafts(projectId);
			await openDraft(imported.factoryId);
		} catch (error) {
			errorMessage = describeError(error);
		} finally {
			loading = false;
			importInput.value = "";
		}
	}

	async function saveDraft(): Promise<void> {
		if (!selected || !source) return;
		saving = true;
		errorMessage = "";
		try {
			const saved = await api.saveDraft(projectId, selected.factoryId, selected.revision, source);
			selected = { ...selected, ...saved, source };
			dirty = false;
			message = "Draft revision " + saved.revision + " saved.";
			drafts = drafts.map(draft => draft.factoryId === saved.factoryId ? saved : draft);
		} catch (error) {
			if (error instanceof FactoryApiClientError && error.status === 412) {
				const server = await api.getDraft(projectId, selected.factoryId);
				conflict = { mine: source, server };
				selected = server;
				message = "";
			} else {
				errorMessage = describeError(error);
			}
		} finally {
			saving = false;
		}
	}

	async function validateDraft(): Promise<void> {
		if (!selected || !source) return;
		errorMessage = "";
		try {
			const result = await api.validateDraft(projectId, selected.factoryId, source);
			diagnostics = result.diagnostics;
			if (result.valid) {
				message = "Definition is valid and ready to publish.";
			} else {
				message = "";
				errorMessage = `${result.diagnostics.length} validation ${result.diagnostics.length === 1 ? "diagnostic" : "diagnostics"} found.`;
			}
		} catch (error) {
			errorMessage = describeError(error);
		}
	}

	async function exportDraft(format: "json" | "yaml"): Promise<void> {
		if (!selected) return;
		try {
			const exported = await api.exportDraft(projectId, selected.factoryId, format);
			downloadFactorySource(selected.factoryId, exported.format, exported.source);
		} catch (error) {
			errorMessage = describeError(error);
		}
	}

	async function archiveDraft(): Promise<void> {
		if (!selected) return;
		try {
			await api.archiveDraft(projectId, selected.factoryId, selected.revision);
			message = selected.factoryId + " archived.";
			await loadDrafts(projectId);
		} catch (error) {
			errorMessage = describeError(error);
		}
	}

	function selectNode(nodeId: string | null): void {
		selectedNodeId = nodeId;
		const node = source && nodeId ? readFactoryNode(source, scope, nodeId) : null;
		nodeText = node ? JSON.stringify(node, null, 2) : "";
	}

	function applyGraphEdit(edit: () => FactoryDefinition): boolean {
		try {
			updateSource(edit());
			return true;
		} catch (error) {
			errorMessage = describeError(error);
			return false;
		}
	}

	function addNode(): void {
		if (!source || !addNodeId.trim()) return;
		const node = newFactoryNode(addKind, addNodeId.trim());
		if (applyGraphEdit(() => addFactoryNode(source!, scope, node))) {
			selectNode(node.id);
			addNodeId = "";
		}
	}

	function applyNode(): void {
		if (!source || !selectedNodeId) return;
		const currentSource = source;
		const currentNodeId = selectedNodeId;
		let nodeId = currentNodeId;
		if (applyGraphEdit(() => {
			const node = parseFactoryNode(nodeText);
			const candidate = replaceFactoryNode(currentSource, scope, currentNodeId, node);
			if (!isFactoryDefinition(candidate)) throw new Error("The edited node does not match the factory schema.");
			nodeId = node.id;
			return candidate;
		})) selectNode(nodeId);
	}

	function deleteNode(nodeId: string): void {
		if (!source) return;
		if (applyGraphEdit(() => removeFactoryNode(source!, scope, nodeId))) selectNode(null);
	}

	function connectNodes(from: string, to: string): void {
		if (!source) return;
		applyGraphEdit(() => connectFactoryNodes(source!, scope, from, to));
	}

	function deleteEdge(from: string, to: string): void {
		if (source) updateSource(removeFactoryEdge(source, scope, from, to));
	}

	function addDependency(): void {
		if (selectedNodeId && dependencySource) connectNodes(dependencySource, selectedNodeId);
	}

	function applySource(): void {
		try {
			const candidate: unknown = JSON.parse(sourceText);
			if (!isFactoryDefinition(candidate)) throw new Error("Source does not match the factory definition schema.");
			updateSource(candidate as FactoryDefinition);
			selectNode(null);
		} catch (error) {
			errorMessage = describeError(error);
		}
	}

	function enterScope(label: string, nextScope: GraphScope): void {
		scopeStack = [...scopeStack, { label, scope: nextScope }];
		selectNode(null);
	}

	function leaveScope(index: number): void {
		scopeStack = scopeStack.slice(0, index + 1);
		selectNode(null);
	}

	function focusDiagnostic(diagnostic: CompilerDiagnostic): void {
		if (!source || !diagnostic.nodeId) {
			tab = "source";
			return;
		}
		const targetScope = findFactoryNodeScope(source, diagnostic.nodeId);
		if (targetScope) {
			scopeStack = [{ label: targetScope === ROOT_GRAPH_SCOPE ? "Root" : "Located graph", scope: targetScope }];
			tab = "graph";
			selectNode(diagnostic.nodeId);
		}
	}

	async function reviewPublish(): Promise<void> {
		if (!selected || !source) return;
		errorMessage = "";
		try {
			versions = await api.listVersions(projectId, selected.factoryId);
			const latest = [...versions].sort((left, right) => right.publishedAtMs - left.publishedAtMs)[0];
			baselineVersion = latest?.version ?? "";
			await loadBaseline();
			publishOpen = true;
		} catch (error) {
			errorMessage = describeError(error);
		}
	}

	async function loadBaseline(): Promise<void> {
		if (!selected || !source || !baselineVersion) {
			baseline = null;
			definitionDiff = null;
			return;
		}
		baseline = await api.getVersion(projectId, selected.factoryId, baselineVersion);
		definitionDiff = diffFactoryDefinitions(baseline.source, source);
	}

	async function publishVersion(): Promise<void> {
		if (!selected || !source) return;
		publishing = true;
		errorMessage = "";
		try {
			const published = await api.publishVersion(projectId, selected.factoryId, selected.revision, source.version);
			versions = [...versions.filter(item => item.version !== published.version), published];
			publishOpen = false;
			message = "Published immutable version " + published.version + ".";
			tab = "versions";
		} catch (error) {
			errorMessage = describeError(error);
		} finally {
			publishing = false;
		}
	}

	function loadServerConflict(): void {
		if (!conflict) return;
		installDraft(conflict.server);
		message = "Loaded the current server revision.";
	}

	function keepMineConflict(): void {
		if (!conflict) return;
		const mine = conflict.mine;
		conflict = null;
		updateSource(mine);
		message = "Local changes kept on revision " + selected?.revision + ". Save again to apply them.";
	}

	function describeError(error: unknown): string {
		return error instanceof Error ? error.message : "Factory request failed.";
	}
</script>

<section class="factory-console" data-testid="factory-console">
	<header class="factory-masthead">
		<div>
			<p class="eyebrow">Factory control plane</p>
			<h1>Factories</h1>
			<p>Compose work, prove it, then publish an immutable definition.</p>
		</div>
		<label class="project-control">
			<span>Project</span>
			<select value={projectId} onchange={event => onProjectChange(event.currentTarget.value)} aria-label="Factory project">
				{#each projects as project}
					<option value={project.id}>{project.name}</option>
				{/each}
			</select>
		</label>
	</header>

	{#if errorMessage}
		<div class="notice notice-error" role="alert"><AlertTriangle size={16} /> <span>{errorMessage}</span><button aria-label="Dismiss error" onclick={() => errorMessage = ""}><X size={15} /></button></div>
	{/if}
	{#if message}
		<div class="notice notice-ok" role="status"><CheckCircle2 size={16} /> <span>{message}</span><button aria-label="Dismiss message" onclick={() => message = ""}><X size={15} /></button></div>
	{/if}
	{#if conflict}
		<div class="conflict" role="alert" data-testid="factory-conflict">
			<div><strong>Revision conflict</strong><span>The server is at revision {conflict.server.revision}. Choose which source to continue editing.</span></div>
			<button class="button-secondary" onclick={loadServerConflict}>Load server</button>
			<button class="button-primary" onclick={keepMineConflict}>Keep my changes</button>
		</div>
	{/if}

	<div class="factory-workspace">
		<aside class="draft-panel" aria-label="Factory drafts">
			<div class="panel-heading">
				<div><span class="panel-index">01</span><h2>Drafts</h2></div>
				<span>{drafts.length}</span>
			</div>
			<div class="create-row">
				<input bind:value={createId} placeholder="factory.id" aria-label="New factory ID" onkeydown={event => event.key === "Enter" && void createDraft()} />
				<button class="icon-button primary" aria-label="Create factory" title="Create factory" disabled={!createId.trim() || loading} onclick={createDraft}><FilePlus2 size={16} /></button>
				<button class="icon-button" aria-label="Import factory" title="Import JSON or YAML" onclick={() => importInput.click()}><Upload size={16} /></button>
				<input class="sr-only" bind:this={importInput} type="file" accept=".json,.yaml,.yml,application/json,application/yaml" onchange={event => event.currentTarget.files?.[0] && void importDraft(event.currentTarget.files[0])} />
			</div>
			<input class="search-input" bind:value={search} placeholder="Filter drafts" aria-label="Filter factory drafts" />
			<div class="draft-list">
				{#if loading && drafts.length === 0}
					<p class="empty-copy">Loading drafts…</p>
				{:else if filteredDrafts.length === 0}
					<p class="empty-copy">No drafts in this project.</p>
				{/if}
				{#each filteredDrafts as draft}
					<button class:active={selected?.factoryId === draft.factoryId} class="draft-row" onclick={() => openDraft(draft.factoryId)}>
						<span class:unavailable={draft.availability === "unavailable"} class="availability-dot"></span>
						<span><strong title={draft.factoryId}>{draft.factoryId}</strong><small>rev {draft.revision} · {draft.availability}</small></span>
						<ChevronRight size={15} />
					</button>
				{/each}
			</div>
		</aside>

		<main class="editor-panel">
			{#if selected && source}
				<div class="editor-heading">
					<div>
						<p class="eyebrow">Draft revision {selected.revision}{dirty ? " · unsaved" : ""}</p>
						<h2 title={selected.factoryId}>{selected.factoryId}</h2>
						<p>{source.version} · {projection.nodes.length} nodes in this scope</p>
					</div>
					<div class="editor-actions">
						<button class="button-secondary" onclick={validateDraft}><CheckCircle2 size={15} /> Validate</button>
						<button class="button-secondary" onclick={() => exportDraft("json")}><Download size={15} /> JSON</button>
						<button class="button-primary" disabled={!dirty || saving} onclick={saveDraft}><Save size={15} /> {saving ? "Saving…" : "Save"}</button>
						<button class="button-publish" disabled={dirty} title={dirty ? "Save before publishing" : "Review immutable publication"} onclick={reviewPublish}><GitBranch size={15} /> Publish</button>
					</div>
				</div>
				<nav class="editor-tabs" aria-label="Factory editor views">
					<button class:active={tab === "graph"} onclick={() => tab = "graph"}>Graph</button>
					<button class:active={tab === "source"} onclick={() => tab = "source"}>Definition</button>
					<button class:active={tab === "versions"} onclick={() => tab = "versions"}>Versions <span>{versions.length}</span></button>
				</nav>
				{#if tab === "graph"}
					<div class="scope-bar">
						{#each scopeStack as entry, index}
							<button onclick={() => leaveScope(index)}>{entry.label}</button>
							{#if index < scopeStack.length - 1}<ChevronRight size={12} />{/if}
						{/each}
						{#each projection.childGraphs as child}
							<button class="child-scope" onclick={() => enterScope(child.label, child.scope)}>Open {child.label}</button>
						{/each}
					</div>
					<div class="canvas-frame">
						<FactoryGraphBoundary
							{projection}
							{selectedNodeId}
							onSelectNode={selectNode}
							onConnect={connectNodes}
							onDeleteNode={deleteNode}
							onDeleteEdge={deleteEdge}
						/>
					</div>
				{:else if tab === "source"}
					<div class="source-editor">
						<label for="factory-source">Factory definition JSON</label>
						<textarea id="factory-source" bind:value={sourceText} spellcheck="false"></textarea>
						<div><button class="button-primary" onclick={applySource}>Apply source</button></div>
					</div>
				{:else}
					<div class="version-ledger">
						<div class="ledger-header"><History size={17} /><strong>Immutable versions</strong></div>
						{#if versions.length === 0}
							<p>No versions published yet.</p>
						{/if}
						{#each [...versions].sort((a, b) => b.publishedAtMs - a.publishedAtMs) as item}
							<button onclick={async () => { baselineVersion = item.version; await loadBaseline(); publishOpen = true; }}>
								<span><strong>{item.version}</strong><small>draft rev {item.draftRevision}</small></span>
								<code>{item.definitionDigest.slice(0, 18)}…</code>
							</button>
						{/each}
					</div>
				{/if}
			{:else}
				<div class="editor-empty">
					<div class="empty-mark"><GitBranch size={28} /></div>
					<p class="eyebrow">No draft selected</p>
					<h2>Choose a definition to map its work.</h2>
					<p>Create a blank SDK definition or import JSON/YAML. All authoring methods reach the same validated representation.</p>
				</div>
			{/if}
		</main>

		<aside class="inspector-panel" aria-label="Factory inspector">
			<div class="panel-heading"><div><span class="panel-index">02</span><h2>Inspector</h2></div></div>
			{#if selected && source}
				<section class="inspector-section">
					<h3>Add construct</h3>
					<select bind:value={addKind} aria-label="Node kind">
						{#each FACTORY_NODE_KINDS as kind}<option value={kind}>{kind}</option>{/each}
					</select>
					<div class="create-row">
						<input bind:value={addNodeId} aria-label="New node ID" placeholder="node-id" />
						<button class="icon-button primary" aria-label="Add node" disabled={!addNodeId.trim()} onclick={addNode}><Plus size={16} /></button>
					</div>
				</section>
				<section class="inspector-section">
					<h3>Accessible graph outline</h3>
					<div class="outline">
						{#each projection.nodes as node}
							<button class:active={selectedNodeId === node.id} onclick={() => selectNode(node.id)}>
								<span>{node.kind}</span><strong title={node.label}>{node.label}</strong>
								{#if node.diagnosticCount}<em>{node.diagnosticCount}</em>{/if}
							</button>
						{/each}
					</div>
				</section>
				{#if selectedNode}
					<section class="inspector-section node-editor">
						<div class="section-title"><h3>Selected node</h3><button class="danger-link" onclick={() => deleteNode(selectedNode!.id)}>Delete</button></div>
						<textarea bind:value={nodeText} aria-label="Selected node JSON" spellcheck="false"></textarea>
						<label>Dependency from
							<select bind:value={dependencySource}>
								<option value="">Choose a node</option>
								{#each projection.nodes.filter(node => node.id !== selectedNodeId) as node}<option value={node.id}>{node.label}</option>{/each}
							</select>
						</label>
						<div class="inline-actions"><button class="button-secondary" disabled={!dependencySource} onclick={addDependency}>Connect</button><button class="button-primary" onclick={applyNode}>Apply node</button></div>
					</section>
				{/if}
				<section class="inspector-section">
					<div class="section-title"><h3>Diagnostics</h3><span>{diagnostics.length}</span></div>
					{#if diagnostics.length === 0}<p class="empty-copy">Run validation to inspect fields, ports, and nodes.</p>{/if}
					<div class="diagnostics">
						{#each diagnostics as diagnostic}
							<button onclick={() => focusDiagnostic(diagnostic)}>
								<strong>{diagnostic.code}</strong>
								<span>{diagnostic.message}</span>
								<code>{diagnostic.nodeId ?? "definition"} · {diagnostic.path.join(".") || "$"}</code>
							</button>
						{/each}
					</div>
				</section>
				<button class="archive-button" onclick={archiveDraft}><Archive size={14} /> Archive draft</button>
			{:else}
				<p class="empty-copy inspector-empty">Select a draft to edit its graph and inspect diagnostics.</p>
			{/if}
		</aside>
	</div>
</section>

{#if publishOpen && source && selected}
	<div class="modal-backdrop" role="presentation" onclick={event => event.target === event.currentTarget && (publishOpen = false)}>
		<div class="publish-modal" role="dialog" aria-modal="true" aria-labelledby="publish-title">
			<header>
				<div><p class="eyebrow">Immutable publication</p><h2 id="publish-title">Review version {source.version}</h2></div>
				<button class="icon-button" aria-label="Close publish review" onclick={() => publishOpen = false}><X size={17} /></button>
			</header>
			<div class="publish-facts">
				<div><span>Draft revision</span><strong>{selected.revision}</strong></div>
				<div><span>Source digest</span><code>{selected.sourceDigest.slice(0, 16)}…</code></div>
				<div><span>Contract</span><strong>{source.acceptance.id}</strong><small>{source.acceptance.version} · {source.acceptance.claims.length} claims</small></div>
			</div>
			<label class="baseline-select">Compare with published version
				<select bind:value={baselineVersion} onchange={() => loadBaseline()}>
					<option value="">No prior version</option>
					{#each [...versions].sort((a, b) => b.publishedAtMs - a.publishedAtMs) as item}<option value={item.version}>{item.version}</option>{/each}
				</select>
			</label>
			<div class:changed={definitionDiff?.contractChanged} class="diff-summary">
				<strong>{definitionDiff ? definitionDiff.paths.length + " changed fields" : "First publication"}</strong>
				<span>{definitionDiff?.contractChanged ? "Acceptance contract changed. Review both exact sources." : "Acceptance contract unchanged."}</span>
			</div>
			{#if definitionDiff && definitionDiff.paths.length > 0}
				<div class="diff-paths" aria-label="Changed definition paths">
					{#each definitionDiff.paths as path}<code>{path}</code>{/each}
				</div>
			{/if}
			<div class="exact-sources">
				<details open={Boolean(baseline)}>
					<summary>Pinned published source {baseline?.version ?? "(none)"}</summary>
					<pre>{baseline ? JSON.stringify(baseline.source, null, 2) : "No prior immutable version."}</pre>
				</details>
				<details open>
					<summary>Exact source to publish</summary>
					<pre>{JSON.stringify(source, null, 2)}</pre>
				</details>
			</div>
			<footer>
				<p>Publishing stores this definition as an immutable version. It does not activate a runner or package.</p>
				<div><button class="button-secondary" onclick={() => publishOpen = false}>Cancel</button><button class="button-publish" disabled={publishing} onclick={publishVersion}>{publishing ? "Publishing…" : "Publish " + source.version}</button></div>
			</footer>
		</div>
	</div>
{/if}

<style>
	.factory-console { min-height: 100%; background: var(--color-surface); color: var(--color-text-primary); }
	.factory-masthead { display: flex; align-items: end; justify-content: space-between; gap: 24px; border-bottom: 1px solid var(--color-border); padding: 26px 30px 22px; background: linear-gradient(120deg, color-mix(in srgb, var(--color-accent) 9%, var(--color-surface)) 0%, var(--color-surface) 46%, color-mix(in srgb, var(--color-brand) 7%, var(--color-surface)) 100%); }
	.factory-masthead h1 { margin: 2px 0; font-size: clamp(28px, 4vw, 44px); font-weight: 780; letter-spacing: -.04em; line-height: 1; }
	.factory-masthead p:last-child { margin: 8px 0 0; color: var(--color-text-secondary); }
	.eyebrow { margin: 0; font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--color-accent); }
	.project-control { display: grid; min-width: 210px; gap: 5px; font-size: 11px; font-weight: 700; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: .09em; }
	select, input, textarea { box-sizing: border-box; border: 1px solid var(--color-border-strong); border-radius: 3px; background: var(--color-surface-elevated); color: var(--color-text-primary); font: inherit; outline: none; }
	select:focus, input:focus, textarea:focus, button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
	select, input { min-height: 36px; padding: 7px 9px; }
	button { font: inherit; }
	.notice { display: flex; align-items: center; gap: 9px; border-bottom: 1px solid; padding: 9px 28px; font-size: 13px; }
	.notice button { margin-left: auto; border: 0; background: transparent; color: inherit; }
	.notice-error { border-color: var(--color-red-500); background: color-mix(in srgb, var(--color-red-500) 10%, var(--color-surface)); color: var(--color-red-700); }
	.notice-ok { border-color: var(--color-green-500); background: color-mix(in srgb, var(--color-green-500) 9%, var(--color-surface)); color: var(--color-green-700); }
	.conflict { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--color-amber-500); background: color-mix(in srgb, var(--color-amber-400) 13%, var(--color-surface)); padding: 11px 28px; }
	.conflict div { display: grid; margin-right: auto; }
	.conflict span { color: var(--color-text-secondary); font-size: 12px; }
	.factory-workspace { display: grid; min-height: calc(100vh - 143px); grid-template-columns: 252px minmax(0, 1fr) 310px; }
	.draft-panel, .inspector-panel { min-width: 0; background: var(--color-surface-secondary); }
	.draft-panel { border-right: 1px solid var(--color-border); }
	.inspector-panel { border-left: 1px solid var(--color-border); }
	.panel-heading { display: flex; height: 54px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--color-border); padding: 0 14px; }
	.panel-heading div { display: flex; align-items: center; gap: 8px; }
	.panel-heading h2 { margin: 0; font-size: 14px; }
	.panel-heading > span, .section-title > span { font-family: var(--font-mono); font-size: 11px; color: var(--color-text-muted); }
	.panel-index { font-family: var(--font-mono); font-size: 10px; color: var(--color-accent); }
	.create-row { display: flex; gap: 6px; padding: 12px 12px 7px; }
	.create-row input { min-width: 0; flex: 1; }
	.icon-button { display: inline-grid; width: 36px; height: 36px; flex: 0 0 36px; place-items: center; border: 1px solid var(--color-border-strong); border-radius: 3px; background: var(--color-surface-elevated); color: var(--color-text-secondary); }
	.icon-button:hover { border-color: var(--color-accent); color: var(--color-accent); }
	.icon-button.primary { background: var(--color-accent); color: white; border-color: var(--color-accent); }
	.icon-button:disabled, button:disabled { cursor: not-allowed; opacity: .45; }
	.search-input { width: calc(100% - 24px); margin: 0 12px 9px; background: var(--color-surface); }
	.draft-list { max-height: calc(100vh - 320px); overflow: auto; border-top: 1px solid var(--color-border); }
	.draft-row { display: grid; width: 100%; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 9px; border: 0; border-bottom: 1px solid var(--color-border); background: transparent; padding: 12px; text-align: left; color: var(--color-text-primary); }
	.draft-row:hover, .draft-row.active { background: var(--color-surface-elevated); }
	.draft-row.active { box-shadow: inset 3px 0 var(--color-accent); }
	.draft-row span:nth-child(2) { min-width: 0; display: grid; }
	.draft-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
	.draft-row small { margin-top: 2px; color: var(--color-text-muted); font-family: var(--font-mono); font-size: 9px; text-transform: uppercase; }
	.availability-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-green-500); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-green-500) 15%, transparent); }
	.availability-dot.unavailable { background: var(--color-amber-500); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-amber-500) 15%, transparent); }
	.empty-copy { margin: 0; padding: 18px 14px; color: var(--color-text-muted); font-size: 12px; line-height: 1.45; }
	.editor-panel { min-width: 0; background: var(--color-surface); }
	.editor-heading { display: grid; min-height: 104px; align-content: center; gap: 10px; border-bottom: 1px solid var(--color-border); padding: 12px 18px; }
	.editor-heading > div:first-child { min-width: 0; }
	.editor-heading h2 { max-width: 520px; overflow: hidden; margin: 2px 0; text-overflow: ellipsis; white-space: nowrap; font-size: 20px; }
	.editor-heading p:last-child { margin: 0; color: var(--color-text-muted); font-family: var(--font-mono); font-size: 10px; }
	.editor-actions, .inline-actions { display: flex; flex-wrap: wrap; gap: 6px; }
	.button-primary, .button-secondary, .button-publish { display: inline-flex; min-height: 34px; align-items: center; justify-content: center; gap: 6px; border-radius: 3px; padding: 7px 11px; font-size: 12px; font-weight: 700; }
	.button-primary { border: 1px solid var(--color-accent); background: var(--color-accent); color: white; }
	.button-secondary { border: 1px solid var(--color-border-strong); background: var(--color-surface-elevated); color: var(--color-text-secondary); }
	.button-publish { border: 1px solid color-mix(in srgb, var(--color-brand) 76%, black); background: var(--color-brand); color: white; }
	.editor-tabs { display: flex; height: 41px; align-items: end; gap: 2px; border-bottom: 1px solid var(--color-border); padding: 0 16px; }
	.editor-tabs button { height: 40px; border: 0; border-bottom: 2px solid transparent; background: transparent; padding: 0 12px; color: var(--color-text-muted); font-size: 12px; font-weight: 700; }
	.editor-tabs button.active { border-color: var(--color-accent); color: var(--color-text-primary); }
	.editor-tabs span { margin-left: 4px; font-family: var(--font-mono); font-size: 9px; }
	.scope-bar { display: flex; min-height: 38px; align-items: center; gap: 3px; overflow-x: auto; border-bottom: 1px solid var(--color-border); padding: 5px 12px; }
	.scope-bar button { white-space: nowrap; border: 0; background: transparent; color: var(--color-text-secondary); font-size: 11px; }
	.scope-bar .child-scope { margin-left: 8px; border: 1px solid var(--color-border); border-radius: 3px; padding: 4px 7px; background: var(--color-surface-secondary); }
	.canvas-frame { height: calc(100vh - 299px); min-height: 420px; }
	.source-editor { display: grid; gap: 8px; padding: 18px; }
	.source-editor label { font-size: 12px; font-weight: 700; }
	.source-editor textarea { min-height: calc(100vh - 345px); resize: vertical; padding: 14px; font-family: var(--font-mono); font-size: 11px; line-height: 1.55; }
	.source-editor > div { display: flex; justify-content: flex-end; }
	.editor-empty { display: grid; min-height: 580px; place-content: center; justify-items: start; padding: 40px; }
	.editor-empty h2 { max-width: 540px; margin: 8px 0; font-size: clamp(24px, 3vw, 38px); letter-spacing: -.03em; }
	.editor-empty > p:last-child { max-width: 520px; color: var(--color-text-secondary); }
	.empty-mark { display: grid; width: 54px; height: 54px; margin-bottom: 24px; place-items: center; border: 1px solid var(--color-border-strong); background: var(--color-surface-secondary); color: var(--color-accent); transform: rotate(-3deg); }
	.inspector-section { display: grid; gap: 8px; border-bottom: 1px solid var(--color-border); padding: 13px; }
	.inspector-section h3 { margin: 0; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
	.inspector-section .create-row { padding: 0; }
	.section-title { display: flex; align-items: center; justify-content: space-between; }
	.outline { display: grid; max-height: 180px; overflow: auto; gap: 3px; }
	.outline button { display: grid; grid-template-columns: 58px minmax(0,1fr) auto; gap: 5px; border: 1px solid transparent; border-radius: 2px; background: transparent; padding: 6px; text-align: left; }
	.outline button:hover, .outline button.active { border-color: var(--color-border); background: var(--color-surface-elevated); }
	.outline span { font-family: var(--font-mono); font-size: 9px; color: var(--color-accent); text-transform: uppercase; }
	.outline strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
	.outline em { color: var(--color-red-600); font-size: 10px; font-style: normal; }
	.node-editor textarea { min-height: 190px; resize: vertical; padding: 9px; font-family: var(--font-mono); font-size: 10px; line-height: 1.45; }
	.node-editor label { display: grid; gap: 4px; font-size: 10px; color: var(--color-text-muted); }
	.node-editor select, .inspector-section > select { width: 100%; }
	.danger-link { border: 0; background: transparent; color: var(--color-red-600); font-size: 10px; font-weight: 700; }
	.diagnostics { display: grid; gap: 5px; }
	.diagnostics button { display: grid; gap: 3px; border: 1px solid var(--color-border); border-left: 3px solid var(--color-red-500); border-radius: 2px; background: var(--color-surface-elevated); padding: 8px; text-align: left; }
	.diagnostics strong { color: var(--color-red-600); font-family: var(--font-mono); font-size: 9px; }
	.diagnostics span { font-size: 11px; line-height: 1.35; }
	.diagnostics code { overflow: hidden; color: var(--color-text-muted); font-size: 9px; text-overflow: ellipsis; }
	.archive-button { display: flex; margin: 14px; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--color-text-muted); font-size: 11px; }
	.inspector-empty { padding-top: 24px; }
	.version-ledger { display: grid; gap: 8px; padding: 18px; }
	.ledger-header { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
	.version-ledger > button { display: flex; align-items: center; justify-content: space-between; border: 1px solid var(--color-border); border-left: 3px solid var(--color-brand); border-radius: 3px; background: var(--color-surface-secondary); padding: 12px; text-align: left; color: var(--color-text-primary); }
	.version-ledger > button span { display: grid; }
	.version-ledger small, .version-ledger code { color: var(--color-text-muted); font-size: 10px; }
	.modal-backdrop { position: fixed; inset: 0; z-index: 70; display: grid; overflow: auto; place-items: start center; background: rgb(4 8 18 / .72); padding: 4vh 18px; }
	.publish-modal { width: min(980px, 100%); border: 1px solid var(--color-border-strong); border-top: 4px solid var(--color-brand); border-radius: 4px; background: var(--color-surface); box-shadow: var(--shadow-2xl); }
	.publish-modal > header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--color-border); padding: 17px 20px; }
	.publish-modal h2 { margin: 3px 0 0; font-size: 22px; }
	.publish-facts { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid var(--color-border); }
	.publish-facts > div { display: grid; gap: 3px; border-right: 1px solid var(--color-border); padding: 13px 18px; }
	.publish-facts > div:last-child { border: 0; }
	.publish-facts span { color: var(--color-text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
	.publish-facts code, .publish-facts small { color: var(--color-text-secondary); font-size: 10px; }
	.baseline-select { display: grid; gap: 5px; padding: 14px 18px 0; color: var(--color-text-muted); font-size: 11px; }
	.diff-summary { display: flex; justify-content: space-between; gap: 12px; margin: 14px 18px 8px; border: 1px solid var(--color-border); border-left: 4px solid var(--color-green-500); background: var(--color-surface-secondary); padding: 10px; font-size: 12px; }
	.diff-summary.changed { border-left-color: var(--color-amber-500); }
	.diff-summary span { color: var(--color-text-secondary); }
	.diff-paths { display: flex; max-height: 100px; flex-wrap: wrap; gap: 5px; overflow: auto; padding: 0 18px 10px; }
	.diff-paths code { border: 1px solid var(--color-border); background: var(--color-surface-secondary); padding: 3px 5px; font-size: 9px; }
	.exact-sources { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 6px 18px 16px; }
	.exact-sources details { min-width: 0; border: 1px solid var(--color-border); }
	.exact-sources summary { padding: 8px; cursor: pointer; font-size: 11px; font-weight: 700; }
	.exact-sources pre { max-height: 260px; overflow: auto; margin: 0; border-top: 1px solid var(--color-border); background: var(--color-surface-secondary); padding: 10px; font-family: var(--font-mono); font-size: 9px; white-space: pre-wrap; }
	.publish-modal footer { display: flex; align-items: center; justify-content: space-between; gap: 20px; border-top: 1px solid var(--color-border); padding: 14px 18px; }
	.publish-modal footer p { max-width: 550px; margin: 0; color: var(--color-text-muted); font-size: 11px; }
	.publish-modal footer div { display: flex; gap: 8px; }
	.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
	@media (max-width: 1180px) {
		.factory-workspace { grid-template-columns: 220px minmax(0, 1fr); }
		.inspector-panel { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--color-border); border-left: 0; }
		.inspector-panel > .panel-heading { grid-column: 1 / -1; }
		.canvas-frame { height: 520px; }
	}
	@media (max-width: 700px) {
		.factory-masthead { align-items: stretch; flex-direction: column; padding: 20px 16px; }
		.project-control { min-width: 0; }
		.factory-workspace { display: block; }
		.draft-panel { border-right: 0; }
		.draft-list { display: flex; max-height: none; overflow-x: auto; }
		.draft-row { min-width: 220px; border-right: 1px solid var(--color-border); }
		.editor-heading { align-items: stretch; flex-direction: column; padding: 14px; }
		.editor-actions > button { flex: 1 1 auto; }
		.editor-tabs { overflow-x: auto; }
		.canvas-frame { height: 430px; min-height: 430px; }
		.inspector-panel { display: block; }
		.publish-facts, .exact-sources { grid-template-columns: 1fr; }
		.publish-facts > div { border-right: 0; border-bottom: 1px solid var(--color-border); }
		.publish-modal footer, .diff-summary { align-items: stretch; flex-direction: column; }
		.publish-modal footer div { display: grid; grid-template-columns: 1fr 1fr; }
	}
	@media (prefers-reduced-motion: reduce) {
		* { scroll-behavior: auto !important; transition-duration: 0s !important; }
	}
</style>
