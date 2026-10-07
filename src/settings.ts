import { config } from "./config.js";
import { pool, query } from "./db/index.js";

/** Settings the admin can change at runtime. Defaults come from the environment. */
export interface Settings {
  /** Master switch: when false, no calls are placed or answered by the agent. */
  callsEnabled: boolean;
  /** Played verbatim at the start of calls. Placeholders are listed in GREETING_PLACEHOLDERS. */
  greetingOutbound: string;
  greetingUserInbound: string;
  greetingCallback: string;
  /** Third parties are only called between these hours (local to `timezone`). */
  contactHoursStart: number;
  contactHoursEnd: number;
  timezone: string;
  /** Calls are wrapped up and hung up after this many minutes. */
  maxCallMinutes: number;
}

export const DEFAULT_SETTINGS: Settings = {
  callsEnabled: true,
  // No question at the end: the agent continues straight into why it's calling.
  greetingOutbound:
    "Hi {recipient}, this is {agent}, an AI assistant calling on behalf of {requester}. This call is being recorded and transcribed.",
  greetingUserInbound: "Hi {caller}, it's {agent}. Just so you know, this call is recorded and transcribed. What can I do for you?",
  greetingCallback:
    "Hi, this is {agent}, an AI assistant for {requester}, following up on our earlier call. This call is recorded and transcribed. How can I help?",
  contactHoursStart: config.agent.contactHoursStart,
  contactHoursEnd: config.agent.contactHoursEnd,
  timezone: config.agent.timezone,
  maxCallMinutes: config.agent.maxCallMinutes,
};

export const GREETING_PLACEHOLDERS = {
  greetingOutbound: ["{agent}", "{requester}", "{recipient}"],
  greetingUserInbound: ["{agent}", "{caller}"],
  greetingCallback: ["{agent}", "{requester}"],
} as const;

/** Earlier default that ended in a question; saved copies are upgraded to the new default. */
const OLD_OUTBOUND_DEFAULT =
  "Hi {recipient}, this is {agent}, an AI assistant calling on behalf of {requester}. This call is being recorded and transcribed. Is now a good time for a quick question?";

export async function getSettings(): Promise<Settings> {
  const rows = await query<{ key: string; value: unknown }>("SELECT key, value FROM settings");
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<Settings>;
  if (stored.greetingOutbound === OLD_OUTBOUND_DEFAULT) delete stored.greetingOutbound;
  const merged = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    if (stored[key] !== undefined && typeof stored[key] === typeof DEFAULT_SETTINGS[key]) (merged as any)[key] = stored[key];
  }
  return merged;
}

export async function saveSettings(changes: Partial<Settings>): Promise<void> {
  for (const [key, value] of Object.entries(changes)) {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }
}

/** Fill a greeting template. Unknown placeholders are left as typed. */
export function fillGreeting(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match).replace(/\s+/g, " ").trim();
}

/**
 * Check an admin's settings form. Greetings must still disclose recording,
 * since that disclosure is what makes recording lawful in all-party states.
 */
export function validateSettings(input: Settings): string | null {
  for (const key of ["greetingOutbound", "greetingUserInbound", "greetingCallback"] as const) {
    const text = input[key].trim();
    if (!text) return "Greetings can't be empty.";
    if (text.length > 600) return "Keep each greeting under 600 characters.";
    if (!/record/i.test(text)) return "Every greeting must say the call is recorded.";
  }
  if (!/AI|artificial|assistant/i.test(input.greetingOutbound) || !/AI|artificial|assistant/i.test(input.greetingCallback)) {
    return "Greetings to other people must say they're talking to an AI assistant.";
  }
  const { contactHoursStart: start, contactHoursEnd: end } = input;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || start >= end) {
    return "Calling hours must be whole hours with the start before the end (0–24).";
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
  } catch {
    return `"${input.timezone}" isn't a valid time zone (e.g. America/New_York).`;
  }
  if (!Number.isInteger(input.maxCallMinutes) || input.maxCallMinutes < 1 || input.maxCallMinutes > 60) {
    return "The call time limit must be between 1 and 60 minutes.";
  }
  return null;
}
