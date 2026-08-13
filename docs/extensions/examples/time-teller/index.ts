#!/usr/bin/env bun

import {
  createToolDispatcher,
  getChannel,
  toolError,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

export interface TimeClockPayload {
  _assistant_note: string;
  cardType: "time-clock";
  label: string;
  formatted: string;
  timezone: string;
  locale: string;
  iso: string;
  hour12?: boolean;
  currentTimeText: string;
}

interface TellTimeInput {
  timezone?: unknown;
  locale?: unknown;
  hour12?: unknown;
}

const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_LOCALE = "en-US";

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function isValidLocale(locale: string): boolean {
  try {
    new Intl.DateTimeFormat(locale).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Build the card payload from an instant. Exported for deterministic tests. */
export function buildTimeClockPayload(
  date: Date,
  options: { timezone?: string; locale?: string; hour12?: boolean } = {},
): TimeClockPayload {
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date");

  const timezone = options.timezone?.trim() || DEFAULT_TIMEZONE;
  const locale = options.locale?.trim() || DEFAULT_LOCALE;
  if (!isValidTimezone(timezone)) throw new Error(`Invalid IANA timezone: '${timezone}'`);
  if (!isValidLocale(locale)) throw new Error(`Invalid locale: '${locale}'`);

  const formatOptions: Intl.DateTimeFormatOptions = {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: timezone,
  };
  if (options.hour12 !== undefined) formatOptions.hour12 = options.hour12;

  const formatted = new Intl.DateTimeFormat(locale, formatOptions).format(date);
  const label = timezone === "UTC" ? "Current time · UTC" : `Current time · ${timezone}`;

  return {
    _assistant_note:
      `A live wall clock for ${timezone} is rendered inline and updates every second. ` +
      "Reply with at most one short sentence; do not call this tool again to refresh it.",
    cardType: "time-clock",
    label,
    formatted,
    timezone,
    locale,
    iso: date.toISOString(),
    ...(options.hour12 === undefined ? {} : { hour12: options.hour12 }),
    currentTimeText: `Current time: ${formatted}`,
  };
}

const tellTime: ToolHandler = async (args) => {
  const { timezone, locale, hour12 } = args as TellTimeInput;

  if (timezone !== undefined && (typeof timezone !== "string" || timezone.trim() === "")) {
    return toolError("'timezone' must be a non-empty IANA timezone string when provided");
  }
  if (locale !== undefined && (typeof locale !== "string" || locale.trim() === "")) {
    return toolError("'locale' must be a non-empty BCP 47 locale string when provided");
  }
  if (hour12 !== undefined && typeof hour12 !== "boolean") {
    return toolError("'hour12' must be a boolean when provided");
  }

  const normalizedTimezone = typeof timezone === "string" ? timezone.trim() : DEFAULT_TIMEZONE;
  const normalizedLocale = typeof locale === "string" ? locale.trim() : DEFAULT_LOCALE;

  if (!isValidTimezone(normalizedTimezone)) {
    return toolError(
      `Unknown timezone '${normalizedTimezone}'. Use an IANA timezone such as 'UTC', 'America/New_York', or 'Asia/Tokyo'.`,
    );
  }
  if (!isValidLocale(normalizedLocale)) {
    return toolError(
      `Invalid locale '${normalizedLocale}'. Use a BCP 47 locale such as 'en-US', 'en-GB', or 'ja-JP'.`,
    );
  }

  const payload = buildTimeClockPayload(new Date(), {
    timezone: normalizedTimezone,
    locale: normalizedLocale,
    ...(typeof hour12 === "boolean" ? { hour12 } : {}),
  });
  return toolResult(JSON.stringify(payload));
};

export const tools: Record<string, ToolHandler> = {
  "tell-time": tellTime,
};

export function start(): void {
  const channel = getChannel();
  createToolDispatcher(tools);
  channel.start();
}

if (import.meta.main) start();
