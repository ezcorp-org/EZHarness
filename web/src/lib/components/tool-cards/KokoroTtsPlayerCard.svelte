<!--
  KokoroTtsPlayerCard — in-browser Kokoro-TTS player.

  Lifecycle:
    1. running (no output yet): synthesize the WAV from
       `toolCall.input.text` via the kokoro-tts bridge (which runs
       kokoro-js in a Web Worker so the main thread stays responsive),
       render <audio controls> against a blob URL, start playback.
       Then upload the WAV via /api/extensions/kokoro-tts/uploads →
       { attachmentId }, and POST the kokoro-tts:save event so the
       subprocess finalizes the tool-call output ({ attachmentId }).
    2. complete (output.attachmentId set, e.g. after page reload):
       render <audio> straight against /api/attachments/{id}. The blob
       URL is gone but the WAV is durable in attachment storage.
    3. error: synthesis or upload failure surfaces a red strip with a
       "Retry" button that re-runs the same flow against the same
       toolCallId — we never create a new turn for retries.

  Card invariants:
    - Component never throws. Every async path catches into the local
      `error` state.
    - Blob URL is revoked when the audio element unmounts to avoid
      leaking session-scoped object URLs.
    - kokoro-js runs inside a Web Worker (see
      `$lib/workers/kokoro-tts-worker.ts`) so the (multi-second) WASM
      compile + ONNX inference don't freeze the page. The worker is
      spawned lazily on first synthesize() call by the bridge, then
      reused — same model serves every subsequent synthesis.
    - Tests mock the bridge directly via `vi.mock("$lib/workers/kokoro-tts-bridge", …)`.
-->

<script lang="ts">
  import { onMount } from "svelte";
  import type { ToolCallState } from "$lib/stores.svelte.js";
  import { userFetch } from "$lib/utils/fetch-policy.js";
  import { addToast } from "$lib/toast.svelte.js";
  import { synthesize } from "$lib/workers/kokoro-tts-bridge";
  import { getCachedSettings } from "$lib/stores/extensionSettings";

  let {
    toolCall,
    conversationId,
    messageId,
  }: { toolCall: ToolCallState; conversationId?: string; messageId?: string } = $props();

  // ── Parse input ────────────────────────────────────────────────
  // The kokoro-tts subprocess emits `input: { text }` only — `messageId`
  // is plumbed through ToolCardRouter as a prop (every card receives it),
  // which avoids round-tripping the new turn's id through the JSON-RPC
  // pipe just to feed it back to the upload route.
  let parsedInput = $derived.by((): { text: string } => {
    const inp = toolCall.input;
    if (!inp || typeof inp !== "object") return { text: "" };
    const obj = inp as Record<string, unknown>;
    return { text: typeof obj.text === "string" ? obj.text : "" };
  });

  // ── Parse output (persisted state) ─────────────────────────────
  //
  // `toolCall.output` shows up in TWO shapes depending on where it
  // came from:
  //   1. **In-process / live update** — a plain object
  //      `{ attachmentId: "…" }` (e.g. if the page never reloaded and
  //      something pushed an updated tool-call payload directly).
  //   2. **DB-hydration path on reload** — a *string* containing the
  //      JSON. `handleFinalizeToolCallRpc` stores the row's `output`
  //      as `{ content: [{ type: "text", text: '{"attachmentId":"…"}' }] }`
  //      (the standard tool-call envelope). `toolCallRowToSummary`
  //      then extracts the inner text via `extractOutputText`, and
  //      `inlineToolStore.hydrateToolCalls` ships that string as
  //      `output`. By the time it reaches the card, `output` is
  //      `'{"attachmentId":"…"}'`, NOT the original object.
  //
  // Both shapes must be recognised here — otherwise the card thinks
  // the tool call is still running and re-runs synthesis on every
  // page reload (silent regression: audio plays but never actually
  // persists in the user's perception).
  let persistedAttachmentId = $derived.by((): string | null => {
    const out = toolCall.output;
    if (out == null) return null;

    let candidate: unknown = out;
    if (typeof candidate === "string") {
      try {
        candidate = JSON.parse(candidate);
      } catch {
        return null;
      }
    }
    if (!candidate || typeof candidate !== "object") return null;

    // Direct shape — used by tests + any in-process update path.
    const direct = (candidate as Record<string, unknown>).attachmentId;
    if (typeof direct === "string") return direct;

    // Envelope shape — `{ content: [{ type: "text", text }] }`. Defensive:
    // the hydration path normally unwraps this server-side, but if
    // the raw envelope ever leaks through we still recognise it
    // instead of falling back to "running" and re-synthesizing.
    const content = (candidate as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (
          part != null &&
          typeof part === "object" &&
          (part as Record<string, unknown>).type === "text"
        ) {
          const text = (part as Record<string, unknown>).text;
          if (typeof text === "string") {
            try {
              const inner = JSON.parse(text);
              if (
                inner != null &&
                typeof inner === "object" &&
                typeof (inner as Record<string, unknown>).attachmentId === "string"
              ) {
                return (inner as Record<string, unknown>).attachmentId as string;
              }
            } catch {
              // Not JSON — keep scanning, no extracted id from this part.
            }
          }
        }
      }
    }

    return null;
  });

  // ── Local UI state ─────────────────────────────────────────────
  let blobUrl = $state<string | null>(null);
  let synthesizing = $state(false);
  let uploading = $state(false);
  let error = $state<string | null>(null);
  let attempts = $state(0);
  // Tracks the worker's current loading phase so the UI can surface
  // "Loading model…" during the multi-second first-call WASM compile.
  // `null` means the worker hasn't reported a phase yet (or has
  // finished loading and is now generating audio).
  let loadingPhase = $state<"model" | "voice" | null>(null);

  let isPersisted = $derived(persistedAttachmentId != null);
  let persistedSrc = $derived(persistedAttachmentId ? `/api/attachments/${persistedAttachmentId}` : null);

  onMount(() => {
    console.info("[kokoro-tts-flow][card] mounted", {
      toolCallId: toolCall.id,
      cardType: toolCall.cardType,
      isPersisted,
      hasInput: !!toolCall.input,
      inputTextLength: parsedInput.text.length,
    });
  });

  /**
   * Run the full synth → upload → save flow. Idempotent against the
   * same `toolCall.id`: backend keys saves by toolCallId, so retries
   * either replace the in-flight attachment or no-op once finalized.
   */
  async function runSynthesisFlow(): Promise<void> {
    if (synthesizing || uploading || isPersisted) return;
    if (!parsedInput.text) {
      error = "No text to synthesize";
      return;
    }
    error = null;
    synthesizing = true;
    attempts++;

    let blob: Blob | null = null;
    try {
      // Synthesis runs in a Worker (see $lib/workers/kokoro-tts-worker.ts)
      // so the main thread stays responsive — the WASM compile +
      // ONNX inference would otherwise freeze the page for several
      // seconds. The bridge owns Worker spawn / reuse / id correlation.
      // Voice + speed come from the per-extension settings store
      // (populated by the chat layout); fall back to the manifest defaults
      // when the cache hasn't been hydrated yet.
      const s = getCachedSettings("kokoro-tts") ?? {};
      const voice = (typeof s.voice === "string" && s.voice) || "af_bella";
      const speed = (typeof s.speed === "number" && s.speed) || 1.0;
      blob = await synthesize(parsedInput.text, {
        voice,
        speed,
        onLoading: (phase) => {
          loadingPhase = phase;
        },
        onReady: () => {
          loadingPhase = null;
        },
      });
    } catch (err) {
      synthesizing = false;
      loadingPhase = null;
      const msg = err instanceof Error ? err.message : String(err);
      error = msg;
      addToast({ type: "error", message: `TTS synthesis failed: ${msg}` });
      return;
    }

    synthesizing = false;
    loadingPhase = null;
    if (!blob) {
      error = "Synthesis returned no audio";
      addToast({ type: "error", message: "TTS synthesis returned no audio" });
      return;
    }

    // Render immediately — user gets audio playback before the upload
    // round-trip finishes.
    revokeBlobUrl();
    blobUrl = URL.createObjectURL(blob);

    // Upload + finalize in the background. Errors land in `error` but
    // playback already works against the blob URL.
    uploading = true;
    try {
      const attachmentId = await uploadWav(blob);
      await postSaveEvent(attachmentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error = msg;
      // The blob URL still plays — surface the persistence failure as
      // a non-blocking toast rather than a destructive error overlay.
      addToast({
        type: "warning",
        message: `Audio playback works, but saving for reload failed: ${msg}`,
      });
    } finally {
      uploading = false;
    }
  }

  async function uploadWav(blob: Blob): Promise<string> {
    const form = new FormData();
    form.append("file", new File([blob], "kokoro-tts.wav", { type: "audio/wav" }));
    if (conversationId) form.append("conversationId", conversationId);
    if (messageId) form.append("messageId", messageId);
    const res = await userFetch("/api/extensions/kokoro-tts/uploads", {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Upload failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { attachmentId?: string };
    if (!data.attachmentId) throw new Error("Upload returned no attachmentId");
    return data.attachmentId;
  }

  async function postSaveEvent(attachmentId: string): Promise<void> {
    // Bare suffix only — the route reconstructs `kokoro-tts:save`
    // server-side as `${name}:${event}`. Forwarding the full
    // namespaced name would 404 the URL-param regex.
    //
    // `conversationId` is required by the route's body schema (it
    // anchors the ownership check before the finalize-tool-call
    // handler runs). Omitting it produces 400 "Invalid body".
    if (!conversationId) {
      throw new Error("conversationId missing — cannot post save event");
    }
    const res = await userFetch(
      "/api/extensions/kokoro-tts/events/save",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId,
          messageId,
          toolCallId: toolCall.id,
          attachmentId,
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`Save event failed: HTTP ${res.status}`);
    }
  }

  function revokeBlobUrl(): void {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
  }

  // Auto-trigger synthesis once when the card mounts in `running` state
  // without a persisted output. Subsequent re-mounts after attachment
  // finalization fall through to the persisted-src branch.
  $effect(() => {
    if (!isPersisted && !synthesizing && !uploading && !blobUrl && attempts === 0 && !error) {
      void runSynthesisFlow();
    }
  });

  // Cleanup blob URL on unmount.
  $effect(() => {
    return () => revokeBlobUrl();
  });
</script>

<div
  class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] overflow-hidden"
  data-testid="kokoro-tts-player-card"
  data-tool-call-id={toolCall.id}
>
  <div
    class="flex items-center gap-2 px-3 py-2 bg-[var(--color-surface-secondary)] border-b border-[var(--color-border)]"
  >
    <span class="text-xs font-medium text-[var(--color-text-secondary)]">Kokoro TTS</span>
    {#if isPersisted}
      <span class="text-[10px] uppercase tracking-wider text-green-400">saved</span>
    {:else if synthesizing}
      <span class="text-[10px] uppercase tracking-wider text-amber-400">synthesizing</span>
    {:else if uploading}
      <span class="text-[10px] uppercase tracking-wider text-amber-400">saving</span>
    {:else if error}
      <span class="text-[10px] uppercase tracking-wider text-red-400">error</span>
    {/if}
  </div>

  <div class="px-3 py-3">
    {#if isPersisted && persistedSrc}
      <audio
        controls
        preload="metadata"
        src={persistedSrc}
        data-testid="kokoro-tts-audio-persisted"
        aria-label="Synthesized audio"
        class="w-full"
      ></audio>
    {:else if blobUrl}
      <audio
        controls
        autoplay
        preload="metadata"
        src={blobUrl}
        data-testid="kokoro-tts-audio-blob"
        aria-label="Synthesized audio"
        class="w-full"
      ></audio>
      {#if uploading}
        <div class="mt-2 flex items-center gap-2 text-xs text-[var(--color-text-muted)]" data-testid="kokoro-tts-uploading">
          <svg class="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          Saving…
        </div>
      {/if}
    {:else if synthesizing}
      <div class="flex items-center gap-2 text-sm text-[var(--color-text-muted)]" data-testid="kokoro-tts-synthesizing">
        <svg class="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        {#if loadingPhase === "model"}
          Loading model…
        {:else}
          Synthesizing…
        {/if}
      </div>
    {/if}

    {#if error && !isPersisted}
      <div
        class="mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300"
        role="alert"
        data-testid="kokoro-tts-error"
      >
        <p class="mb-2">{error}</p>
        <button
          type="button"
          onclick={runSynthesisFlow}
          class="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs text-red-200 hover:bg-red-500/20 transition-colors"
          data-testid="kokoro-tts-retry"
        >
          Retry
        </button>
      </div>
    {/if}
  </div>
</div>
