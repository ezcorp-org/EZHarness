import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'vitest';
import '@testing-library/jest-dom/vitest';
import WeatherCard from './WeatherCard.svelte';
import type { ToolCallState } from '$lib/stores.svelte';

function makeToolCall(overrides: Partial<ToolCallState> = {}): ToolCallState {
	return {
		id: 'tc-weather-1',
		toolName: 'weather__get_weather',
		status: 'complete',
		input: { location: 'Paris' },
		startedAt: 0,
		duration: 150,
		cardType: 'weather-panel',
		output: JSON.stringify({
			location: { name: 'Paris', admin1: 'Ile-de-France', country: 'France', timezone: 'Europe/Paris' },
			units: { temperature: '°C', windSpeed: 'km/h' },
			current: {
				temperature: 19.2,
				feelsLike: 18.6,
				windSpeed: 11.4,
				humidity: 57,
				condition: 'Partly cloudy',
				emoji: '🌤️',
				isDay: true,
			},
			daily: [
				{ date: '2026-06-01', dayLabel: 'Today', condition: 'Partly cloudy', emoji: '🌤️', tempMax: 22.1, tempMin: 14.2, precipitationChance: 10 },
				{ date: '2026-06-02', dayLabel: 'Tue', condition: 'Rain', emoji: '🌧️', tempMax: 20.5, tempMin: 13.4, precipitationChance: 80 },
				{ date: '2026-06-03', dayLabel: 'Wed', condition: 'Overcast', emoji: '☁️', tempMax: 18.9, tempMin: 12.8, precipitationChance: 20 },
			],
			hourly: [
				{ time: '2026-06-01T10:00', label: 'Now', temperature: 19.2, condition: 'Partly cloudy', emoji: '🌤️' },
				{ time: '2026-06-01T11:00', label: '11 AM', temperature: 19.8, condition: 'Partly cloudy', emoji: '🌤️' },
			],
		}),
		...overrides,
	};
}

afterEach(() => cleanup());

describe('WeatherCard', () => {
	test('renders the custom weather-display-card host and weather details', () => {
		const { getByTestId, getByText, getAllByText } = render(WeatherCard, { toolCall: makeToolCall() });
		expect(getByTestId('weather-card-host').tagName.toLowerCase()).toBe('weather-display-card');
		expect(getByTestId('weather-display-card')).toBeInTheDocument();
		expect(getByText('Paris, Ile-de-France, France')).toBeInTheDocument();
		expect(getAllByText(/19.2°C/).length).toBeGreaterThanOrEqual(1);
		expect(getByText('5-day forecast')).toBeInTheDocument();
		expect(getByText('Hourly forecast')).toBeInTheDocument();
	});

	test('renders inline error state for malformed payload', () => {
		const { getByTestId } = render(WeatherCard, {
			toolCall: makeToolCall({ output: 'not json at all' }),
		});
		expect(getByTestId('weather-card-missing')).toBeInTheDocument();
	});
});
