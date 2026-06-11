/**
 * Daily Briefing — cron ↔ UI mapping (pure logic, no DOM, no DB).
 *
 * The briefing settings UI never exposes raw cron: users pick a
 * time-of-day plus a weekday preset, and we store the equivalent
 * 5-field cron string (validated server-side by `validateCron`, which
 * the briefing config API reuses from src/extensions/cron.ts).
 *
 * `parseBriefingCron` is intentionally STRICT: it only recognizes the
 * exact shapes this module itself writes (`M H * * <preset-dow>`).
 * Anything else — hand-edited crons supplied through the API by power
 * users — returns `null`, and the UI falls back to showing the raw
 * cron string read-only instead of mangling it through the pickers.
 *
 * Day-of-week values follow the Bun/Vixie convention used by
 * `parseCron` (Sunday=0 … Saturday=6).
 */

export type WeekdayPreset = "daily" | "weekdays" | "weekends";

/** Preset → cron day-of-week field. */
export const PRESET_TO_DOW: Record<WeekdayPreset, string> = {
	daily: "*",
	weekdays: "1-5",
	weekends: "0,6",
};

const DOW_TO_PRESET: Record<string, WeekdayPreset> = {
	"*": "daily",
	"1-5": "weekdays",
	"0,6": "weekends",
};

export const PRESET_LABELS: Record<WeekdayPreset, string> = {
	daily: "Every day",
	weekdays: "Weekdays",
	weekends: "Weekends",
};

export interface BriefingSchedule {
	/** 24h wall-clock time, "HH:MM" (as produced by <input type="time">). */
	time: string;
	preset: WeekdayPreset;
}

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * Build the 5-field cron string for a schedule. Returns `null` when the
 * time is not a valid "HH:MM" 24h value (the UI's time input should
 * never produce one, but a null contract beats writing garbage cron).
 */
export function buildBriefingCron(schedule: BriefingSchedule): string | null {
	const m = TIME_RE.exec(schedule.time);
	if (!m) return null;
	const dow = PRESET_TO_DOW[schedule.preset];
	if (!dow) return null;
	return `${parseInt(m[2]!, 10)} ${parseInt(m[1]!, 10)} * * ${dow}`;
}

/**
 * Inverse of `buildBriefingCron` — STRICT. Recognizes only crons this
 * module writes: literal minute + hour, `*` day-of-month and month, and
 * one of the three preset day-of-week fields. Returns `null` for
 * everything else (hand-edited cron → UI shows the raw string).
 */
export function parseBriefingCron(cron: string): BriefingSchedule | null {
	if (typeof cron !== "string") return null;
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
	if (dom !== "*" || month !== "*") return null;
	const preset = DOW_TO_PRESET[dow];
	if (!preset) return null;
	if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return null;
	const m = parseInt(min, 10);
	const h = parseInt(hour, 10);
	if (m > 59 || h > 23) return null;
	return { time: `${pad(h)}:${pad(m)}`, preset };
}

/**
 * Human-readable schedule line for UI-written crons
 * ("Weekdays at 07:00"); `null` for hand-edited ones.
 */
export function describeBriefingCron(cron: string): string | null {
	const schedule = parseBriefingCron(cron);
	if (!schedule) return null;
	return `${PRESET_LABELS[schedule.preset]} at ${schedule.time}`;
}

/**
 * Countdown label for the run-now 429 path ("4m 32s" / "32s").
 * Negative/fractional inputs clamp up to whole seconds ≥ 0.
 */
export function formatRetrySeconds(seconds: number): string {
	const s = Math.max(0, Math.ceil(seconds));
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}
