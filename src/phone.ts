import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { config } from "./config.js";

/** Normalize user-entered phone numbers to E.164, or return null if invalid. */
export function toE164(input: string): string | null {
  const parsed = parsePhoneNumberFromString(input.trim(), config.agent.defaultCountry as CountryCode);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

export function countryOf(e164: string): string | undefined {
  return parsePhoneNumberFromString(e164)?.country;
}

export function formatPhone(e164: string): string {
  return parsePhoneNumberFromString(e164)?.formatNational() ?? e164;
}
