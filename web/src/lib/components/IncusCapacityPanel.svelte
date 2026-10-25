<script lang="ts">
	import type { CapacityReceipt, IncusCapacityPlan } from "$server/infrastructure/incus-operator/capacity";

	let { setupId, onapplied }: { setupId: string; onapplied?: (receipt: CapacityReceipt) => void } = $props();
	let receipt = $state<CapacityReceipt | null>(null);
	let plan = $state<IncusCapacityPlan | null>(null);
	let busy = $state(false);
	let acknowledged = $state(false);
	let uncertain = $state(false);
	let statusKnown = $state(false);
	let error = $state("");
	let selectionEpoch = 0;
	const shownPlan = $derived(receipt?.plan ?? plan);
	const endpoint = "/api/infrastructure/incus/capacity";
	const current = (id: string, epoch: number) => id === setupId && epoch === selectionEpoch;

	function readableError(value: { message?: string } | null, fallback: string): string {
		return value?.message || fallback;
	}

	async function readStatus(id: string): Promise<CapacityReceipt | null> {
		const response = await fetch(`${endpoint}?setupId=${encodeURIComponent(id)}`, { cache: "no-store" });
		const body = await response.json() as { receipt?: CapacityReceipt | null; message?: string };
		if (!response.ok) throw new Error(readableError(body, "Could not check saved capacity."));
		return body.receipt ?? null;
	}

	async function refreshStatus(id = setupId, epoch = selectionEpoch): Promise<void> {
		busy = true;
		error = "";
		try {
			const saved = await readStatus(id);
			if (!current(id, epoch)) return;
			receipt = saved;
			uncertain = false;
			statusKnown = true;
			if (saved) { plan = null; acknowledged = false; }
		} catch (cause) {
			if (current(id, epoch)) error = cause instanceof Error ? cause.message : "Could not check saved capacity.";
		} finally {
			if (current(id, epoch)) busy = false;
		}
	}

	$effect(() => {
		const id = setupId;
		const epoch = ++selectionEpoch;
		receipt = null;
		plan = null;
		acknowledged = false;
		uncertain = false;
		statusKnown = false;
		void refreshStatus(id, epoch);
	});

	async function requestPlan(): Promise<void> {
		if (busy || receipt || uncertain || !statusKnown) return;
		const id = setupId;
		const epoch = selectionEpoch;
		busy = true;
		error = "";
		try {
			const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "plan", setupId: id }) });
			const body = await response.json() as { plan?: IncusCapacityPlan; message?: string };
			if (!response.ok || !body.plan) throw new Error(readableError(body, "Could not plan capacity."));
			if (current(id, epoch)) { plan = body.plan; acknowledged = false; }
		} catch (cause) {
			if (current(id, epoch)) error = cause instanceof Error ? cause.message : "Could not plan capacity.";
		} finally {
			if (current(id, epoch)) busy = false;
		}
	}

	async function applyPlan(): Promise<void> {
		if (busy || !plan || !acknowledged) return;
		const reviewed = plan;
		if (Date.parse(reviewed.expiresAt) <= Date.now()) {
			plan = null;
			acknowledged = false;
			error = "This plan expired. Make a fresh plan before applying capacity.";
			return;
		}
		const id = setupId;
		const epoch = selectionEpoch;
		let applied: CapacityReceipt | null = null;
		let outcomeError = "";
		let needsStatusCheck = false;
		let rejectionMessage = "";
		busy = true;
		error = "";
		try {
			const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "apply", plan: reviewed, planDigest: reviewed.planDigest }) });
			const body = await response.json() as { receipt?: CapacityReceipt; message?: string };
			if (!response.ok) {
				rejectionMessage = readableError(body, "Capacity could not be applied.");
				throw new Error(rejectionMessage);
			}
			if (!body.receipt) throw new Error("Could not confirm capacity application.");
			applied = body.receipt;
		} catch {
			if (!current(id, epoch)) return;
			try {
				applied = await readStatus(id);
				if (!applied && rejectionMessage) outcomeError = `${rejectionMessage} Make a fresh plan after checking the setup and host.`;
				else if (!applied) {
					outcomeError = "Apply result is uncertain. Check saved status before making another plan.";
					needsStatusCheck = true;
				} else if (applied.plan.planDigest !== reviewed.planDigest) outcomeError = "A different capacity plan was saved. Review it before continuing.";
			} catch {
				outcomeError = "Apply result is uncertain and saved status could not be checked. Check status before continuing.";
				needsStatusCheck = true;
			}
		} finally {
			if (current(id, epoch)) {
				receipt = applied;
				plan = null;
				acknowledged = false;
				uncertain = needsStatusCheck;
				error = outcomeError;
				busy = false;
			if (applied?.plan.planDigest === reviewed.planDigest) {
				onapplied?.(applied);
			}
			}
		}
	}

	function gib(bytes: number): string {
		return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(bytes / 1024 ** 3)} GiB`;
	}
</script>

<section class="capacity" aria-labelledby="capacity-title" data-testid="incus-capacity-panel">
	<header class="heading">
		<div><p class="eyebrow">HOST CAPACITY</p><h2 id="capacity-title">Set sandbox limits</h2>
			<p class="intro">Read current host headroom, review the safe limits, then apply the exact plan.</p></div>
		<span class:ready={receipt} class="state">{receipt ? "Applied" : plan ? "Review plan" : "Not set"}</span>
	</header>
	{#if error}<p class="message error text-red-700 dark:text-red-300" role="alert">{error}</p>{/if}
	{#if busy}<p class="message" role="status">Checking capacity…</p>{/if}
	{#if shownPlan}
		<div class="measurements" aria-label="Sandbox host capacity">
			<div><span>Memory</span><strong>{gib(shownPlan.capacity.allocatable.memoryBytes)}</strong></div>
			<div><span>CPU</span><strong>{shownPlan.capacity.allocatable.cpuMillicores / 1000} cores</strong></div>
			<div><span>Disk</span><strong>{gib(shownPlan.capacity.allocatable.diskBytes)}</strong></div>
			<div><span>Processes</span><strong>{shownPlan.capacity.allocatable.pids}</strong></div>
			<div><span>Sandboxes</span><strong>{shownPlan.capacity.allocatable.executionSlots}</strong></div>
		</div>
		<div class="plan-details"><span>Host {shownPlan.observation.hostId}</span>
			<span>{receipt ? `Applied ${new Date(receipt.appliedAt).toLocaleString()}` : `Expires ${new Date(shownPlan.expiresAt).toLocaleString()}`}</span></div>
		<div class="digest"><span>Exact plan SHA-256</span><code>{shownPlan.planDigest}</code></div>
	{/if}
	{#if receipt}
		<p class="message success" role="status">Capacity is saved for this verified setup.</p>
	{:else if plan}
		<label class="approval"><input type="checkbox" bind:checked={acknowledged} disabled={busy} />
			<span>I reviewed these host limits and the exact plan digest.</span></label>
		<button class="apply" disabled={busy || !acknowledged} onclick={() => void applyPlan()}>Apply reviewed capacity</button>
	{:else}
		<div class="actions">
			<button class="plan" disabled={busy || uncertain || !statusKnown} onclick={() => void requestPlan()}>Plan capacity</button>
			{#if uncertain || error}<button class="secondary" disabled={busy} onclick={() => void refreshStatus()}>Check saved status</button>{/if}
		</div>
	{/if}
</section>

<style>
	.capacity{border:1px solid var(--color-border);border-radius:14px;background:var(--color-surface-secondary);padding:24px;color:var(--color-text-primary)}
	.heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.heading h2{font-size:1.2rem;font-weight:700;letter-spacing:-.025em;margin:3px 0 6px}.eyebrow{font-size:.67rem;letter-spacing:.15em;font-weight:800;color:var(--color-accent);margin:0}.intro{font-size:.86rem;line-height:1.5;color:var(--color-text-muted);margin:0;max-width:35rem}
	.state{border:1px solid var(--color-border);border-radius:999px;padding:5px 10px;color:var(--color-text-muted);font-size:.72rem;white-space:nowrap}.state.ready{color:var(--color-accent);border-color:var(--color-accent)}
	.measurements{display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:1px;background:var(--color-border);border:1px solid var(--color-border);border-radius:9px;overflow:hidden;margin-top:20px}.measurements>div{background:var(--color-surface-secondary);padding:14px 12px;min-width:0}.measurements span{display:block;color:var(--color-text-muted);font-size:.7rem;margin-bottom:7px}.measurements strong{font-size:1rem;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
	.plan-details{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 18px;color:var(--color-text-muted);font-size:.75rem;margin-top:13px}.digest{display:flex;flex-wrap:wrap;gap:5px 12px;margin:12px 0 16px;font-size:.72rem;color:var(--color-text-muted)}.digest code{color:var(--color-text-primary);overflow-wrap:anywhere;word-break:break-all}
	.message{border-radius:8px;padding:10px 12px;margin:18px 0 0;background:var(--color-surface-tertiary);font-size:.82rem}.message.error{border:1px solid #ba654e}.message.success{border:1px solid var(--color-accent);color:var(--color-accent)}
	.approval{display:flex;align-items:flex-start;gap:10px;font-size:.82rem;line-height:1.4;margin:18px 0 12px;cursor:pointer}.approval input{margin-top:2px;accent-color:var(--color-accent)}.actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:20px}
	button{border-radius:7px;padding:9px 14px;font-size:.8rem;font-weight:700;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}.plan,.apply{background:var(--color-accent);border:1px solid var(--color-accent);color:var(--color-surface-primary,#101722)}.secondary{background:transparent;border:1px solid var(--color-border);color:var(--color-text-primary)}
	@media(max-width:520px){.capacity{padding:18px}.heading{flex-direction:column}.measurements{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
