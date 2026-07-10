/**
 * Pure logic for GradeDeltaCard — payload parsing, grouped-bar-chart
 * geometry, and price-table shaping — extracted so unit tests exercise
 * the math without rendering Svelte (mirrors price-chart-logic.ts).
 *
 * Payload: the graded-card-scanner `identify_slab` tool's JSON output
 * (`{ cert, grader, identity, grades, deltas, sources }`), delivered
 * either as a raw JSON string, an MCP `{content:[{type:"text"}]}`
 * envelope, or an already-parsed object.
 */

export interface GradeDeltaIdentity {
	subject: string;
	year: string;
	set: string;
	cardNo: string;
	variety: string;
	grade: string;
}

export interface GradeDeltaStep {
	from: string;
	to: string;
	fromPrice: number;
	toPrice: number;
	pct: number;
}

export interface GradeDeltaCompany {
	company: string;
	steps: GradeDeltaStep[];
}

export interface GradeDeltaPayload {
	cert: string | null;
	grader: string;
	identity: GradeDeltaIdentity;
	/** company → (grade label → price|null). */
	grades: Record<string, Record<string, number | null>>;
	deltas: GradeDeltaCompany[];
}

/** Extract the payload object from any of the three output shapes. */
function extractObject(out: unknown): Record<string, unknown> | null {
	if (out == null) return null;
	if (typeof out === "string") {
		try {
			return JSON.parse(out) as Record<string, unknown>;
		} catch {
			return null;
		}
	}
	if (typeof out !== "object") return null;
	const o = out as Record<string, unknown>;
	if (Array.isArray(o.content)) {
		const text = (o.content as Array<{ type?: string; text?: unknown }>).find(
			(c) => c.type === "text",
		)?.text;
		if (typeof text === "string") {
			try {
				return JSON.parse(text) as Record<string, unknown>;
			} catch {
				return null;
			}
		}
	}
	return o;
}

function stringOr(v: unknown, fallback: string): string {
	return typeof v === "string" ? v : fallback;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Lenient step validation — every numeric field must be finite. */
function parseStep(v: unknown): GradeDeltaStep | null {
	if (!isPlainObject(v)) return null;
	const from = v.from;
	const to = v.to;
	const fromPrice = v.fromPrice;
	const toPrice = v.toPrice;
	const pct = v.pct;
	if (typeof from !== "string" || typeof to !== "string") return null;
	if (typeof fromPrice !== "number" || !Number.isFinite(fromPrice)) return null;
	if (typeof toPrice !== "number" || !Number.isFinite(toPrice)) return null;
	if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
	return { from, to, fromPrice, toPrice, pct };
}

/**
 * Parse an identify_slab record. Requires `grader` (string), a `grades`
 * object, and a `deltas` array — malformed entries inside either are
 * dropped rather than failing the whole card. Returns null when the
 * shape is unusable so the component renders its error state.
 */
export function parseGradeDeltaPayload(out: unknown): GradeDeltaPayload | null {
	const obj = extractObject(out);
	if (!obj) return null;
	if (typeof obj.grader !== "string" || obj.grader.length === 0) return null;
	if (!isPlainObject(obj.grades) || !Array.isArray(obj.deltas)) return null;

	const grades: Record<string, Record<string, number | null>> = {};
	for (const [company, byGrade] of Object.entries(obj.grades)) {
		if (!isPlainObject(byGrade)) continue;
		const clean: Record<string, number | null> = {};
		for (const [grade, price] of Object.entries(byGrade)) {
			clean[grade] = typeof price === "number" && Number.isFinite(price) ? price : null;
		}
		grades[company] = clean;
	}

	const deltas: GradeDeltaCompany[] = [];
	for (const entry of obj.deltas) {
		if (!isPlainObject(entry) || typeof entry.company !== "string") continue;
		if (!Array.isArray(entry.steps)) continue;
		const steps = entry.steps
			.map(parseStep)
			.filter((s): s is GradeDeltaStep => s !== null);
		deltas.push({ company: entry.company, steps });
	}

	const rawIdentity = isPlainObject(obj.identity) ? obj.identity : {};
	const identity: GradeDeltaIdentity = {
		subject: stringOr(rawIdentity.subject, ""),
		year: stringOr(rawIdentity.year, ""),
		set: stringOr(rawIdentity.set, ""),
		cardNo: stringOr(rawIdentity.cardNo, ""),
		variety: stringOr(rawIdentity.variety, ""),
		grade: stringOr(rawIdentity.grade, ""),
	};

	return {
		cert: typeof obj.cert === "string" ? obj.cert : null,
		grader: obj.grader,
		identity,
		grades,
		deltas,
	};
}

/** "1999 Pokemon Base Set Charizard #4" — empty string when nothing known. */
export function identityTitle(identity: GradeDeltaIdentity): string {
	const bits = [identity.year, identity.set, identity.subject].filter((s) => s.trim() !== "");
	let title = bits.join(" ");
	if (identity.cardNo.trim() !== "" && title !== "") title += ` #${identity.cardNo}`;
	return title;
}

/** "+1063.3%" / "−25%" — signed, minus uses the typographic sign. */
export function formatPct(pct: number): string {
	const sign = pct >= 0 ? "+" : "−";
	return `${sign}${Math.abs(pct)}%`;
}

/** "$2,587.50" or "N/A" for null/undefined (null-honesty: never $0). */
export function formatPrice(value: number | null | undefined): string {
	if (value === null || value === undefined || Number.isNaN(value)) return "N/A";
	return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Grouped bar chart geometry ──────────────────────────────────────

export interface ChartPlot {
	width: number;
	height: number;
	padTop: number;
	padBottom: number;
	padX: number;
	groupGap: number;
	barGap: number;
}

export interface DeltaBar {
	x: number;
	y: number;
	w: number;
	h: number;
	/** e.g. "PSA 9→10". */
	stepLabel: string;
	/** e.g. "+1063.3%". */
	pctLabel: string;
	company: string;
	/** True when the step's pct is negative (price drop). */
	negative: boolean;
}

export interface DeltaGroup {
	company: string;
	xCenter: number;
}

export interface DeltaChart {
	bars: DeltaBar[];
	groups: DeltaGroup[];
	maxAbsPct: number;
}

/**
 * Lay out one bar per adjacent-grade step, grouped per company. Bar
 * height = |pct| normalized against the largest |pct| on the chart
 * (min 2px so a near-zero step stays visible). Companies with no steps
 * never reach here — the backend omits them from `deltas` (they still
 * show in the price table). Returns null when there is nothing to draw.
 */
export function buildDeltaChart(
	deltas: GradeDeltaCompany[],
	plot: ChartPlot,
): DeltaChart | null {
	const withSteps = deltas.filter((d) => d.steps.length > 0);
	const totalBars = withSteps.reduce((a, d) => a + d.steps.length, 0);
	if (totalBars === 0) return null;

	const maxAbsPct = Math.max(
		...withSteps.flatMap((d) => d.steps.map((s) => Math.abs(s.pct))),
	);
	const innerH = plot.height - plot.padTop - plot.padBottom;
	const innerW = plot.width - 2 * plot.padX;
	const gaps = (withSteps.length - 1) * plot.groupGap + (totalBars - withSteps.length) * plot.barGap;
	const barW = Math.max(4, (innerW - gaps) / totalBars);

	const bars: DeltaBar[] = [];
	const groups: DeltaGroup[] = [];
	let x = plot.padX;
	for (const company of withSteps) {
		const groupStart = x;
		for (const step of company.steps) {
			const h = maxAbsPct > 0 ? Math.max(2, (Math.abs(step.pct) / maxAbsPct) * innerH) : 2;
			bars.push({
				x,
				y: plot.padTop + innerH - h,
				w: barW,
				h,
				stepLabel: `${company.company} ${step.from}→${step.to}`,
				pctLabel: formatPct(step.pct),
				company: company.company,
				negative: step.pct < 0,
			});
			x += barW + plot.barGap;
		}
		const groupEnd = x - plot.barGap;
		groups.push({ company: company.company, xCenter: (groupStart + groupEnd) / 2 });
		x += plot.groupGap - plot.barGap;
	}

	return { bars, groups, maxAbsPct };
}

// ── Price table shaping ─────────────────────────────────────────────

export interface PriceTable {
	/** Column order (companies sorted by name). */
	companies: string[];
	/** One row per grade (union across companies, numeric ascending). */
	rows: Array<{ grade: string; prices: Array<number | null> }>;
}

/**
 * Shape the per-company grade map into table rows. Every company with
 * ANY data appears — including those the chart omitted for having < 2
 * priced grades. Missing (company, grade) cells are null → "N/A".
 */
export function buildPriceTable(
	grades: Record<string, Record<string, number | null>>,
): PriceTable | null {
	const companies = Object.keys(grades).sort();
	if (companies.length === 0) return null;
	const gradeSet = new Set<string>();
	for (const company of companies) {
		for (const grade of Object.keys(grades[company]!)) gradeSet.add(grade);
	}
	if (gradeSet.size === 0) return null;
	const rows = Array.from(gradeSet)
		.sort((a, b) => Number(a) - Number(b))
		.map((grade) => ({
			grade,
			prices: companies.map((company) => grades[company]?.[grade] ?? null),
		}));
	return { companies, rows };
}
