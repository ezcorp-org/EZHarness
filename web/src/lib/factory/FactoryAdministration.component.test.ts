import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import type { FactoryGrantResource, FactoryPackageAffectedAttempt, FactoryPackageImpact, FactoryPackageResource, FactoryPackageTransition, FactoryRestoreResource } from "@ezcorp/factory-sdk/types";
import FactoryAdministration from "./FactoryAdministration.svelte";
import { FactoryApiClientError, type FactoryAdministrationApi } from "./client";

const digest = `sha256:${"a".repeat(64)}`;
const pkg = (name: string, state?: FactoryPackageResource["state"], revision = 1): FactoryPackageResource => ({
	referenceId: name.charCodeAt(0).toString(16).padStart(2, "0").repeat(32), reference: { package: `@ezcorp/${name}`, manifestName: name, version: "1.0.0", digest, export: "run" },
	revision, ...(state ? { state } : {}), installationId: "i-1", releaseId: "r-1", boundAtMs: 1,
});
const grant = (principalId: string, overrides: Partial<FactoryGrantResource> = {}): FactoryGrantResource => ({ principalKind: "user", principalId, action: "factory.run", revision: 2, expiresAtMs: null, revoked: false, displayName: `Name of ${principalId}`, ...overrides });
const fencedAttempt = (runId: string, attemptId: string, disposition: FactoryPackageAffectedAttempt["disposition"]): FactoryPackageAffectedAttempt => ({
	runId, attemptId, ...(disposition === "run-terminal" ? { attemptStatus: "admitted", launchState: null } : { attemptStatus: "running", launchState: "launched" }), trustRevision: 3, state: "quarantined", reason: "factory_package_quarantined", disposition,
	...(disposition === "run-terminal" ? {} : { cancellationEventId: `cancel-${runId}` }), recordedAtMs: 5,
});
const preview = { tenantId: "tenant-1", ready: false, auditRowsLost: 1, preconditions: [{ id: "live-runs", satisfied: false, count: 2, detail: "Runs still running" }, { id: "uncertain-usage", satisfied: true, count: 0, detail: "Uncertain usage" }] };

const reportDigest = `sha256:${"b".repeat(64)}`;
const finding = (id: string, disposition: "verified" | "reconciled" | "blocked", reason = `${id} reason`) => ({ findingId: id, subjectKind: "check" as const, subjectId: id, disposition, reason });
const restore = (restoreId: string, overrides: Partial<FactoryRestoreResource> = {}): FactoryRestoreResource => ({
	restoreId, mode: "tenant", state: "awaiting_signature", checkpointId: `checkpoint-${restoreId}`, previousEpoch: 3, executionEpoch: 4, startedAtMs: 1, reportDigest,
	report: { checkpointId: `checkpoint-${restoreId}`, manifestDigest: digest, findings: [finding("schema", "verified")], findingCount: 1, blockedChecks: [], blockedRuns: [], releaseIdentities: { archived: 2, recovered: 2, blocked: 0 }, recoveryMs: 4_000, reportedAtMs: 2 },
	...overrides,
});

function api(overrides: Partial<FactoryAdministrationApi> = {}): FactoryAdministrationApi {
	return {
		listPackages: vi.fn(async () => ({ items: [pkg("active", "active", 2), pkg("held", "quarantined", 3), pkg("new"), pkg("gone", "revoked", 4)], nextCursor: null })),
		installPackage: vi.fn(async (_project, body) => ({ ...pkg("new"), reference: body.reference })),
		packageImpact: vi.fn(async (_p: string, _r: string, transition: FactoryPackageTransition): Promise<FactoryPackageImpact> => ({ transition, currentRevision: 2, allowed: true, runs: [{ runId: "run-1", factoryId: "f", status: "running", liveAttempts: 1 }, { runId: "run-2", factoryId: "g", status: "waiting", liveAttempts: 2 }], truncated: true })),
		transitionPackage: vi.fn(async () => ({ ...pkg("active", "quarantined", 3) })),
		packageAffectedRuns: vi.fn(async () => ({ items: [fencedAttempt("run-1", "a-1", "cancel-requested"), fencedAttempt("run-1", "a-2", "already-cancelling"), fencedAttempt("run-2", "a-3", "run-terminal")], nextCursor: null })),
		listGrants: vi.fn(async () => ({ items: [grant("member-1", { expiresAtMs: Date.UTC(2031, 0, 2, 3, 4) }), grant("old", { revoked: true, action: "factory.operate" }), grant("svc", { principalKind: "service" })], nextCursor: null })),
		setGrant: vi.fn(async (_p, principalKind, principalId, action, revision) => grant(principalId, { principalKind, action, revision: revision + 1 })),
		revokeGrant: vi.fn(async (_p, principalKind, principalId, action) => grant(principalId, { principalKind, action, revoked: true })),
		purgePreview: vi.fn(async () => preview),
		requestPurge: vi.fn(async () => ({ ...preview, requestId: "purge-1", state: "refused" as const, requestedBy: "u", requestedAtMs: 1 })),
		listRestores: vi.fn(async () => []),
		signRestore: vi.fn(async (_tenant: string, restoreId: string) => ({ restoreId, enabled: true as const, rebound: 1, blockedRuns: [] })),
		...overrides,
	};
}

const mount = (service: FactoryAdministrationApi, administrator = true, tenantId: string | null = "tenant-1") => render(FactoryAdministration, { projectId: "project-1", tenantId, administrator, api: service });

describe("FactoryAdministration", () => {
	test("packages carry state-true labels, revoked ones are terminal, and a transition commits only after its review", async () => {
		const service = api();
		mount(service);
		const active = await screen.findByRole("group", { name: "Trust actions for @ezcorp/active" });
		expect(within(active).getAllByRole("button").map(button => button.textContent?.trim())).toEqual(["Re-trust", "Quarantine", "Revoke"]);
		expect(within(screen.getByRole("group", { name: "Trust actions for @ezcorp/held" })).getAllByRole("button")[0]).toHaveTextContent("Lift quarantine");
		expect(within(screen.getByRole("group", { name: "Trust actions for @ezcorp/new" })).getAllByRole("button")[0]).toHaveTextContent("Trust");
		expect(screen.queryByRole("group", { name: "Trust actions for @ezcorp/gone" })).toBeNull();
		expect(screen.getByText("Revoked for good. A replacement needs a new pinned reference.")).toBeVisible();
		expect(screen.getByText("untrusted")).toBeVisible();

		await fireEvent.click(within(active).getByRole("button", { name: "Quarantine" }));
		const review = await screen.findByRole("dialog", { name: "Quarantine @ezcorp/active" });
		expect(review).toHaveTextContent("2+ live runs use this package. New dispatch stops at once.");
		expect(review).toHaveTextContent("1 live attempt");
		expect(review).toHaveTextContent("2 live attempts");
		await fireEvent.click(within(review).getByRole("button", { name: "Commit at revision 2" }));
		await waitFor(() => expect(service.transitionPackage).toHaveBeenCalledWith("project-1", pkg("active").referenceId, "quarantine", 2));
		expect(await screen.findByRole("status")).toHaveTextContent("@ezcorp/active is quarantined at trust revision 3. The fence reached 2 runs. The change is in the audit log.");
		expect(service.packageAffectedRuns).toHaveBeenCalledWith("project-1", pkg("active").referenceId, { trustRevision: 3, limit: 200 });
		expect(service.listPackages).toHaveBeenCalledTimes(2);
		// The fence's own record of the decision, one row per attempt, each with what the fence did.
		const record = screen.getByRole("region", { name: "Fence record" });
		expect(within(record).getByRole("heading")).toHaveTextContent("Fence record · @ezcorp/active@1.0.0 · trust revision 3");
		expect(within(record).getAllByRole("listitem").map(row => row.textContent?.replace(/\s+/g, " ").trim())).toEqual([
			"run-1attempt a-1 · was running · launchedcancel requested",
			"run-1attempt a-2 · was running · launchedalready cancelling",
			"run-2attempt a-3 · was admitted · not launchedalready finished",
		]);
		expect(within(record).queryByText(/Only the first/)).toBeNull();
	});

	test("a publish reads no fence record; an empty or longer record says so; another project clears it", async () => {
		const service = api({
			packageAffectedRuns: vi.fn(async () => ({ items: [], nextCursor: null })),
			transitionPackage: vi.fn(async (_p: string, _r: string, transition: FactoryPackageTransition) => ({ ...pkg("active", transition === "publish" ? "active" : "revoked", 4) })),
		});
		const view = mount(service);
		const active = await screen.findByRole("group", { name: "Trust actions for @ezcorp/active" });
		await fireEvent.click(within(active).getByRole("button", { name: "Re-trust" }));
		await fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Commit at revision 2" }));
		expect(await screen.findByRole("status")).toHaveTextContent("@ezcorp/active is active at trust revision 4. The change is in the audit log.");
		expect(service.packageAffectedRuns).not.toHaveBeenCalled();
		expect(screen.queryByRole("region", { name: "Fence record" })).toBeNull();

		await fireEvent.click(within(await screen.findByRole("group", { name: "Trust actions for @ezcorp/active" })).getByRole("button", { name: "Revoke" }));
		await fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Commit at revision 2" }));
		expect(await screen.findByRole("status")).toHaveTextContent("@ezcorp/active is revoked at trust revision 4. The fence reached 0 runs.");
		expect(screen.getByRole("region", { name: "Fence record" })).toHaveTextContent("No live attempt used this package, so the fence stopped nothing.");

		service.packageAffectedRuns = vi.fn(async () => ({ items: [fencedAttempt("run-9", "a-9", "cancel-requested")], nextCursor: "next" }));
		await fireEvent.click(within(await screen.findByRole("group", { name: "Trust actions for @ezcorp/active" })).getByRole("button", { name: "Quarantine" }));
		await fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Commit at revision 2" }));
		expect(await screen.findByRole("status")).toHaveTextContent("The fence reached 1+ run. The change is in the audit log.");
		expect(screen.getByRole("region", { name: "Fence record" })).toHaveTextContent("Only the first 1 attempts are shown.");

		await view.rerender({ projectId: "project-2", tenantId: "tenant-1", administrator: true, api: service });
		await waitFor(() => expect(screen.queryByRole("region", { name: "Fence record" })).toBeNull());
	});

	test("a refused review cannot be committed, a publish review names its scope, and cancel closes it", async () => {
		const service = api({
			packageImpact: vi.fn(async (_p: string, _r: string, transition: FactoryPackageTransition): Promise<FactoryPackageImpact> => transition === "revoke"
				? { transition, currentRevision: 0, allowed: false, refusal: "The untrusted package cannot take the revoke transition.", runs: [], truncated: false }
				: { transition, currentRevision: 0, allowed: true, runs: [{ runId: "run-1", factoryId: "f", status: "queued", liveAttempts: 0 }], truncated: false }),
		});
		mount(service);
		const fresh = await screen.findByRole("group", { name: "Trust actions for @ezcorp/new" });
		await fireEvent.click(within(fresh).getByRole("button", { name: "Revoke" }));
		const refused = await screen.findByRole("dialog");
		expect(within(refused).getByRole("alert")).toHaveTextContent("cannot take the revoke transition");
		expect(within(refused).getByRole("button", { name: /Commit/ })).toBeDisabled();
		await fireEvent.click(within(refused).getByRole("button", { name: "Cancel" }));
		await fireEvent.click(within(fresh).getByRole("button", { name: "Trust" }));
		const publish = await screen.findByRole("dialog", { name: "Trust @ezcorp/new" });
		expect(publish).toHaveTextContent("1 live run use this package.");
		expect(publish).not.toHaveTextContent("New dispatch stops");
		await fireEvent.click(within(publish).getByRole("button", { name: "Close review" }));
		await fireEvent.click(within(fresh).getByRole("button", { name: "Trust" }));
		await fireEvent.click(await screen.findByRole("presentation"));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		service.packageImpact = vi.fn(async (_p: string, _r: string, transition: FactoryPackageTransition): Promise<FactoryPackageImpact> => ({ transition, currentRevision: 1, allowed: true, runs: [], truncated: false }));
		await fireEvent.click(within(fresh).getByRole("button", { name: "Trust" }));
		expect(await screen.findByRole("dialog")).toHaveTextContent("No live run uses this package.");
		service.packageImpact = vi.fn(async () => { throw new FactoryApiClientError(403, "factory_forbidden", "no"); });
		await fireEvent.click(within(fresh).getByRole("button", { name: "Trust" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("This needs a tenant administrator in an interactive session.");
	});

	test("installing binds exactly what was typed, trimmed", async () => {
		const service = api();
		mount(service);
		await fireEvent.click(await screen.findByRole("button", { name: /Install/ }));
		const form = screen.getByRole("form", { name: "Install runner package" });
		for (const [label, value] of [["Package", " @ezcorp/x "], ["Manifest name", " x "], ["Version", " 2.0.0 "], ["Export", " run "], ["Digest", ` ${digest} `], ["Installation", " inst "], ["Release", " rel "]] as const) {
			await fireEvent.input(within(form).getByLabelText(label), { target: { value } });
		}
		await fireEvent.submit(form);
		await waitFor(() => expect(service.installPackage).toHaveBeenCalledWith("project-1", { reference: { package: "@ezcorp/x", manifestName: "x", version: "2.0.0", digest, export: "run" }, installationId: "inst", releaseId: "rel" }));
		expect(await screen.findByRole("status")).toHaveTextContent("@ezcorp/x@2.0.0 is bound. Trust it before any run can dispatch it.");
		expect(screen.queryByRole("form", { name: "Install runner package" })).toBeNull();
	});

	test("grants: a new one starts at revision 0, an existing one at its revision, and a revoke names its revision", async () => {
		const service = api();
		mount(service);
		// Each grantee reads by name; the kind and exact identifier stay beside it.
		expect(await screen.findByText("Name of member-1")).toBeVisible();
		expect(screen.getByText("user · member-1")).toBeVisible();
		expect(screen.getByText("service · svc")).toBeVisible();
		expect(screen.getByText("factory.run · revision 2 · expires 2031-01-02 03:04 UTC")).toBeVisible();
		expect(screen.getByText("factory.operate · revision 2 · revoked")).toBeVisible();
		expect(screen.getAllByText("factory.run · revision 2 · no expiry")).toHaveLength(1);
		const form = screen.getByRole("form", { name: "Grant factory authority" });
		await fireEvent.input(within(form).getByLabelText("Identifier"), { target: { value: " newcomer " } });
		await fireEvent.submit(form);
		await waitFor(() => expect(service.setGrant).toHaveBeenCalledWith("project-1", "user", "newcomer", "factory.run", 0, null));
		expect(await screen.findByRole("status")).toHaveTextContent("factory.run granted to user newcomer at revision 1.");
		await fireEvent.input(within(form).getByLabelText("Identifier"), { target: { value: "member-1" } });
		await fireEvent.input(within(form).getByLabelText("Expires (optional)"), { target: { value: "2032-05-06T07:08" } });
		await fireEvent.submit(form);
		await waitFor(() => expect(service.setGrant).toHaveBeenLastCalledWith("project-1", "user", "member-1", "factory.run", 2, Date.parse("2032-05-06T07:08")));
		await fireEvent.change(within(form).getByLabelText("Principal"), { target: { value: "service" } });
		await fireEvent.change(within(form).getByLabelText("Action"), { target: { value: "factory.operate" } });
		await fireEvent.input(within(form).getByLabelText("Expires (optional)"), { target: { value: "" } });
		await fireEvent.submit(form);
		await waitFor(() => expect(service.setGrant).toHaveBeenLastCalledWith("project-1", "service", "member-1", "factory.operate", 0, null));
		await fireEvent.click(screen.getByRole("button", { name: "Revoke factory.run for svc" }));
		await waitFor(() => expect(service.revokeGrant).toHaveBeenCalledWith("project-1", "service", "svc", "factory.run", 2));
		expect(screen.queryByRole("button", { name: "Revoke factory.operate for old" })).toBeNull();
	});

	test("the purge request shows open work, needs the typed tenant, and records rather than deletes", async () => {
		const service = api();
		mount(service);
		const table = await screen.findByRole("table", { name: /tenant-1/ });
		expect(table).toHaveTextContent("Runs still running2Open");
		expect(table).toHaveTextContent("Uncertain usage0Closed");
		expect(screen.getByText(/would remove/)).toHaveTextContent("A purge would remove 1 audit record. The request itself is kept.");
		const submit = screen.getByRole("button", { name: "Record purge request" });
		expect(submit).toBeDisabled();
		await fireEvent.input(screen.getByLabelText("Reason"), { target: { value: "closing" } });
		expect(submit).toBeDisabled();
		await fireEvent.input(screen.getByLabelText("Type the tenant identifier to confirm"), { target: { value: "tenant-1" } });
		expect(submit).toBeEnabled();
		await fireEvent.click(submit);
		await waitFor(() => expect(service.requestPurge).toHaveBeenCalledWith("tenant-1", "closing", "tenant-1"));
		expect(await screen.findByText(/was recorded and refused: open work remains/)).toBeVisible();
		expect(screen.getByText("purge-1")).toBeVisible();
		service.requestPurge = vi.fn(async () => ({ ...preview, preconditions: [], auditRowsLost: 2, requestId: "purge-2", state: "queued" as const, requestedBy: "u", requestedAtMs: 1 }));
		service.purgePreview = vi.fn(async () => ({ ...preview, auditRowsLost: 2 }));
		await fireEvent.click(screen.getByRole("button", { name: "Record purge request" }));
		expect(await screen.findByText("Purge request purge-2 is queued. Nothing has been deleted.")).toBeVisible();
		expect(await screen.findByText(/would remove/)).toHaveTextContent("A purge would remove 2 audit records.");
	});

	test("a recovery report is signed by its exact digest; a blocked check or a finished restore offers no signature", async () => {
		const blockedReport = { ...restore("restore-blocked").report!, findings: [finding("objects", "blocked", "object version missing"), { ...finding("release-1", "blocked", "receipt_unverified"), subjectKind: "release" as const, subjectId: "[\"project-1\",\"factory-release:abc\"]" }, { ...finding("odd", "verified"), subjectId: "[\"unclosed" }, { ...finding("numbers", "verified"), subjectId: "[1,2]" }, finding("schema", "verified")], findingCount: 240, blockedChecks: ["check:objects:object version missing"] };
		const service = api({
			listRestores: vi.fn(async () => [
				restore("restore-clean", { report: { ...restore("restore-clean").report!, blockedRuns: ["[\"p\",\"r\"]"] } }),
				restore("restore-blocked", { report: blockedReport }),
				restore("restore-done", { state: "enabled", signedBy: "admin-1", signedAtMs: Date.UTC(2031, 0, 2, 3, 4) }),
				restore("restore-fenced", { state: "fenced", reportDigest: undefined, report: undefined }),
			]),
			signRestore: vi.fn(async (_tenant: string, restoreId: string) => ({ restoreId, enabled: true as const, rebound: 1, blockedRuns: ["[\"p\",\"r\"]", "[\"p\",\"s\"]"] })),
		});
		mount(service);
		const clean = await screen.findByRole("article", { name: "restore-clean" });
		expect(clean).toHaveTextContent(reportDigest);
		expect(clean).toHaveTextContent("3 → 4");
		expect(clean).toHaveTextContent("Releases recovered 2 of 2. Blocked runs 1. Recovery took 4 s.");
		const blocked = screen.getByRole("article", { name: "restore-blocked" });
		expect(blocked).toHaveTextContent("Findings, 5 of 240 with every blocked one first");
		// A subject that names several identities reads as a path; any other subject is shown as stored.
		expect(within(blocked).getByText("project-1 / factory-release:abc")).toBeVisible();
		expect(within(blocked).getByText("[\"unclosed")).toBeVisible();
		expect(within(blocked).getByText("[1,2]")).toBeVisible();
		expect(blocked).toHaveTextContent("A blocked check keeps the tenant closed, so this report cannot be signed: check:objects:object version missing.");
		expect(within(blocked).queryByRole("button")).toBeNull();
		expect(screen.getByRole("article", { name: "restore-done" })).toHaveTextContent("by admin-1 · 2031-01-02 03:04 UTC");
		expect(within(screen.getByRole("article", { name: "restore-done" })).queryByRole("button")).toBeNull();
		expect(within(screen.getByRole("article", { name: "restore-fenced" })).queryByRole("table")).toBeNull();
		await fireEvent.click(within(clean).getByRole("button", { name: /Sign report and reopen service/ }));
		expect(await screen.findByRole("status")).toHaveTextContent("Restore restore-clean is signed and service is open. 1 run moved to epoch 4. 2 blocked runs stay at the old epoch.");
		expect(service.signRestore).toHaveBeenCalledWith("tenant-1", "restore-clean", reportDigest);
		service.signRestore = vi.fn(async () => ({ restoreId: "restore-clean", enabled: true as const, rebound: 2, blockedRuns: ["[\"p\",\"r\"]"] }));
		await fireEvent.click(within(screen.getByRole("article", { name: "restore-clean" })).getByRole("button", { name: /Sign report/ }));
		expect(await screen.findByRole("status")).toHaveTextContent("2 runs moved to epoch 4. 1 blocked run stays at the old epoch.");
		service.signRestore = vi.fn(async () => { throw new FactoryApiClientError(412, "factory_restore_report_mismatch", "stale"); });
		await fireEvent.click(within(screen.getByRole("article", { name: "restore-clean" })).getByRole("button", { name: /Sign report/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Someone changed this first.");
	});

	test("with no restore, the panel says so; a signature without a known digest does nothing", async () => {
		const service = api({ listRestores: vi.fn(async () => [restore("restore-x", { reportDigest: undefined })]) });
		mount(service);
		const pending = await screen.findByRole("article", { name: "restore-x" });
		expect(within(pending).getByRole("button", { name: /Sign report/ })).toBeDisabled();
		const empty = api();
		render(FactoryAdministration, { projectId: "project-2", tenantId: "tenant-1", administrator: true, api: empty });
		expect(await screen.findByText("No restore has been opened for this tenant.")).toBeVisible();
	});

	test("a member reads but cannot change, and an unknown tenant is said plainly", async () => {
		const service = api();
		const member = mount(service, false);
		expect(await screen.findByText("You can read packages and grants. Changing them needs a tenant administrator.")).toBeVisible();
		expect(screen.getByText("Only a tenant administrator can ask for a purge.")).toBeVisible();
		expect(screen.getByRole("button", { name: /Install/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: /Grant/ })).toBeDisabled();
		expect(service.purgePreview).not.toHaveBeenCalled();
		member.unmount();
		mount(api(), true, null);
		expect(await screen.findByText("Factory services are not ready, so the tenant is not known yet.")).toBeVisible();
	});

	test("each failure reads as its cause, a stale change reloads, and banners dismiss", async () => {
		const service = api({
			listGrants: vi.fn(async () => { throw new FactoryApiClientError(401, "auth", "no"); }),
			purgePreview: vi.fn(async () => { throw new FactoryApiClientError(403, "factory_forbidden", "no"); }),
		});
		mount(service);
		expect(await screen.findByRole("alert")).toHaveTextContent(/^This needs a tenant administrator in an interactive session\.$/);
		expect(await screen.findByRole("group", { name: "Trust actions for @ezcorp/active" })).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
		expect(screen.queryByRole("alert")).toBeNull();
		for (const [error, text] of [
			[new FactoryApiClientError(412, "stale", "x"), "Someone changed this first. The current state is loaded; review it and try again."],
			[new FactoryApiClientError(409, "conflict", "x"), "That request conflicts with one already recorded."],
			[new FactoryApiClientError(500, "boom", "The service failed."), "The service failed."],
			[new Error("network down"), "network down"],
			["odd", "The factory service is unavailable."],
		] as const) {
			service.transitionPackage = vi.fn(async () => { throw error; });
			await fireEvent.click(within(screen.getByRole("group", { name: "Trust actions for @ezcorp/active" })).getByRole("button", { name: "Revoke" }));
			await fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /Commit/ }));
			expect(await screen.findByRole("alert")).toHaveTextContent(text);
		}
		await fireEvent.click(screen.getByRole("button", { name: "Refresh administration" }));
		// Loaded once, reloaded after the stale-revision refusal, and once more by the refresh button.
		await waitFor(() => expect(service.listPackages).toHaveBeenCalledTimes(3));
		service.setGrant = vi.fn(async () => grant("x"));
		const form = screen.getByRole("form", { name: "Grant factory authority" });
		await fireEvent.input(within(form).getByLabelText("Identifier"), { target: { value: "x" } });
		await fireEvent.submit(form);
		await fireEvent.click(await screen.findByRole("button", { name: "Dismiss message" }));
		expect(screen.queryByRole("status")).toBeNull();
	});

	test("an impossible expiry is refused before any request", async () => {
		const service = api();
		mount(service);
		const form = await screen.findByRole("form", { name: "Grant factory authority" });
		const expires = within(form).getByLabelText("Expires (optional)") as HTMLInputElement;
		Object.defineProperty(expires, "value", { configurable: true, get: () => "not-a-date", set: () => undefined });
		await fireEvent.input(expires);
		await fireEvent.input(within(form).getByLabelText("Identifier"), { target: { value: "x" } });
		await fireEvent.submit(form);
		expect(await screen.findByRole("alert")).toHaveTextContent("The expiry is not a valid date.");
		expect(service.setGrant).not.toHaveBeenCalled();
	});
});
