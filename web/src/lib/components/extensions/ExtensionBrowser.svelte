<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import { CanvasBridge, type CanvasMethod } from "$lib/extensions/canvas-bridge";
  import { SANDBOX_FLAGS_STRICT } from "$lib/components/tool-cards/iframe-card-logic";
  import { userFetch } from "$lib/utils/fetch-policy";

  let { name, binding, nonce, conversationId, tools }: { name: string; binding: string; nonce: string; conversationId: string; tools: string[] } = $props();
  const context = untrack(() => ({ name, binding, nonce, conversationId, tools: [...tools] }));
  const endpoint = `/api/extensions/${encodeURIComponent(context.name)}/preview`;
  const iframeSrc = `${endpoint}?${new URLSearchParams({ binding: context.binding, conversationId: context.conversationId, nonce: context.nonce })}`;
  let iframe = $state<HTMLIFrameElement>();
  let video: HTMLVideoElement | undefined;
  let dialog: HTMLDialogElement | undefined;
  let unavailable = $state(false);
  let mounted = $state(false);
  let cameraError = $state("");
  let starting = $state(false);
  let camera = $state<{ id: string; stream: MediaStream; timer: ReturnType<typeof setInterval>; expiry: ReturnType<typeof setTimeout> } | null>(null);
  let pendingCamera = $state<{ resolve: (value: unknown) => void; reject: (error: Error) => void; signal: AbortSignal; abort: () => void } | null>(null);
  let pumping = false;

  async function request(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const requestSignal = signal ? AbortSignal.any([bridge.signal, signal]) : bridge.signal;
    const response = await userFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, signal: requestSignal, body: JSON.stringify({ ...body, binding: context.binding, conversationId: context.conversationId }) });
    if (response.status === 403 || response.status === 404) bridge.close();
    if (!response.ok) throw new Error("Preview request failed");
    return response.json();
  }

  function stopCamera(reason: string): void {
    const current = camera;
    camera = null;
    if (current) {
      clearInterval(current.timer);
      clearTimeout(current.expiry);
      for (const track of current.stream.getTracks()) track.stop();
      if (video) video.srcObject = null;
      bridge.send({ type: "ezcorp.canvas.camera-stopped", sessionId: current.id, reason });
    }
    const pending = pendingCamera;
    pendingCamera = null;
    if (pending) { pending.signal.removeEventListener("abort", pending.abort); pending.reject(new Error("Camera request cancelled")); }
  }

  async function pump(): Promise<void> {
    const current = camera;
    if (!current || pumping || !video?.videoWidth) return;
    pumping = true;
    try {
      await request({ method: "check" });
      if (camera !== current || !video) return;
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const drawing = canvas.getContext("2d");
      if (!drawing) throw new Error("Camera frame unavailable");
      drawing.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
      if (dataUrl.length > 512 * 1024) throw new Error("Camera frame exceeds limit");
      bridge.send({ type: "ezcorp.canvas.camera", sessionId: current.id, dataUrl });
    } catch { stopCamera("access-or-camera-unavailable"); cameraError = "Camera stopped. Access changed or a frame could not be captured."; }
    finally { pumping = false; }
  }

  async function startCamera(): Promise<void> {
    const pending = pendingCamera;
    if (!pending || starting) return;
    starting = true;
    cameraError = "";
    let stream: MediaStream | undefined;
    try {
      await request({ method: "check" }, pending.signal);
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (pending.signal.aborted || pendingCamera !== pending || unavailable) throw new Error("Camera request expired");
      await tick();
      if (!video) throw new Error("Camera view unavailable");
      video.srcObject = stream;
      await video.play();
      if (pending.signal.aborted || pendingCamera !== pending || unavailable) throw new Error("Camera request expired");
      const id = crypto.randomUUID();
      camera = { id, stream, timer: setInterval(() => { void pump(); }, 500), expiry: setTimeout(() => stopCamera("expired"), 300_000) };
      pendingCamera = null;
      pending.signal.removeEventListener("abort", pending.abort);
      pending.resolve({ sessionId: id });
    } catch {
      for (const track of stream?.getTracks() ?? []) track.stop();
      stopCamera("cancelled");
      cameraError = "Camera unavailable. Check browser permission, then request it again.";
    } finally { starting = false; }
  }

  async function dispatch(method: CanvasMethod, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (method === "tool.invoke") {
      if (Object.keys(params).some(key => !["toolName", "input"].includes(key)) || typeof params.toolName !== "string" || !context.tools.includes(params.toolName) || !params.input || typeof params.input !== "object" || Array.isArray(params.input)) throw new Error("Tool not exposed");
      return request({ method, toolName: params.toolName, input: params.input }, signal);
    }
    if (method === "camera.stop") {
      if (Object.keys(params).length !== 1 || typeof params.sessionId !== "string" || (camera && params.sessionId !== camera.id)) throw new Error("Camera session mismatch");
      stopCamera("stopped");
      return { stopped: true };
    }
    if (Object.keys(params).length || pendingCamera) throw new Error("Camera request already pending");
    await request({ method: "check" }, signal);
    if (camera) return { sessionId: camera.id };
    if (signal.aborted) throw new Error("Camera request expired");
    return new Promise((resolve, reject) => {
      const abort = () => stopCamera("cancelled");
      pendingCamera = { resolve, reject, signal, abort };
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  const bridge = new CanvasBridge(() => iframe?.contentWindow, context.nonce, dispatch, () => { unavailable = true; stopCamera("preview-closed"); });
  onMount(() => { mounted = true; });
  onDestroy(() => bridge.close());
  $effect(() => { if (pendingCamera) { if (dialog && !dialog.open) dialog.showModal(); } else dialog?.close(); });
</script>

<svelte:window onmessage={event => bridge.connect(event)} onpagehide={() => bridge.close()} />
<section class="extension-browser" aria-label={`${context.name} isolated preview`}>
  <div class="trust-bar"><span class="status-dot"></span><strong>Isolated preview</strong><span>Only this extension's selected tools are available.</span></div>
  {#if camera}<div class="camera-status"><span class="live">● Camera sharing · up to 2 frames per second</span><button onclick={() => stopCamera("stopped")}>Stop camera</button></div>{/if}
  {#if unavailable}<div class="notice" role="alert">Preview closed because access changed or its document navigated. Reopen it to continue.</div>{/if}
  {#if cameraError}<div class="notice" role="status">{cameraError}</div>{/if}
  {#if mounted}<iframe bind:this={iframe} title={`${context.name} preview`} src={iframeSrc} sandbox={SANDBOX_FLAGS_STRICT} referrerpolicy="no-referrer" onload={() => bridge.loaded()}></iframe>{/if}
</section>
<dialog bind:this={dialog} oncancel={event => { event.preventDefault(); stopCamera("cancelled"); }} aria-labelledby="camera-consent-title">
  <div class="camera-dialog">
    <span class="eyebrow">HOST CAMERA CONTROL</span>
    <h2 id="camera-consent-title">{camera ? "Camera is sharing frames" : `Share camera frames with ${context.name}?`}</h2>
    <p>The extension will receive camera images. Start only if you trust this release. Sharing stops after five minutes, when access changes, or when you leave this preview.</p>
    <video bind:this={video} muted playsinline aria-label="Host camera preview"></video>
    <div class="camera-actions">
      {#if camera}<span class="live">● Live · up to 2 frames per second</span><button class="primary" onclick={() => stopCamera("stopped")}>Stop camera</button>
      {:else}<button onclick={() => stopCamera("cancelled")}>Cancel</button><button class="primary" disabled={starting} onclick={startCamera}>{starting ? "Opening camera…" : "Start camera"}</button>{/if}
    </div>
  </div>
</dialog>

<style>
  .extension-browser{border:1px solid var(--color-border);border-radius:.75rem;overflow:hidden;background:var(--color-surface)}
  .trust-bar{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap;padding:.85rem 1rem;border-bottom:1px solid var(--color-border);font-size:.8rem;color:var(--color-text-muted)}
  .trust-bar strong{color:var(--color-text-primary)}.status-dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--color-accent)}
  iframe{width:100%;height:min(78vh,65rem);min-height:32rem;display:block;border:0;background:white}
  .notice{padding:1rem;border-bottom:1px solid var(--color-border);color:var(--color-text-primary)}
  dialog{width:min(44rem,calc(100vw - 2rem));padding:0;border:1px solid var(--color-border);border-radius:1rem;background:var(--color-surface);color:var(--color-text-primary);box-shadow:0 24px 80px #0008}
  dialog::backdrop{background:#0009;backdrop-filter:blur(3px)}.camera-dialog{padding:1.5rem}.eyebrow{font-size:.7rem;letter-spacing:.12em;font-weight:700;color:var(--color-accent)}
  h2{font-size:1.4rem;font-weight:600;margin:.65rem 0}p{line-height:1.6;color:var(--color-text-muted);margin:0 0 1rem}
  video{display:block;width:100%;max-height:45vh;min-height:8rem;background:#111;border-radius:.5rem;object-fit:contain}
  .camera-actions{display:flex;align-items:center;justify-content:flex-end;gap:.75rem;margin-top:1.2rem;flex-wrap:wrap}.camera-status{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.75rem 1rem;border-bottom:1px solid var(--color-border)}.live{margin-right:auto;color:var(--color-accent);font-size:.8rem}
  button{padding:.65rem 1rem;border:1px solid var(--color-border);border-radius:.5rem;background:var(--color-surface);color:var(--color-text-primary);cursor:pointer}.primary{background:var(--color-accent);color:var(--color-accent-contrast);font-weight:600}button:disabled{opacity:.6;cursor:wait}
</style>
