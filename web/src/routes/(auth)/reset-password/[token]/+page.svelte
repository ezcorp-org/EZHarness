<script lang="ts">
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let email = $state("");
  let password = $state("");
  let confirmPassword = $state("");
  let error = $state("");
  let success = $state(false);
  let loading = $state(false);

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    error = "";

    if (password.length < 8) {
      error = "Password must be at least 8 characters";
      return;
    }

    if (password !== confirmPassword) {
      error = "Passwords do not match";
      return;
    }

    loading = true;

    try {
      const res = await fetch(`/api/auth/reset-password/${data.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.toLowerCase(), password }),
      });

      if (!res.ok) {
        const body = await res.json();
        error = body.error || "Failed to reset password";
        return;
      }

      success = true;
    } catch {
      error = "Network error. Please try again.";
    } finally {
      loading = false;
    }
  }
</script>

<div class="min-h-screen flex items-center justify-center bg-[var(--color-surface)] px-4">
  <div class="w-full max-w-md">
    <div class="text-center mb-8">
      <h1 class="text-2xl font-bold text-[var(--color-text-primary)]">Reset Password</h1>
      <p class="text-[var(--color-text-secondary)] mt-2">Enter your email and a new password</p>
    </div>

    {#if success}
      <div class="bg-green-900/30 border border-green-700/50 text-green-200 rounded-md px-4 py-3 text-sm mb-4">
        Password reset successfully! You can now sign in with your new password.
      </div>
      <div class="text-center">
        <a href="/login" class="text-blue-400 hover:text-blue-300 text-sm transition-colors">Go to Sign In</a>
      </div>
    {:else}
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
          <label for="password" class="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">New Password</label>
          <input
            id="password"
            type="password"
            bind:value={password}
            required
            minlength={8}
            class="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent"
            placeholder="At least 8 characters"
          />
        </div>

        <div>
          <label for="confirmPassword" class="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Confirm Password</label>
          <input
            id="confirmPassword"
            type="password"
            bind:value={confirmPassword}
            required
            minlength={8}
            class="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent"
            placeholder="Re-enter your new password"
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
          {loading ? "Resetting..." : "Reset Password"}
        </button>
      </form>
    {/if}
  </div>
</div>
