<script lang="ts">
  import { page } from "$app/stores";
  import { goto, invalidateAll } from "$app/navigation";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let email = $state("");
  let password = $state("");
  let error = $state("");
  let loading = $state(false);

  const sessionExpired = $derived($page.url.searchParams.get("reason") === "session_expired");

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!email || !password) return;

    loading = true;
    error = "";

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.toLowerCase(), password }),
      });

      if (!res.ok) {
        const body = await res.json();
        error = body.error || "Login failed";
        return;
      }

      // SvelteKit nav + invalidateAll preserves any client state
      // (open chats, in-flight streams) instead of doing a full document load.
      await invalidateAll();
      await goto(data.returnTo);
    } catch {
      error = "Network error. Please try again.";
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head><title>EZCorp | Sign In</title></svelte:head>

<div class="min-h-screen flex items-center justify-center bg-[var(--color-surface)] px-4">
  <div class="w-full max-w-md">
    <div class="text-center mb-8">
      <img src="/logo.svg" alt="EZCorp" class="mx-auto h-16 w-16 mb-4" />
      <h1 class="text-2xl font-bold text-[var(--color-text-primary)]">Sign in to EZCorp</h1>
      <p class="text-[var(--color-text-secondary)] mt-2">Enter your credentials to continue</p>
    </div>

    {#if sessionExpired}
      <div class="bg-amber-900/30 border border-amber-700/50 text-amber-200 rounded-md px-4 py-3 text-sm mb-4">
        Your session has expired. Please log in again.
      </div>
    {/if}

    <form onsubmit={handleSubmit} class="bg-[var(--color-surface-secondary)] rounded-lg p-6 space-y-4 border border-[var(--color-border)]">
      <div>
        <label for="email" class="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Email</label>
        <input
          id="email"
          type="email"
          bind:value={email}
          required
          class="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent"
          placeholder="you@example.com"
        />
      </div>

      <div>
        <label for="password" class="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Password</label>
        <input
          id="password"
          type="password"
          bind:value={password}
          required
          class="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent"
          placeholder="Your password"
        />
      </div>

      {#if error}
        <div class="bg-red-900/30 border border-red-700 rounded-md p-3">
          <p class="text-red-400 text-sm">{error}</p>
        </div>
      {/if}

      <button
        type="submit"
        disabled={loading}
        class="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded-md transition-colors"
      >
        {loading ? "Signing in..." : "Sign In"}
      </button>
    </form>

    <p class="text-center text-sm text-[var(--color-text-secondary)] mt-4">
      Have an invite link? Ask your admin for the signup URL.
    </p>
  </div>
</div>
