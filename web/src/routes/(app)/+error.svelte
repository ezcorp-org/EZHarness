<script lang="ts">
  import { page } from "$app/stores";

  const errorConfig: Record<number, { title: string; message: string; action: string; href?: string }> = {
    404: {
      title: "Page not found",
      message: "The page you're looking for doesn't exist or has been moved.",
      action: "Go home",
      href: "/",
    },
    403: {
      title: "Access denied",
      message: "You don't have permission to view this page.",
      action: "Go back",
    },
    500: {
      title: "Something went wrong",
      message: "An unexpected error occurred. Please try again.",
      action: "Go home",
      href: "/",
    },
  };

  const config = $derived(errorConfig[$page.status] ?? errorConfig[500]);
</script>

<div class="min-h-screen flex items-center justify-center bg-[var(--color-surface)] px-4">
  <div class="text-center">
    <img src="/logo.svg" alt="EZCorp" class="h-12 w-12 mb-4 mx-auto" />
    <p class="text-6xl font-bold text-[var(--color-text-muted)]">{$page.status}</p>
    <h1 class="text-xl font-semibold text-[var(--color-text-primary)] mt-4">{config.title}</h1>
    <p class="text-[var(--color-text-secondary)] mt-2 max-w-md">{config.message}</p>
    <div class="mt-6">
      {#if config.href}
        <a href={config.href} class="inline-block bg-blue-600 hover:bg-blue-500 text-white rounded-md px-4 py-2 transition-colors">
          {config.action}
        </a>
      {:else}
        <button onclick={() => history.back()} class="bg-blue-600 hover:bg-blue-500 text-white rounded-md px-4 py-2 transition-colors">
          {config.action}
        </button>
      {/if}
    </div>
  </div>
</div>
