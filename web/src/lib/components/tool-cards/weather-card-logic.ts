export interface WeatherCardPayload {
	location: {
		name: string;
		country: string;
		admin1?: string;
		timezone?: string;
	};
	units: {
		temperature: string;
		windSpeed: string;
	};
	current: {
		temperature: number;
		feelsLike: number;
		windSpeed: number;
		humidity: number;
		condition: string;
		emoji: string;
		isDay: boolean;
	};
	daily: Array<{
		date: string;
		dayLabel: string;
		condition: string;
		emoji: string;
		tempMax: number;
		tempMin: number;
		precipitationChance: number;
	}>;
	hourly: Array<{
		time: string;
		label: string;
		temperature: number;
		condition: string;
		emoji: string;
	}>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseWeatherPayload(output: unknown): WeatherCardPayload | null {
	if (output == null) return null;
	const raw = typeof output === 'string' ? output : JSON.stringify(output);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	if (!isRecord(parsed.location) || !isRecord(parsed.units) || !isRecord(parsed.current)) return null;
	if (!Array.isArray(parsed.daily) || !Array.isArray(parsed.hourly)) return null;
	if (typeof parsed.location.name !== 'string' || typeof parsed.current.condition !== 'string') return null;
	if (typeof parsed.units.temperature !== 'string' || typeof parsed.units.windSpeed !== 'string') return null;
	return parsed as unknown as WeatherCardPayload;
}

export function formatTemp(value: number, unit: string): string {
	return `${value.toFixed(1)}${unit}`;
}

export function formatLocation(payload: WeatherCardPayload): string {
	return [payload.location.name, payload.location.admin1, payload.location.country].filter(Boolean).join(', ');
}
