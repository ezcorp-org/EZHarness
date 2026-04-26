<script lang="ts">
  let name = $state("");
  let email = $state("");
  let password = $state("");
  let confirmPassword = $state("");
  let error = $state("");
  let loading = $state(false);

  let nameError = $state("");
  let emailError = $state("");
  let passwordError = $state("");
  let confirmPasswordError = $state("");

  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Mirrors $lib/server/security/validation passwordSchema:
  // ≥8 chars, ≤256, with at least one uppercase, lowercase, and digit.
  function checkPassword(pw: string): string {
    if (pw.length < 8) return "Password must be at least 8 characters";
    if (pw.length > 256) return "Password must be at most 256 characters";
    if (!/[A-Z]/.test(pw)) return "Password must contain an uppercase letter";
    if (!/[a-z]/.test(pw)) return "Password must contain a lowercase letter";
    if (!/[0-9]/.test(pw)) return "Password must contain a digit";
    return "";
  }

  function validate(): boolean {
    nameError = emailError = passwordError = confirmPasswordError = "";

    if (!name.trim()) nameError = "Name is required";
    if (!EMAIL_REGEX.test(email)) emailError = "Valid email is required";
    passwordError = checkPassword(password);
    if (!confirmPasswordError && password !== confirmPassword) {
      confirmPasswordError = "Passwords do not match";
    }

    return !(nameError || emailError || passwordError || confirmPasswordError);
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!validate()) return;

    loading = true;
    error = "";

    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.toLowerCase(), password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const fields = (data && typeof data === "object" && data.fields) || {};
        // Route per-field server errors next to their inputs so users see
        // exactly which rule failed (e.g. password complexity).
        nameError = fields.name || "";
        emailError = fields.email || "";
        passwordError = fields.password || "";
        if (!nameError && !emailError && !passwordError) {
          error = data.error || "Setup failed";
        }
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

<svelte:head><title>EZCorp | Setup</title></svelte:head>

<div class="min-h-screen flex items-center justify-center bg-[var(--color-surface)] px-4">
  <div class="w-full max-w-md">
    <div class="text-center mb-8">
      <img src="/logo.svg" alt="EZCorp" class="mx-auto h-16 w-16 mb-4" />
      <h1 class="text-2xl font-bold text-[var(--color-text-primary)]">Welcome to EZCorp</h1>
      <p class="text-[var(--color-text-secondary)] mt-2">Create your admin account to get started</p>
    </div>

    <form onsubmit={handleSubmit} class="bg-[var(--color-surface-secondary)] rounded-lg p-6 space-y-4 border border-[var(--color-border)]">
      <div>
        <label for="name" class="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Name</label>
        <input
          id="name"
          type="text"
          bind:value={name}
          required
          aria-invalid={!!nameError}
          aria-describedby={nameError ? "name-error" : undefined}
          class="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent"
          placeholder="Your name"
        />
        {#if nameError}<p id="name-error" role="alert" aria-live="polite" class="text-red-400 text-sm mt-1">{nameError}</p>{/if}
      </div>

      <div>
        <label for="email" class="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Email</label>
        <input
          id="email"
          type="email"
          bind:value={email}
          required
          aria-invalid={!!emailError}
          aria-describedby={emailError ? "email-error" : undefined}
          class="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent"
          placeholder="admin@example.com"
        />
        {#if emailError}<p id="email-error" role="alert" aria-live="polite" class="text-red-400 text-sm mt-1">{emailError}</p>{/if}
      </div>

      <div>
        <label for="password" class="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Password</label>
        <input
          id="password"
          type="password"
          bind:value={password}
          required
          minlength="8"
          aria-invalid={!!passwordError}
          aria-describedby={passwordError ? "password-error" : "password-hint"}
          class="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent"
          placeholder="Minimum 8 characters"
        />
        {#if passwordError}
          <p id="password-error" role="alert" aria-live="polite" class="text-red-400 text-sm mt-1">{passwordError}</p>
        {:else}
          <p id="password-hint" class="text-[var(--color-text-muted)] text-xs mt-1">At least 8 characters with an uppercase letter, lowercase letter, and digit.</p>
        {/if}
      </div>

      <div>
        <label for="confirmPassword" class="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">Confirm password</label>
        <input
          id="confirmPassword"
          type="password"
          bind:value={confirmPassword}
          required
          aria-invalid={!!confirmPasswordError}
          aria-describedby={confirmPasswordError ? "confirmPassword-error" : undefined}
          class="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent"
          placeholder="Re-enter password"
        />
        {#if confirmPasswordError}<p id="confirmPassword-error" role="alert" aria-live="polite" class="text-red-400 text-sm mt-1">{confirmPasswordError}</p>{/if}
      </div>

      {#if error}
        <div role="alert" aria-live="polite" class="bg-red-900/30 border border-red-700 rounded-md p-3">
          <p class="text-red-400 text-sm">{error}</p>
        </div>
      {/if}

      <button
        type="submit"
        disabled={loading}
        class="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded-md transition-colors"
      >
        {loading ? "Creating account..." : "Create Admin Account"}
      </button>
    </form>
  </div>
</div>
