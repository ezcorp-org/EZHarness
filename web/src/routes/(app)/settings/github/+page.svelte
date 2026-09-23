<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import { trustedGithubUrl } from "$lib/personal-pr.js";

	type Connection = {
		status: "disconnected" | "connected" | "reconnect_required";
		configured: boolean;
		authMode?: "device" | "oauth" | null;
		account?: { id: number; login: string };
		installUrl?: string;
	};
	type DeviceAttempt = { attemptId: string; userCode: string; expiresAt: string; intervalSeconds: number; nextPollAt?: string };
	type DevicePoll = { status: "pending" | "slow_down" | "connected" | "expired" | "denied" | "cancelled"; nextPollAt?: string; returnReviewId?: string };
	const deviceUrl = "https://github.com/login/device";
	const savedAttemptKey = "ezcorp-github-device-attempt";
	type RepositoryCheck = {
		status: "ready" | "repository_not_enabled" | "insufficient_user_permission" | "reconnect_required";
		repository?: { id: number; fullName: string };
		installUrl?: string;
		manageUrl?: string;
	};

	let connection = $state<Connection | null>(null);
	let connectionLoaded = $state(false);
	let repository = $state<RepositoryCheck | null>(null);
	let busy = $state(false);
	let error = $state("");
	let confirmDisconnect = $state(false);
	let approvalRequested = $state(false);
	let checkingRepository = $state(false);
	let checkingRepositories = $state(false);
	let repositoryCount = $state<number | null>(null);
	let deviceAttempt = $state<DeviceAttempt | null>(null);
	let pendingRestore = $state<DeviceAttempt | null>(null);
	let deviceStatus = $state<"idle" | "pending" | "slow_down" | "network_error" | "connected" | "expired" | "denied" | "cancelled">("idle");
	let devicePolling = $state(false);
	let reviewPath = $state("");
	let mounted = false;
	let attemptEpoch = 0;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let expiryTimer: ReturnType<typeof setTimeout> | null = null;

	const repositoryId = $derived(Number(page.url.searchParams.get("repositoryId")));
	const returnReviewId = $derived(page.url.searchParams.get("review") ?? undefined);

	async function readJson(response: Response) {
		const body = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(body.error ?? body.message ?? "GitHub is unavailable");
		return body;
	}

	function validAttempt(value: unknown): value is DeviceAttempt {
		if (!value || typeof value !== "object") return false;
		const attempt = value as Partial<DeviceAttempt>;
		return typeof attempt.attemptId === "string" && /^[0-9a-f-]{36}$/i.test(attempt.attemptId)
			&& typeof attempt.userCode === "string" && /^[A-Z0-9-]{4,32}$/.test(attempt.userCode)
			&& typeof attempt.expiresAt === "string" && Number.isFinite(Date.parse(attempt.expiresAt))
			&& typeof attempt.intervalSeconds === "number" && Number.isFinite(attempt.intervalSeconds) && attempt.intervalSeconds >= 1
			&& (attempt.nextPollAt === undefined || typeof attempt.nextPollAt === "string" && Number.isFinite(Date.parse(attempt.nextPollAt)));
	}

	function forgetAttempt() {
		deviceAttempt = null;
		pendingRestore = null;
		clearExpiryTimer();
		try { sessionStorage.removeItem(savedAttemptKey); } catch { /* Storage may be disabled. */ }
	}

	function saveAttempt(attempt: DeviceAttempt) {
		try { sessionStorage.setItem(savedAttemptKey, JSON.stringify(attempt)); } catch { /* Continue in this tab. */ }
	}

	function clearPollTimer() {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = null;
	}

	function clearExpiryTimer() {
		if (expiryTimer) clearTimeout(expiryTimer);
		expiryTimer = null;
	}

	function scheduleExpiry(attempt: DeviceAttempt, epoch: number) {
		clearExpiryTimer();
		const remaining = Date.parse(attempt.expiresAt) - Date.now();
		if (remaining <= 0) {
			clearPollTimer();
			forgetAttempt();
			deviceStatus = "expired";
			error = "";
			return;
		}
		expiryTimer = setTimeout(() => {
			if (!mounted || attemptEpoch !== epoch) return;
			attemptEpoch++;
			clearPollTimer();
			forgetAttempt();
			deviceStatus = "expired";
			error = "";
		}, remaining);
	}

	function schedulePoll(attempt: DeviceAttempt, epoch: number, nextPollAt?: string) {
		if (!mounted || attemptEpoch !== epoch) return;
		clearPollTimer();
		const dueAt = nextPollAt ? Date.parse(nextPollAt) : Date.now() + attempt.intervalSeconds * 1000;
		pollTimer = setTimeout(() => { pollTimer = null; void pollDevice(attempt, epoch); }, Math.max(1000, Number.isFinite(dueAt) ? dueAt - Date.now() : attempt.intervalSeconds * 1000));
	}

	async function restoreReview(returnReviewId: string, epoch: number) {
		if (!/^[0-9a-f-]{36}$/i.test(returnReviewId)) return;
		try {
			const review = await readJson(await fetch(`/api/github/personal-prs/proposals/${encodeURIComponent(returnReviewId)}`)) as { reviewPath?: string };
			if (!mounted || attemptEpoch !== epoch || !review.reviewPath || !review.reviewPath.startsWith("/") || review.reviewPath.startsWith("//") || review.reviewPath.includes("\\")) return;
			const target = new URL(review.reviewPath, window.location.origin);
			if (target.origin === window.location.origin && /^\/project\/[^/?#]+\/chat\/[^/?#]+$/.test(target.pathname) && target.searchParams.get("review") === returnReviewId && !target.hash) reviewPath = `${target.pathname}${target.search}`;
		} catch { /* Connection is still usable when review recovery is unavailable. */ }
	}

	async function pollDevice(attempt: DeviceAttempt, epoch: number) {
		if (!mounted || attemptEpoch !== epoch || devicePolling) return;
		devicePolling = true;
		error = "";
		try {
			const response = await fetch("/api/github/device/poll", {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attemptId: attempt.attemptId }),
			});
			if (response.status === 403 || response.status === 404) {
				if (mounted && attemptEpoch === epoch) {
					forgetAttempt();
					deviceStatus = "idle";
					error = "Saved GitHub connection request is unavailable. Start a new code.";
				}
				return;
			}
			if (response.status === 409) {
				const failure = await response.json().catch(() => ({})) as { code?: string };
				if (failure.code === "DEVICE_RESTART_REQUIRED") {
					if (mounted && attemptEpoch === epoch) {
						forgetAttempt();
						deviceStatus = "idle";
						error = "GitHub account lookup failed. Start a new connection.";
					}
					return;
				}
				throw new Error("Could not check GitHub connection");
			}
			const result = await readJson(response) as DevicePoll;
			if (!mounted || attemptEpoch !== epoch) return;
			if (result.status === "pending" || result.status === "slow_down") {
				pendingRestore = null;
				deviceStatus = result.status;
				deviceAttempt = { ...attempt, nextPollAt: result.nextPollAt };
				scheduleExpiry(deviceAttempt, epoch);
				if (!deviceAttempt) return;
				saveAttempt(deviceAttempt);
				schedulePoll(deviceAttempt, epoch, result.nextPollAt);
			} else if (result.status === "connected") {
				forgetAttempt();
				deviceStatus = "connected";
				await load(epoch);
				if (result.returnReviewId) await restoreReview(result.returnReviewId, epoch);
			} else {
				forgetAttempt();
				deviceStatus = result.status;
			}
		} catch (cause) {
			if (!mounted || attemptEpoch !== epoch) return;
			deviceStatus = "network_error";
			error = cause instanceof Error ? cause.message : "Could not check GitHub connection";
		} finally {
			if (mounted && attemptEpoch === epoch) devicePolling = false;
		}
	}

	async function startDevice() {
		const epoch = ++attemptEpoch;
		clearPollTimer();
		devicePolling = false;
		forgetAttempt();
		deviceStatus = "idle";
		reviewPath = "";
		confirmDisconnect = false;
		busy = true;
		error = "";
		try {
			const result = await readJson(await fetch("/api/github/device/start", {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(returnReviewId ? { returnReviewId } : {}),
			})) as DeviceAttempt & { verificationUri: string };
			if (!mounted || attemptEpoch !== epoch) return;
			if (result.verificationUri !== deviceUrl || !validAttempt(result)) throw new Error("GitHub returned an invalid device code");
			deviceAttempt = result;
			deviceStatus = "pending";
			scheduleExpiry(result, epoch);
			if (!deviceAttempt) return;
			saveAttempt(result);
			schedulePoll(result, epoch);
		} catch (cause) {
			if (mounted && attemptEpoch === epoch) error = cause instanceof Error ? cause.message : "Could not connect GitHub";
		} finally {
			if (mounted && attemptEpoch === epoch) busy = false;
		}
	}

	async function cancelDevice() {
		if (!deviceAttempt) return;
		const attempt = deviceAttempt;
		const epoch = ++attemptEpoch;
		clearPollTimer();
		clearExpiryTimer();
		devicePolling = false;
		busy = true;
		error = "";
		try {
			const result = await readJson(await fetch("/api/github/device/cancel", {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attemptId: attempt.attemptId }),
			})) as { status: string };
			if (!mounted || attemptEpoch !== epoch) return;
			if (result.status !== "cancelled") throw new Error("Could not cancel GitHub connection");
			forgetAttempt();
			deviceStatus = "cancelled";
		} catch (cause) {
			if (mounted && attemptEpoch === epoch) {
				error = cause instanceof Error ? cause.message : "Could not cancel GitHub connection";
				scheduleExpiry(attempt, epoch);
				schedulePoll(attempt, epoch);
			}
		} finally {
			if (mounted && attemptEpoch === epoch) busy = false;
		}
	}

	async function load(epoch = attemptEpoch) {
		error = "";
		try {
			const next = await readJson(await fetch("/api/github/connection")) as Connection;
			if (!mounted || attemptEpoch !== epoch) return;
			connection = next;
			if (connection.status === "connected" && Number.isSafeInteger(repositoryId) && repositoryId > 0) {
				await recheckRepository();
			} else {
				repository = null;
			}
		} catch (cause) {
			if (mounted && attemptEpoch === epoch) error = cause instanceof Error ? cause.message : "GitHub is unavailable";
		} finally { if (mounted && attemptEpoch === epoch) connectionLoaded = true; }
	}

	async function recheckRepository() {
		if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) return;
		checkingRepository = true;
		error = "";
		try {
			repository = await readJson(await fetch(`/api/github/repositories/check?repositoryId=${repositoryId}`)) as RepositoryCheck;
			if (repository.status === "ready") approvalRequested = false;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Could not check repository access";
		} finally { checkingRepository = false; }
	}

	async function recheckRepositories() {
		checkingRepositories = true;
		error = "";
		try {
			const result = await readJson(await fetch("/api/github/repositories")) as { repositories?: unknown[] };
			repositoryCount = result.repositories?.length ?? 0;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Could not check repositories";
		} finally { checkingRepositories = false; }
	}

	onMount(() => {
		mounted = true;
		void (async () => {
			await load();
			if (!mounted || connection?.status === "connected" || connection?.authMode === "oauth") return;
			try {
				const saved = JSON.parse(sessionStorage.getItem(savedAttemptKey) ?? "null") as unknown;
				if (validAttempt(saved)) {
					pendingRestore = saved;
					scheduleExpiry(saved, attemptEpoch);
					if (pendingRestore) void pollDevice(saved, attemptEpoch);
				} else forgetAttempt();
			} catch { forgetAttempt(); }
		})();
		return () => { mounted = false; attemptEpoch++; clearPollTimer(); clearExpiryTimer(); };
	});

	async function connect() {
		if (connection?.authMode !== "oauth") return startDevice();
		busy = true;
		error = "";
		try {
			const body = returnReviewId ? { returnReviewId } : {};
			const result = await readJson(await fetch("/api/github/authorize", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			})) as { authorizeUrl: string };
			const authorizeUrl = new URL(result.authorizeUrl);
			if (authorizeUrl.protocol !== "https:" || authorizeUrl.hostname !== "github.com" || authorizeUrl.pathname !== "/login/oauth/authorize") {
				throw new Error("GitHub returned an invalid authorization address");
			}
			window.location.assign(authorizeUrl.href);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Could not connect GitHub";
			busy = false;
		}
	}

	async function disconnect() {
		busy = true;
		error = "";
		try {
			connection = await readJson(await fetch("/api/github/connection", { method: "DELETE" })) as Connection;
			attemptEpoch++;
			clearPollTimer();
			clearExpiryTimer();
			devicePolling = false;
			forgetAttempt();
			deviceStatus = "idle";
			repository = null;
			confirmDisconnect = false;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Could not disconnect GitHub";
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>GitHub - Settings - EZCorp</title>
</svelte:head>

<div class="mx-auto flex max-w-3xl flex-col gap-6" data-testid="github-settings">
	<div>
		<h2 class="text-xl font-semibold text-[var(--color-text-primary)]">GitHub</h2>
		<p class="mt-1 text-sm text-[var(--color-text-secondary)]">Connect your GitHub account once to import a repository into a private sandbox and create draft pull requests from your work.</p>
	</div>
	{#if error}<p class="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>{/if}

	{#if !deviceAttempt && !pendingRestore}
	<SettingsSection title="Your account" description="This connection belongs to you. Other EZCorp users cannot use it, even in a shared project.">
		{#if !connectionLoaded}
			<p class="text-sm text-[var(--color-text-secondary)]" role="status">Checking GitHub connection…</p>
		{:else if !connection}
			<p class="text-sm text-[var(--color-text-secondary)]" role="status">Could not load your GitHub connection. Reload this page to try again.</p>
		{:else if !connection.configured}
			<p class="text-sm text-[var(--color-text-secondary)]" role="status">GitHub connection is not configured on this EZCorp server. Ask an administrator to set up the GitHub App.</p>
		{:else if connection.status === "disconnected"}
			<p class="mb-4 text-sm text-[var(--color-text-secondary)]" role="status">No GitHub account connected.</p>
					<button class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50" disabled={busy} onclick={connect}>Connect GitHub</button>
		{:else}
			<div class="flex flex-wrap items-center justify-between gap-4">
				<div>
					<p class="font-medium text-[var(--color-text-primary)]">{connection.account?.login ?? "GitHub account"}</p>
					<p class="text-sm text-[var(--color-text-secondary)]" role="status">{connection.status === "connected" ? "Connected" : "Reconnect required. Draft pull requests are paused."}</p>
				</div>
						<div class="flex flex-wrap gap-2">
						<button class="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50" disabled={busy} onclick={connect}>Reconnect</button>
					<button class="rounded-md border border-red-500/30 px-3 py-2 text-sm text-red-700 hover:bg-red-500/10 dark:text-red-300 disabled:opacity-50" disabled={busy} onclick={() => confirmDisconnect = true}>Disconnect</button>
						</div>
					</div>
					{#if connection.status === "connected"}
						<div class="mt-4 flex flex-wrap items-center gap-3 text-sm">
							{#if trustedGithubUrl(connection.installUrl)}<a class="text-[var(--color-accent)] underline" href={trustedGithubUrl(connection.installUrl) ?? undefined} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Enable repositories on GitHub</a>{/if}
							<button class="text-[var(--color-accent)] underline disabled:opacity-50" disabled={checkingRepositories} onclick={recheckRepositories}>{checkingRepositories ? "Checking repositories…" : "Recheck repositories"}</button>
							{#if repositoryCount !== null}<span role="status" class="text-[var(--color-text-secondary)]">{repositoryCount === 0 ? "No enabled repositories yet." : `${repositoryCount} enabled ${repositoryCount === 1 ? "repository" : "repositories"} available.`}</span>{/if}
						</div>
					{/if}
					{#if confirmDisconnect}
				<div class="mt-4 rounded-md border border-red-500/30 bg-red-500/10 p-4">
						<p class="text-sm text-[var(--color-text-primary)]">Disconnect your GitHub account here? Pending draft pull requests will stop until you reconnect. To revoke this App on GitHub, manage its authorization in your GitHub settings; that can also affect your other EZCorp installations.</p>
					<div class="mt-3 flex gap-2">
						<button class="rounded-md bg-red-600 px-3 py-2 text-sm text-white disabled:opacity-50" disabled={busy} onclick={disconnect}>Disconnect GitHub</button>
						<button class="rounded-md px-3 py-2 text-sm text-[var(--color-text-secondary)]" disabled={busy} onclick={() => confirmDisconnect = false}>Cancel</button>
					</div>
				</div>
			{/if}
		{/if}
	</SettingsSection>
	{/if}

	{#if connection?.configured && connection.authMode !== "oauth" && pendingRestore && !deviceAttempt}
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4" data-testid="github-device-resume">
			<p class="text-sm text-[var(--color-text-secondary)]" role="status">Checking your saved GitHub request with this sign-in session…</p>
			{#if deviceStatus === "network_error"}<button class="mt-2 text-sm text-[var(--color-accent)] underline" disabled={devicePolling} onclick={() => pendingRestore && void pollDevice(pendingRestore, attemptEpoch)}>Check again</button>{/if}
		</div>
	{/if}
	{#if connection?.configured && connection.authMode !== "oauth" && deviceAttempt}
		<SettingsSection title="Approve on GitHub" description="This short code belongs to this EZCorp installation and your current sign-in session.">
			<div class="flex flex-col gap-4" data-testid="github-device-attempt">
				<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-4 py-5">
					<p class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">Your GitHub code</p>
					<output aria-label="GitHub device code" class="mt-2 block select-all font-mono text-3xl font-semibold tracking-[0.18em] text-[var(--color-text-primary)]">{deviceAttempt.userCode}</output>
					<p class="mt-2 text-sm text-[var(--color-text-secondary)]">Expires {new Date(deviceAttempt.expiresAt).toLocaleTimeString()}.</p>
				</div>
					<p class="text-sm text-[var(--color-text-secondary)]">Only enter a code that you just requested here. Never approve a code sent by someone else.</p>
					<div class="flex flex-wrap items-center gap-3">
						<a class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500" href={deviceUrl} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open GitHub verification</a>
						<button class="text-sm text-[var(--color-accent)] underline disabled:opacity-50" disabled={busy} onclick={startDevice}>Get a new code</button>
						<button class="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)] disabled:opacity-50" disabled={busy} onclick={cancelDevice}>Cancel connection</button>
						{#if deviceStatus === "network_error"}<button class="text-sm text-[var(--color-accent)] underline disabled:opacity-50" disabled={devicePolling || busy} onclick={() => deviceAttempt && void pollDevice(deviceAttempt, attemptEpoch)}>Check again</button>{/if}
					</div>
					<ol class="list-inside list-decimal space-y-1 text-sm text-[var(--color-text-secondary)]">
						<li>Open GitHub in a new tab.</li>
						<li>Enter the code shown here and approve this GitHub App.</li>
						<li>Return to this tab. Your connection will update here.</li>
					</ol>
				<p class="text-sm text-[var(--color-text-secondary)]" role="status">
					{#if deviceStatus === "slow_down"}GitHub asked us to check less often. We will continue at its next allowed time.
					{:else if deviceStatus === "network_error"}The connection check failed. You can check again.
					{:else if devicePolling}Checking GitHub approval…
					{:else}Waiting for GitHub approval…{/if}
				</p>
			</div>
		</SettingsSection>
	{:else if deviceStatus === "expired" || deviceStatus === "denied" || deviceStatus === "cancelled"}
		<p class="text-sm text-[var(--color-text-secondary)]" role="status">{deviceStatus === "expired" ? "The GitHub code expired. Request a new code to try again." : deviceStatus === "denied" ? "GitHub approval was denied. Request a new code if you want to try again." : "GitHub connection request cancelled."}</p>
	{:else if deviceStatus === "connected"}
		<p class="text-sm text-[var(--color-text-secondary)]" role="status">GitHub connected to this EZCorp installation.</p>
	{/if}
	{#if reviewPath}<a class="text-sm text-[var(--color-accent)] underline" href={reviewPath}>Return to PR review</a>{/if}

	{#if repository}
		<SettingsSection title="Repository access" description="GitHub controls which repositories and organizations this connection can use.">
			<p class="text-sm font-medium text-[var(--color-text-primary)]">{repository.repository?.fullName ?? "Selected repository"}</p>
			<p class="mt-1 text-sm text-[var(--color-text-secondary)]" role="status">
				{#if repository.status === "ready"}Ready for private sandbox import and draft pull requests.
				{:else if repository.status === "repository_not_enabled"}{approvalRequested ? "Approval may be pending. GitHub has not enabled this repository yet." : "Enable this repository for the GitHub App."}
				{:else if repository.status === "insufficient_user_permission"}Your account needs repository write access.
				{:else}Reconnect your GitHub account to check this repository.{/if}
			</p>
			{#if trustedGithubUrl(repository.installUrl)}<a class="mt-3 inline-block text-sm text-[var(--color-accent)] underline" href={trustedGithubUrl(repository.installUrl) ?? undefined} rel="noopener noreferrer">Enable repository on GitHub</a>{/if}
			{#if trustedGithubUrl(repository.manageUrl)}<a class="mt-3 inline-block text-sm text-[var(--color-accent)] underline" href={trustedGithubUrl(repository.manageUrl) ?? undefined} rel="noopener noreferrer">Manage organization approval</a>{/if}
			{#if repository.status === "repository_not_enabled"}<div class="mt-3 flex flex-wrap gap-3"><button class="text-sm text-[var(--color-accent)] underline" onclick={() => approvalRequested = true}>I requested approval</button><button class="text-sm text-[var(--color-accent)] underline disabled:opacity-50" disabled={checkingRepository} onclick={recheckRepository}>{checkingRepository ? "Checking…" : "Recheck access"}</button></div>{/if}
		</SettingsSection>
	{/if}
</div>
