// @ts-check
// Orchestrator — wires scanner → dedupe gate → lookup → IndexedDB →
// list/detail rendering. All user-visible strings from scraped/looked-up
// data go through textContent (never innerHTML), so third-party strings
// can't inject; the only innerHTML sink is the chart SVG, whose text
// nodes are escaped by chart.js.

import { parseCertInput } from "./lib/cert.js";
import { createScanGate } from "./lib/dedupe.js";
import {
  buildGradeRows,
  cardTitle,
  formatMoney,
  formatPct,
  isSameGrade,
  searchMatch,
  valueAtOwnGrade,
} from "./lib/format.js";
import { mockCard } from "./lib/mock-card.js";
import * as db from "./lib/db.js";
import { lookupCard } from "./lib/api.js";
import { buildChartSvg } from "./lib/chart.js";
import { createScanner } from "./lib/scanner.js";

/** @typedef {import("./lib/db.js").SavedCard} SavedCard */

const $ = (/** @type {string} */ sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

const gate = createScanGate();
let sessionCount = 0;
let paused = false;

// ── Feedback ─────────────────────────────────────────────────────────

function feedback() {
  try {
    const Ctx = window.AudioContext ?? /** @type {any} */ (window).webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
      osc.onended = () => ctx.close();
    }
  } catch {
    // audio blocked until user gesture — fine, flash still fires
  }
  navigator.vibrate?.(80);
  const frame = $("#scan-frame");
  frame.classList.remove("gcs-flash");
  void frame.offsetWidth; // restart the animation
  frame.classList.add("gcs-flash");
}

/** @param {string} msg @param {boolean} [isError] */
function setStatus(msg, isError = false) {
  const el = $('[data-testid="gcs-status"]');
  el.textContent = msg;
  el.classList.toggle("gcs-error-text", isError);
}

/** @param {boolean} on */
function setMockMode(on) {
  $('[data-testid="gcs-mock-banner"]').hidden = !on;
}

// ── Capture pipeline ─────────────────────────────────────────────────

/** @param {string} text decoded barcode/QR text or manual input */
async function handleDecoded(text) {
  const cert = parseCertInput(text);
  if (!cert) {
    setStatus("Not a PSA cert — scan the barcode or QR on the slab.", true);
    return;
  }
  const verdict = gate.tryAcquire(cert);
  if (verdict !== "new") return; // cooldown / already looking it up

  try {
    feedback();
    const existing = await db.getCard(cert);
    if (existing) {
      existing.scans.push(new Date().toISOString());
      existing.updatedAt = new Date().toISOString();
      await db.putCard(existing);
      setStatus(`Cert ${cert} — already scanned.`);
      await renderList();
      return;
    }

    sessionCount += 1;
    $('[data-testid="gcs-count"]').textContent = String(sessionCount);
    const nowIso = new Date().toISOString();
    /** @type {SavedCard} */
    const row = {
      cert,
      status: "pending",
      record: null,
      scans: [nowIso],
      savedAt: nowIso,
      updatedAt: nowIso,
    };
    await db.putCard(row);
    setStatus(`Cert ${cert} — looking up…`);
    await renderList();
    await runLookup(cert, false);
  } finally {
    gate.settle(cert);
  }
}

/**
 * Fetch data for a saved cert and update its row. Unreachable backend →
 * mock mode (sample data, clearly labeled). Tool-level failure → error
 * status; the row keeps any data it already had.
 * @param {string} cert
 * @param {boolean} fresh
 */
async function runLookup(cert, fresh) {
  const row = await db.getCard(cert);
  if (!row) return;
  try {
    row.record = await lookupCard(cert, { fresh });
    row.status = "done";
    row.error = undefined;
    setMockMode(false);
    setStatus(`Cert ${cert} — done.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!row.record) {
      // Nothing fetched yet → mock mode keeps the demo flow alive.
      row.record = mockCard(cert);
      row.status = "done";
      row.error = undefined;
      setMockMode(true);
      setStatus(`Backend unreachable — showing sample data for ${cert}.`);
    } else {
      // Fresh re-pull failed: keep the existing data, surface the error.
      row.status = "error";
      row.error = msg;
      setStatus(`Refresh failed for ${cert}: ${msg}`, true);
    }
  }
  row.updatedAt = new Date().toISOString();
  await db.putCard(row);
  await renderList();
  if (!$('[data-testid="gcs-detail"]').hidden && detailCert === cert) {
    await renderDetail(cert);
  }
}

// ── List view ────────────────────────────────────────────────────────

async function renderList() {
  const query = /** @type {HTMLInputElement} */ ($('[data-testid="gcs-search"]')).value;
  const rows = (await db.listCards()).filter((r) => searchMatch(r, query));
  const list = $('[data-testid="gcs-list"]');
  list.textContent = "";
  $('[data-testid="gcs-empty"]').hidden = rows.length > 0;

  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "gcs-row";
    li.dataset.testid = "gcs-row";
    li.dataset.cert = row.cert;

    const main = document.createElement("div");
    main.className = "gcs-row-main";
    const title = document.createElement("div");
    title.className = "gcs-row-title";
    title.textContent = row.record ? cardTitle(row.record.identity) : `Cert ${row.cert}`;
    const sub = document.createElement("div");
    sub.className = "gcs-row-sub";
    const value = row.record ? formatMoney(valueAtOwnGrade(row.record)) : "…";
    sub.textContent = `${row.cert} · ${value}`;
    main.append(title, sub);

    const badges = document.createElement("div");
    badges.className = "gcs-row-badges";
    if (row.record) {
      const grade = document.createElement("span");
      grade.className = "gcs-grade-badge";
      grade.textContent = row.record.identity.grade;
      badges.append(grade);
    }
    const chip = document.createElement("span");
    chip.className = `gcs-chip gcs-chip-${row.status}`;
    chip.dataset.testid = "gcs-status-chip";
    chip.textContent = row.status;
    badges.append(chip);

    const del = document.createElement("button");
    del.className = "gcs-icon-btn";
    del.dataset.testid = "gcs-delete";
    del.textContent = "✕";
    del.setAttribute("aria-label", `Delete ${row.cert}`);
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await db.deleteCard(row.cert);
      await renderList();
    });

    li.append(main, badges, del);
    li.addEventListener("click", () => renderDetail(row.cert));
    list.append(li);
  }
}

// ── Detail view ──────────────────────────────────────────────────────

/** @type {string|null} */
let detailCert = null;

/** @param {string} cert */
async function renderDetail(cert) {
  const row = await db.getCard(cert);
  if (!row) return;
  detailCert = cert;
  const panel = $('[data-testid="gcs-detail"]');
  panel.hidden = false;

  $('[data-testid="gcs-detail-title"]').textContent = row.record
    ? cardTitle(row.record.identity)
    : `Cert ${cert}`;
  const meta = row.record
    ? `${row.record.identity.grade}${row.record.identity.variety ? ` · ${row.record.identity.variety}` : ""} · cert ${cert}`
    : `cert ${cert} · ${row.status}`;
  $('[data-testid="gcs-detail-meta"]').textContent = meta;

  const tbody = $('[data-testid="gcs-grade-table"] tbody');
  tbody.textContent = "";
  const chartHost = $('[data-testid="gcs-chart"]');
  const sourcesEl = $('[data-testid="gcs-sources"]');
  sourcesEl.textContent = "";

  if (row.record) {
    for (const g of buildGradeRows(row.record.grades)) {
      const tr = document.createElement("tr");
      if (isSameGrade(g.grade, row.record.identity.grade)) tr.className = "gcs-tr-scanned";
      for (const cell of [
        g.grade,
        g.pop === null || g.pop === undefined ? "N/A" : g.pop.toLocaleString("en-US"),
        formatMoney(g.price),
        formatPct(g.pctVsLower),
      ]) {
        const td = document.createElement("td");
        td.textContent = cell;
        tr.append(td);
      }
      tbody.append(tr);
    }
    chartHost.innerHTML = buildChartSvg(row.record.grades, row.record.identity.grade);
    for (const [key, stamp] of Object.entries(row.record.sources)) {
      if (!stamp) continue;
      const line = document.createElement("div");
      line.textContent = `${key}: ${stamp.source} @ ${new Date(stamp.fetchedAt).toLocaleString()}`;
      sourcesEl.append(line);
    }
  } else {
    chartHost.textContent = "";
    const line = document.createElement("div");
    line.textContent = row.error ? `error: ${row.error}` : "lookup pending…";
    sourcesEl.append(line);
  }
}

function closeDetail() {
  detailCert = null;
  $('[data-testid="gcs-detail"]').hidden = true;
}

// ── Fetch fresh (briefly disabled after use so it can't be spammed) ──

async function fetchFresh() {
  if (!detailCert) return;
  const btn = /** @type {HTMLButtonElement} */ ($('[data-testid="gcs-fetch-fresh"]'));
  btn.disabled = true;
  setTimeout(() => {
    btn.disabled = false;
  }, 10_000);
  await runLookup(detailCert, true);
}

// ── Camera lifecycle ────────────────────────────────────────────────

const scanner = createScanner({
  videoEl: /** @type {HTMLVideoElement} */ ($('[data-testid="gcs-video"]')),
  onText: (text) => {
    if (!paused) void handleDecoded(text);
  },
  onError: (err) => {
    setStatus(`Camera unavailable (${err.message}) — use upload or manual entry.`, true);
    $('[data-testid="gcs-pause"]').hidden = true;
  },
});

/** @param {boolean} on */
function setPaused(on) {
  paused = on;
  const btn = $('[data-testid="gcs-pause"]');
  btn.textContent = on ? "Resume" : "Pause";
  if (on) scanner.stop();
  else void scanner.start();
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) scanner.stop();
  else if (!paused) void scanner.start();
});

// ── Wiring ───────────────────────────────────────────────────────────

$('[data-testid="gcs-pause"]').addEventListener("click", () => setPaused(!paused));

$('[data-testid="gcs-manual-form"]').addEventListener("submit", (e) => {
  e.preventDefault();
  const input = /** @type {HTMLInputElement} */ ($('[data-testid="gcs-manual-input"]'));
  void handleDecoded(input.value);
  input.value = "";
});

$('[data-testid="gcs-upload"]').addEventListener("change", async (e) => {
  const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
  if (!file) return;
  try {
    setStatus("Decoding image…");
    const text = await scanner.decodeImageFile(file);
    await handleDecoded(text);
  } catch {
    setStatus("No barcode/QR found in that image.", true);
  } finally {
    /** @type {HTMLInputElement} */ (e.target).value = "";
  }
});

$('[data-testid="gcs-simulate"]').addEventListener("click", () => {
  // Zero-network demo: a fresh pseudo-cert each press so repeated demos
  // add distinct cards (mock data fills in when the backend is absent).
  const cert = String(60000000 + Math.floor(Math.random() * 9_999_999));
  void handleDecoded(cert);
});

$('[data-testid="gcs-search"]').addEventListener("input", () => void renderList());
$('[data-testid="gcs-detail-close"]').addEventListener("click", closeDetail);
$('[data-testid="gcs-fetch-fresh"]').addEventListener("click", () => void fetchFresh());

$('[data-testid="gcs-clear-all"]').addEventListener("click", async () => {
  if (!confirm("Delete ALL scanned cards? This cannot be undone.")) return;
  await db.clearCards();
  gate.reset();
  closeDetail();
  await renderList();
});

// Deterministic hook for e2e + power users (page is session-authed).
/** @type {any} */ (window).__gcsSimulateScan = (/** @type {string} */ text) =>
  handleDecoded(text);

// ── Boot ─────────────────────────────────────────────────────────────

void (async () => {
  await renderList();
  setStatus("Point the camera at a slab, or use upload / manual entry.");
  await scanner.start();
})();
