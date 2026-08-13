export interface TimeClockPayload {
	_assistant_note?: string;
	cardType?: 'time-clock';
	label: string;
	formatted: string;
	timezone: string;
	locale: string;
	iso: string;
	hour12?: boolean;
	currentTimeText?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractTextFromToolResultEnvelope(output: unknown): { textOrOutput: unknown; envelopeCardType?: unknown } {
	if (!isRecord(output) || !Array.isArray(output.content)) return { textOrOutput: output };
	const texts = output.content
		.filter((part): part is { type: string; text: string } => (
			isRecord(part) && part.type === 'text' && typeof part.text === 'string'
		))
		.map((part) => part.text);
	return {
		textOrOutput: texts.length > 0 ? texts.join('\n') : output,
		envelopeCardType: output.cardType,
	};
}

export function parseTimeClockPayload(output: unknown): TimeClockPayload | null {
	if (output == null) return null;
	const { textOrOutput: extracted, envelopeCardType } = extractTextFromToolResultEnvelope(output);
	let parsed: unknown = extracted;
	if (typeof extracted === 'string') {
		try {
			parsed = JSON.parse(extracted);
		} catch {
			return null;
		}
	}
	if (!isRecord(parsed)) return null;
	if (parsed.cardType !== 'time-clock' && envelopeCardType !== 'time-clock') return null;
	const normalized: Record<string, unknown> = { cardType: 'time-clock', ...parsed };
	if (
		typeof normalized.label !== 'string' ||
		typeof normalized.formatted !== 'string' ||
		typeof normalized.timezone !== 'string' ||
		typeof normalized.locale !== 'string' ||
		typeof normalized.iso !== 'string'
	) {
		return null;
	}
	if (Number.isNaN(Date.parse(normalized.iso))) return null;
	return normalized as unknown as TimeClockPayload;
}

/**
 * Defensive host-side detection for extension-authored time-teller calls.
 * Some older installs / resumed streams can lose the manifest `cardType` on
 * the lifecycle event even though the tool output is the canonical time-clock
 * payload. The chat shell uses this helper to still route to TimeClockCard.
 */
export function isTimeClockOutput(output: unknown): boolean {
	return parseTimeClockPayload(output) !== null;
}

export interface ClockParts {
	hour: number;
	minute: number;
	second: number;
	hourAngle: number;
	minuteAngle: number;
	secondAngle: number;
}

export function getClockParts(date: Date, locale: string, timezone: string): ClockParts {
	const formatter = new Intl.DateTimeFormat(locale || 'en-US', {
		timeZone: timezone,
		hour: 'numeric',
		minute: 'numeric',
		second: 'numeric',
		hourCycle: 'h23',
	});
	const parts = formatter.formatToParts(date);
	const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
	const hour = get('hour');
	const minute = get('minute');
	const second = get('second');
	const hour12 = hour % 12;
	return {
		hour,
		minute,
		second,
		hourAngle: hour12 * 30 + minute * 0.5 + second / 120,
		minuteAngle: minute * 6 + second * 0.1,
		secondAngle: second * 6,
	};
}

export function formatClockDate(date: Date, payload: TimeClockPayload): string {
	try {
		return new Intl.DateTimeFormat(payload.locale || 'en-US', {
			dateStyle: 'full',
			timeStyle: 'long',
			timeZone: payload.timezone,
			hour12: payload.hour12,
		}).format(date);
	} catch {
		return payload.formatted;
	}
}
