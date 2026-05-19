import { formatLocation, formatTemp, type WeatherCardPayload } from './weather-card-logic';

const TAG_NAME = 'weather-display-card';

function escapeHtml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

let registered = false;

function gradientFor(payload: WeatherCardPayload): string {
	const condition = payload.current.condition.toLowerCase();
	if (!payload.current.isDay) {
		return 'linear-gradient(160deg, #07111f 0%, #172554 48%, #312e81 100%)';
	}
	if (condition.includes('rain') || condition.includes('shower') || condition.includes('drizzle')) {
		return 'linear-gradient(160deg, #334155 0%, #2563eb 48%, #0f172a 100%)';
	}
	if (condition.includes('snow')) {
		return 'linear-gradient(160deg, #dbeafe 0%, #93c5fd 45%, #64748b 100%)';
	}
	if (condition.includes('cloud') || condition.includes('overcast')) {
		return 'linear-gradient(160deg, #60a5fa 0%, #64748b 52%, #334155 100%)';
	}
	return 'linear-gradient(160deg, #0ea5e9 0%, #2563eb 46%, #7c3aed 100%)';
}

function defineWeatherDisplayElement(): void {
	class WeatherDisplayCardElement extends HTMLElement {
		private _payload: WeatherCardPayload | null = null;

		set payload(value: WeatherCardPayload | null) {
			this._payload = value;
			this.render();
		}

		get payload(): WeatherCardPayload | null {
			return this._payload;
		}

		connectedCallback(): void {
			this.render();
		}

		private render(): void {
			const payload = this._payload;
			if (!payload) {
				this.innerHTML = '';
				return;
			}

			const current = payload.current;
			const daily = payload.daily
				.map((day) => `
					<li class="wx-day">
						<div class="wx-day-main">
							<span class="wx-day-label">${escapeHtml(day.dayLabel)}</span>
							<span class="wx-day-cond">${escapeHtml(day.emoji)} ${escapeHtml(day.condition)}</span>
						</div>
						<div class="wx-rain">${day.precipitationChance > 0 ? `💧 ${day.precipitationChance}%` : '—'}</div>
						<div class="wx-day-temp"><strong>${escapeHtml(formatTemp(day.tempMax, payload.units.temperature))}</strong><span>${escapeHtml(formatTemp(day.tempMin, payload.units.temperature))}</span></div>
					</li>
				`)
				.join('');
			const hourly = payload.hourly
				.map((hour) => `
					<li class="wx-hour">
						<span class="wx-hour-label">${escapeHtml(hour.label)}</span>
						<span class="wx-hour-icon">${escapeHtml(hour.emoji)}</span>
						<span class="wx-hour-temp">${escapeHtml(formatTemp(hour.temperature, payload.units.temperature))}</span>
					</li>
				`)
				.join('');

			this.innerHTML = `
				<section class="wx-card" data-testid="weather-display-card" style="--wx-bg: ${gradientFor(payload)}">
					<style>
						weather-display-card, .wx-card {
							display: block;
							font-family: ui-rounded, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif;
						}
						.wx-card {
							position: relative;
							overflow: hidden;
							padding: 1.15rem;
							border-radius: 28px;
							border: 1px solid rgba(255,255,255,0.24);
							background: var(--wx-bg);
							color: #fff;
							box-shadow: 0 22px 70px rgba(2, 6, 23, 0.34), inset 0 1px 0 rgba(255,255,255,0.25);
							isolation: isolate;
						}
						.wx-card::before {
							content: "";
							position: absolute;
							inset: -25% -15% auto auto;
							width: 16rem;
							height: 16rem;
							border-radius: 999px;
							background: radial-gradient(circle, rgba(255,255,255,0.48), rgba(255,255,255,0.04) 58%, transparent 70%);
							filter: blur(1px);
							z-index: -1;
						}
						.wx-card::after {
							content: "";
							position: absolute;
							inset: 0;
							background: linear-gradient(180deg, rgba(255,255,255,0.18), transparent 42%), radial-gradient(circle at 20% 10%, rgba(255,255,255,0.24), transparent 28%);
							z-index: -1;
						}
						.wx-hero { display: grid; grid-template-columns: 1fr auto; gap: 1rem; align-items: start; }
						.wx-place { font-size: clamp(1.25rem, 3vw, 1.75rem); font-weight: 700; letter-spacing: -0.03em; line-height: 1.1; text-shadow: 0 1px 12px rgba(0,0,0,0.18); }
						.wx-meta { margin-top: 0.2rem; color: rgba(255,255,255,0.76); font-size: 0.82rem; }
						.wx-temp-wrap { text-align: right; }
						.wx-temp { font-size: clamp(3.6rem, 11vw, 6.5rem); font-weight: 200; line-height: 0.88; letter-spacing: -0.08em; text-shadow: 0 4px 24px rgba(0,0,0,0.22); }
						.wx-cond { margin-top: 0.42rem; font-size: 1rem; font-weight: 600; color: rgba(255,255,255,0.92); }
						.wx-range { margin-top: 0.15rem; font-size: 0.9rem; color: rgba(255,255,255,0.78); }
						.wx-glass { margin-top: 1rem; border-radius: 22px; background: rgba(15, 23, 42, 0.22); border: 1px solid rgba(255,255,255,0.18); box-shadow: inset 0 1px 0 rgba(255,255,255,0.12); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); }
						.wx-section-title { margin: 0; padding: 0.75rem 0.85rem 0.45rem; font-size: 0.72rem; color: rgba(255,255,255,0.68); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; }
						.wx-hours { list-style: none; margin: 0; padding: 0.15rem 0.75rem 0.82rem; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(4.35rem, 1fr); gap: 0.45rem; overflow-x: auto; scrollbar-width: thin; }
						.wx-hour { display: grid; gap: 0.35rem; justify-items: center; min-width: 4.35rem; padding: 0.55rem 0.35rem; border-radius: 16px; background: rgba(255,255,255,0.10); }
						.wx-hour-label { font-size: 0.78rem; color: rgba(255,255,255,0.78); font-weight: 700; }
						.wx-hour-icon { font-size: 1.55rem; filter: drop-shadow(0 4px 10px rgba(0,0,0,0.18)); }
						.wx-hour-temp { font-weight: 700; font-variant-numeric: tabular-nums; }
						.wx-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.65rem; margin-top: 0.8rem; }
						.wx-stat { border-radius: 20px; padding: 0.78rem; background: rgba(15,23,42,0.22); border: 1px solid rgba(255,255,255,0.16); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); }
						.wx-stat-label { display: block; color: rgba(255,255,255,0.64); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 700; }
						.wx-stat-value { display: block; margin-top: 0.35rem; font-size: 1.05rem; font-weight: 700; }
						.wx-days { list-style: none; margin: 0; padding: 0 0.85rem 0.75rem; }
						.wx-day { display: grid; grid-template-columns: minmax(0, 1fr) 4rem 5.5rem; align-items: center; gap: 0.65rem; padding: 0.62rem 0; border-top: 1px solid rgba(255,255,255,0.14); }
						.wx-day:first-child { border-top: 0; }
						.wx-day-main { min-width: 0; display: grid; gap: 0.12rem; }
						.wx-day-label { font-weight: 760; }
						.wx-day-cond, .wx-rain { color: rgba(255,255,255,0.70); font-size: 0.83rem; }
						.wx-rain { text-align: center; }
						.wx-day-temp { display: flex; justify-content: flex-end; gap: 0.65rem; font-variant-numeric: tabular-nums; }
						.wx-day-temp span { color: rgba(255,255,255,0.62); }
						@media (max-width: 640px) {
							.wx-card { border-radius: 24px; padding: 1rem; }
							.wx-hero { grid-template-columns: 1fr; }
							.wx-temp-wrap { text-align: left; }
							.wx-stats { grid-template-columns: 1fr; }
							.wx-day { grid-template-columns: minmax(0, 1fr) auto; }
							.wx-rain { display: none; }
						}
					</style>
					<div class="wx-hero">
						<div>
							<div class="wx-place">${escapeHtml(formatLocation(payload))}</div>
							<div class="wx-meta">${escapeHtml(payload.location.timezone ?? 'Local time')}</div>
						</div>
						<div class="wx-temp-wrap">
							<div class="wx-temp">${escapeHtml(formatTemp(current.temperature, payload.units.temperature))}</div>
							<div class="wx-cond">${escapeHtml(current.emoji)} ${escapeHtml(current.condition)}</div>
							<div class="wx-range">Feels like ${escapeHtml(formatTemp(current.feelsLike, payload.units.temperature))}</div>
						</div>
					</div>
					<div class="wx-glass">
						<h4 class="wx-section-title">Hourly forecast</h4>
						<ul class="wx-hours">${hourly}</ul>
					</div>
					<div class="wx-stats">
						<div class="wx-stat"><span class="wx-stat-label">Feels like</span><span class="wx-stat-value">${escapeHtml(formatTemp(current.feelsLike, payload.units.temperature))}</span></div>
						<div class="wx-stat"><span class="wx-stat-label">Wind</span><span class="wx-stat-value">${escapeHtml(`${current.windSpeed.toFixed(1)} ${payload.units.windSpeed}`)}</span></div>
						<div class="wx-stat"><span class="wx-stat-label">Humidity</span><span class="wx-stat-value">${escapeHtml(`${current.humidity}%`)}</span></div>
					</div>
					<div class="wx-glass">
						<h4 class="wx-section-title">5-day forecast</h4>
						<ul class="wx-days">${daily}</ul>
					</div>
				</section>
			`;
		}
	}

	if (!customElements.get(TAG_NAME)) {
		customElements.define(TAG_NAME, WeatherDisplayCardElement);
	}
}

export function registerWeatherDisplayElement(): void {
	if (registered) return;
	if (typeof window === 'undefined' || !globalThis.customElements) return;
	defineWeatherDisplayElement();
	registered = true;
}
