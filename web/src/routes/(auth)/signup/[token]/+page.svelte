<script lang="ts">
  let { data } = $props();

  let name = $state("");
  let email = $state(data?.invite?.email ?? "");
  let password = $state("");
  let error = $state("");
  let loading = $state(false);

  let nameError = $state("");
  let emailError = $state("");
  let passwordError = $state("");

  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function validate(): boolean {
    let valid = true;
    nameError = emailError = passwordError = "";

    if (!name.trim()) {
      nameError = "Name is required";
      valid = false;
    }
    if (!EMAIL_REGEX.test(email)) {
      emailError = "Valid email is required";
      valid = false;
    }
    if (password.length < 8) {
      passwordError = "Password must be at least 8 characters";
      valid = false;
    }
    return valid;
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!validate()) return;

    loading = true;
    error = "";

    try {
      const res = await fetch(`/api/auth/invite/${data.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.toLowerCase(), password }),
      });

      if (!res.ok) {
        const body = await res.json();
        error = body.error || "Signup failed";
        return;
      }

      window.location.href = "/";
    } catch {
      error = "Network error. Please try again.";
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head><title>EZCorp | Sign Up</title></svelte:head>

<div class="min-h-screen flex items-center justify-center bg-[var(--color-surface)] px-4">
  <div class="w-full max-w-md">
    <div class="text-center mb-8">
      <img src="/logo.svg" alt="EZCorp" class="mx-auto h-16 w-16 mb-4" />
      <h1 class="text-2xl font-bold text-[var(--color-text-primary)]">Join EZCorp</h1>
      <p class="text-[var(--color-text-secondary)] mt-2">Create your account</p>
    </div>

    <form onsubmit={handleSubmit} class="bg-[var(--color-surface-secondary)] rounded-lg p-6 space-y-4 border border-[var(--color-border)]">
      <div>
        <label for="name" class="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Name</label>
        <input
          id="name"
          type="text"
          bind:value={name}
          required
          class="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent"
          placeholder="Your name"
        />
        {#if nameError}<p class="text-red-400 text-sm mt-1">{nameError}</p>{/if}
      </div>

      <div>
        <label for="email" class="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Email</label>
        <input
          id="email"
          type="email"
          bind:value={email}
          required
          readonly={!!data.invite.email}
          class="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent {data.invite.email ? 'opacity-60 cursor-not-allowed' : ''}"
          placeholder="you@example.com"
        />
        {#if emailError}<p class="text-red-400 text-sm mt-1">{emailError}</p>{/if}
      </div>

      <div>
        <label for="password" class="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Password</label>
        <input
          id="password"
          type="password"
          bind:value={password}
          required
          minlength="8"
          class="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent"
          placeholder="Minimum 8 characters"
        />
        {#if passwordError}<p class="text-red-400 text-sm mt-1">{passwordError}</p>{/if}
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
        {loading ? "Creating account..." : "Create Account"}
      </button>
    </form>

    <p class="text-center text-sm text-[var(--color-text-secondary)] mt-4">
      Already have an account? <a href="/login" class="text-blue-400 hover:text-blue-300">Sign in</a>
    </p>
  </div>
</div>
