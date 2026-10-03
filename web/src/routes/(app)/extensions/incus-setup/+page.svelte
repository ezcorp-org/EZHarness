<script lang="ts">
  import { onMount } from "svelte";

  type Setup = {
    id: string; connectionId: string; providerInstallationId: string; providerReleaseId: string;
    providerGeneration: number; state: string; failures: string[] | null;
    plan: { status: string; planDigest: string; blockedReasons: string[]; steps: Array<{ id: string; description: string; inspect?: { expected: unknown }; apply: { argv: string[] } }> };
    receipt: { state: string; steps: Array<{ id: string; action: string; outcome: string }> } | null;
  };
  type Installation = { id: string; releaseId: string; generation: number; inactive?: boolean };

  let installations = $state<Installation[]>([]);
  let selected = $state("");
  let setup = $state<Setup | null>(null);
  let acknowledged = $state(false);
  let busy = $state(false);
  let message = $state("");
  let probeResult = $state<unknown>(null);

  async function request(action: "plan" | "apply" | "probe") {
    busy = true;
    message = "";
    probeResult = null;
    try {
      const body = action === "plan" ? { action, installationId: selected }
        : action === "apply" ? { action, setupId: setup?.id, planDigest: setup?.plan.planDigest }
        : { action, setupId: setup?.id };
      const response = await fetch("/api/infrastructure/incus/setup", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? `Setup request failed (${response.status})`);
      setup = result.setup as Setup;
      probeResult = action === "probe" ? result.result : null;
      acknowledged = false;
      if (action === "plan") message = setup.plan.status === "ready" ? "Review every server change before you apply it." : "The plan is blocked. Resolve the reasons below, then make a new plan.";
      if (action === "apply") message = setup.state === "verified" ? "Server setup verified. Run the provider probe next." : "The server needs review. Check the receipt before you retry.";
      if (action === "probe") message = "Provider probe finished. Read its result before using this connection.";
    } catch (cause) {
      message = cause instanceof Error ? cause.message : "Setup request failed";
    } finally { busy = false; }
  }

  async function loadInstallations() {
    busy = true;
    try {
      const response = await fetch("/api/infrastructure/incus/setup");
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? `Could not load providers (${response.status})`);
      installations = result.installations ?? [];
      const fromUrl = new URLSearchParams(location.search).get("installationId");
      selected = installations.find(item => item.id === fromUrl)?.id ?? installations[0]?.id ?? "";
      await loadLatest();
    } catch (cause) { message = cause instanceof Error ? cause.message : "Could not load Incus providers"; }
    finally { busy = false; }
  }

  async function loadLatest() {
    setup = null;
    acknowledged = false;
    if (!selected) return;
    const response = await fetch(`/api/infrastructure/incus/setup?installationId=${encodeURIComponent(selected)}`);
    const result = await response.json();
    if (response.ok) setup = result.setup as Setup | null;
    else message = result.message ?? "Could not load the saved plan";
  }

  onMount(() => { void loadInstallations(); });
</script>

<svelte:head>
  <title>Incus server setup · EZHarness</title>
</svelte:head>

<main class="setup-shell">
  <div class="eyebrow">INFRASTRUCTURE / OPERATOR SETUP</div>
  <h1>Connect an Incus server</h1>
  <p class="intro">EZHarness inspects the server over a pinned SSH connection. You review the exact changes before it applies them. The client key stays on the engine host.</p>
  <p><a class="manage-link" href="/extensions/incus-management">Manage qualified environments and project sandboxes →</a></p>

  <div class="steps" aria-label="Setup stages">
    <span class="active">01 Inspect</span><span>02 Review</span><span>03 Apply</span><span>04 Probe</span>
  </div>

  <section class="panel">
    <div class="panel-heading"><span class="number">01</span><div><h2>Choose an approved provider</h2><p>Active Incus releases can make plans. Saved plans from inactive releases remain available for review.</p></div></div>
    {#if installations.length}
      <div class="row">
        <label for="installation">Provider installation</label>
        <select id="installation" bind:value={selected} onchange={() => { message = ""; void loadLatest(); }} disabled={busy}>
          {#each installations as item}<option value={item.id}>{item.id} · release {item.releaseId} · generation {item.generation}{item.inactive ? " · inactive" : ""}</option>{/each}
        </select>
      </div>
      <button class="primary" disabled={busy || !selected || installations.find(item => item.id === selected)?.inactive === true} onclick={() => void request("plan")}>{busy ? "Working…" : "Inspect and make plan"}</button>
    {:else}
      <p class="empty">No active Incus provider release is available. Install, verify, review, and activate one first.</p>
    {/if}
  </section>

  {#if message}<p class="notice" role="status">{message}</p>{/if}

  {#if setup}
    <section class="panel">
      <div class="panel-heading"><span class="number">02</span><div><h2>Review the saved plan</h2><p>Connection {setup.connectionId} · state {setup.state}</p></div></div>
      <div class="digest"><span>PLAN SHA-256</span><code>{setup.plan.planDigest}</code></div>
      {#if setup.plan.blockedReasons.length}
        <div class="blocked"><strong>Blocked</strong><ul>{#each setup.plan.blockedReasons as reason}<li>{reason.replaceAll("_", " ")}</li>{/each}</ul></div>
      {/if}
      <ol class="plan-list">
        {#each setup.plan.steps as step}
          <li><div class="step-title">{step.description}</div><code>{step.apply.argv.join(" ")}</code>
            {#if step.inspect}<details><summary>Verified settings</summary><pre>{JSON.stringify(step.inspect.expected, null, 2)}</pre></details>{/if}
          </li>
        {/each}
      </ol>
      {#if installations.find(item => item.id === selected)?.inactive === true}<p class="empty">This provider is inactive. Its saved plan is available for review, but setup cannot continue.</p>{/if}
      {#if setup.plan.status === "ready" && installations.find(item => item.id === selected)?.inactive !== true && ["planned", "review_required", "reconcile_required"].includes(setup.state)}
        <label class="approval"><input type="checkbox" bind:checked={acknowledged} /> I reviewed this exact plan, its server changes, and its digest.</label>
        <button class="danger" disabled={busy || !acknowledged} onclick={() => void request("apply")}>Apply reviewed plan over SSH</button>
      {/if}
    </section>
    {#if setup.receipt}
      <section class="panel"><div class="panel-heading"><span class="number">03</span><div><h2>Server result</h2><p>{setup.receipt.state}</p></div></div>
        <ul class="receipt">{#each setup.receipt.steps as step}<li><span>{step.id}</span><span>{step.action} · {step.outcome}</span></li>{/each}</ul>
        {#if setup.failures?.length}<div class="blocked"><strong>Review required</strong><ul>{#each setup.failures as failure}<li>{failure}</li>{/each}</ul></div>{/if}
      </section>
    {/if}
    {#if setup.state === "verified" && installations.find(item => item.id === selected)?.inactive !== true}
      <section class="panel"><div class="panel-heading"><span class="number">04</span><div><h2>Probe the provider</h2><p>Check the approved release through its pinned mTLS connection.</p></div></div>
        <button class="primary" disabled={busy} onclick={() => void request("probe")}>Run read-only probe</button>
        {#if probeResult !== null}<pre class="probe">{JSON.stringify(probeResult, null, 2)}</pre>{/if}
      </section>
    {/if}
  {/if}
</main>

<style>
  .setup-shell{max-width:920px;margin:0 auto;padding:32px 24px 96px;color:var(--color-text-primary)}
  .eyebrow{font-size:11px;letter-spacing:.16em;font-weight:700;color:var(--color-accent,#82b5ff)}
  .manage-link{display:inline-block;margin:-12px 0 24px;color:var(--color-accent,#82b5ff);font-size:13px;text-decoration:none}.manage-link:hover{text-decoration:underline}
  h1{font-size:clamp(28px,4vw,42px);line-height:1.1;letter-spacing:-.03em;margin:12px 0}
  .intro{max-width:690px;color:var(--color-text-muted);line-height:1.55;margin-bottom:28px}
  .steps{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px}.steps span{padding:7px 11px;border:1px solid var(--color-border);border-radius:6px;font-size:12px;color:var(--color-text-muted)}.steps .active{color:var(--color-text-primary);border-color:var(--color-accent,#82b5ff)}
  .panel{background:var(--color-surface,#171b23);border:1px solid var(--color-border);border-radius:12px;padding:24px;margin:16px 0;box-shadow:0 10px 32px rgba(0,0,0,.08)}
  .panel-heading{display:flex;gap:16px;align-items:flex-start;margin-bottom:20px}.number{font:700 12px ui-monospace,monospace;color:var(--color-accent,#82b5ff);border:1px solid var(--color-border);padding:6px;border-radius:5px}.panel h2{font-size:18px;margin:0 0 4px}.panel p{margin:0;color:var(--color-text-muted);font-size:13px}
  .row{display:grid;gap:8px;margin-bottom:20px}.row label{font-size:12px;font-weight:700}select{width:100%;padding:11px;border-radius:7px;background:#171b23;border:1px solid var(--color-border);color:#eef3fb}
  button{padding:10px 16px;border-radius:7px;font-weight:700;font-size:13px;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}.primary{background:var(--color-accent,#82b5ff);color:#101722;border:0}.danger{background:#a63c33;color:white;border:0}
  .empty,.notice{padding:14px 16px;border:1px solid var(--color-border);border-radius:7px;color:var(--color-text-muted)}.notice{margin:16px 0}
  .digest{display:grid;gap:8px;background:#171b23;padding:14px;border-radius:7px;margin:20px 0}.digest span{font-size:10px;letter-spacing:.14em;color:#b5c3d8}code{font:12px ui-monospace,monospace;overflow-wrap:anywhere}.digest code{color:#eef3fb}
  .blocked{border-left:3px solid #d98545;background:rgba(217,133,69,.08);padding:12px 16px;margin:18px 0;font-size:13px}.blocked ul{margin:7px 0 0;padding-left:20px}.blocked li{margin:5px 0}
  .plan-list{padding-left:24px;margin:16px 0;max-height:450px;overflow:auto}.plan-list li{padding:10px 0;border-bottom:1px solid var(--color-border)}.step-title{font-weight:600;font-size:13px;margin-bottom:5px}.plan-list code{color:var(--color-text-muted)}
  .plan-list details{margin-top:8px;color:var(--color-text-muted);font-size:12px}.plan-list summary{cursor:pointer}.plan-list pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 0;padding:10px;background:#171b23;color:#eef3fb;border-radius:5px}
  .approval{display:flex;gap:10px;align-items:flex-start;font-size:13px;margin:20px 0 14px}.approval input{margin-top:2px}.receipt{list-style:none;padding:0}.receipt li{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--color-border);padding:8px 0;font-size:12px}.receipt li span:last-child{color:var(--color-text-muted)}.probe{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:420px;overflow:auto;background:#171b23;color:#eef3fb;padding:14px;border-radius:7px}
</style>
