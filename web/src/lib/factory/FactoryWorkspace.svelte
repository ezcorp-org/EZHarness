<script lang="ts" module>
	export type FactoryWorkspaceView = "authoring" | "runs" | "inbox" | "admin";
	export const FACTORY_WORKSPACE_VIEWS: readonly FactoryWorkspaceView[] = ["authoring", "runs", "inbox", "admin"];

	/** The view named in the URL, or authoring. An unknown value is never trusted as a view. */
	export function factoryWorkspaceView(value: string | null): FactoryWorkspaceView {
		return FACTORY_WORKSPACE_VIEWS.find(view => view === value) ?? "authoring";
	}
</script>

<script lang="ts">
	import { Activity, GitBranch, Inbox, ShieldCheck } from "lucide-svelte";
	import FactoryAdministration from "./FactoryAdministration.svelte";
	import FactoryConsole from "./FactoryConsole.svelte";
	import FactoryReleaseInbox from "./FactoryReleaseInbox.svelte";
	import FactoryRunInspector from "./FactoryRunInspector.svelte";

	export interface FactoryWorkspaceProject {
		readonly id: string;
		readonly name: string;
	}

	let {
		projects,
		projectId,
		onProjectChange,
		view,
		onViewChange,
		tenantId,
		administrator,
	}: {
		projects: readonly FactoryWorkspaceProject[];
		projectId: string;
		onProjectChange: (projectId: string) => void;
		view: FactoryWorkspaceView;
		onViewChange: (view: FactoryWorkspaceView) => void;
		tenantId: string | null;
		administrator: boolean;
	} = $props();

	const TABS: readonly { readonly view: FactoryWorkspaceView; readonly label: string; readonly icon: typeof GitBranch }[] = [
		{ view: "authoring", label: "Authoring", icon: GitBranch },
		{ view: "runs", label: "Runs", icon: Activity },
		{ view: "inbox", label: "Inbox", icon: Inbox },
		{ view: "admin", label: "Administration", icon: ShieldCheck },
	];
	const tabElements: Record<string, HTMLButtonElement | undefined> = {};

	// On a narrow screen the rail scrolls; keep the selected tab in view.
	$effect(() => { tabElements[view]?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); });

	/** Arrow keys, Home, and End move between tabs and select, as the ARIA tab pattern describes. */
	function onTabKey(event: KeyboardEvent, index: number): void {
		const last = TABS.length - 1;
		const target = event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
			: event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
			: event.key === "Home" ? 0
			: event.key === "End" ? last
			: -1;
		if (target < 0) return;
		event.preventDefault();
		const next = TABS[target]!.view;
		onViewChange(next);
		tabElements[next]?.focus();
	}
</script>

<section class="factory-shell" data-testid="factory-workspace">
	<header class="factory-masthead">
		<div class="masthead-copy">
			<p class="eyebrow">Factory control plane</p>
			<h1>Factories</h1>
			<p>Compose work, prove it, then publish an immutable definition.</p>
		</div>
		<label class="project-control">
			<span>Project</span>
			<select value={projectId} onchange={event => onProjectChange(event.currentTarget.value)} aria-label="Factory project">
				{#each projects as project (project.id)}
					<option value={project.id}>{project.name}</option>
				{/each}
			</select>
		</label>
	</header>

	<div class="tab-rail" role="tablist" aria-label="Factory views">
		{#each TABS as tab, index (tab.view)}
			{@const Icon = tab.icon}
			<button
				bind:this={tabElements[tab.view]}
				role="tab"
				id={`factory-tab-${tab.view}`}
				aria-selected={view === tab.view}
				aria-controls={`factory-panel-${tab.view}`}
				tabindex={view === tab.view ? 0 : -1}
				class:active={view === tab.view}
				onclick={() => onViewChange(tab.view)}
				onkeydown={event => onTabKey(event, index)}
			><Icon size={15} /><span>{tab.label}</span></button>
		{/each}
	</div>

	<div class="tab-panel" role="tabpanel" id={`factory-panel-${view}`} aria-labelledby={`factory-tab-${view}`}>
		{#if view === "authoring"}
			<FactoryConsole {projectId} />
		{:else if view === "runs"}
			<FactoryRunInspector {projectId} onOpenInbox={() => onViewChange("inbox")} />
		{:else if view === "inbox"}
			<FactoryReleaseInbox {projectId} />
		{:else}
			<FactoryAdministration {projectId} {tenantId} {administrator} />
		{/if}
	</div>
</section>

<style>
	.factory-shell { min-height: 100%; background: var(--color-surface); color: var(--color-text-primary); }
	.factory-masthead { display: flex; align-items: end; justify-content: space-between; gap: 24px; border-bottom: 1px solid var(--color-border); padding: 26px 30px 22px; background: linear-gradient(120deg, color-mix(in srgb, var(--color-accent) 9%, var(--color-surface)) 0%, var(--color-surface) 46%, color-mix(in srgb, var(--color-brand) 7%, var(--color-surface)) 100%); }
	.masthead-copy { min-width: 0; }
	.factory-masthead h1 { margin: 2px 0; font-size: clamp(28px, 4vw, 44px); font-weight: 780; letter-spacing: -.04em; line-height: 1; }
	.masthead-copy > p:last-child { margin: 8px 0 0; color: var(--color-text-secondary); }
	.eyebrow { margin: 0; font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--color-accent); }
	.project-control { display: grid; min-width: 210px; gap: 5px; font-size: 11px; font-weight: 700; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: .09em; }
	.project-control select { box-sizing: border-box; min-height: 36px; border: 1px solid var(--color-border-strong); border-radius: 3px; background: var(--color-surface-elevated); padding: 7px 9px; color: var(--color-text-primary); font: inherit; font-size: 13px; letter-spacing: normal; text-transform: none; }
	.project-control select:focus, .tab-rail button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
	.tab-rail { display: flex; gap: 2px; overflow-x: auto; border-bottom: 1px solid var(--color-border); padding: 0 22px; background: var(--color-surface-secondary); scrollbar-width: none; }
	.tab-rail::-webkit-scrollbar { display: none; }
	.tab-rail button { display: inline-flex; flex: 0 0 auto; min-height: 44px; align-items: center; gap: 7px; border: 0; border-bottom: 2px solid transparent; background: transparent; padding: 0 14px; color: var(--color-text-muted); font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; }
	.tab-rail button:hover { color: var(--color-text-primary); }
	.tab-rail button.active { border-bottom-color: var(--color-accent); color: var(--color-text-primary); }
	.tab-panel { min-width: 0; }
	@media (max-width: 700px) {
		.factory-masthead { align-items: stretch; flex-direction: column; gap: 16px; padding: 20px 16px; }
		.project-control { min-width: 0; }
		.tab-rail { padding: 0 8px; }
		.tab-rail button { padding: 0 11px; }
	}
	@media (prefers-reduced-motion: reduce) {
		* { scroll-behavior: auto !important; transition-duration: 0s !important; animation-duration: 0s !important; }
	}
</style>
