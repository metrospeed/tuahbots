function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const config = {
  port: Number(optional("PORT", "3000")),
  // Public HTTPS origin Twilio uses to reach this server, e.g. https://agent.example.com
  publicBaseUrl: required("PUBLIC_BASE_URL").replace(/\/$/, ""),
  databaseUrl: required("DATABASE_URL"),

  twilio: {
    accountSid: required("TWILIO_ACCOUNT_SID"),
    authToken: required("TWILIO_AUTH_TOKEN"),
    phoneNumber: required("TWILIO_PHONE_NUMBER"),
    // Set to "false" only for local testing behind a tunnel that rewrites URLs.
    validateSignatures: optional("TWILIO_VALIDATE_SIGNATURES", "true") !== "false",
    ttsVoice: optional("TWILIO_TTS_VOICE", ""),
  },

  anthropic: {
    model: optional("ANTHROPIC_MODEL", "claude-opus-5-5"),
  },

  admin: {
    password: required("ADMIN_PASSWORD"),
    sessionSecret: required("SESSION_SECRET"),
  },

  agent: {
    // Name the assistant introduces itself with.
    name: optional("AGENT_NAME", "Tuah"),
    defaultCountry: optional("DEFAULT_COUNTRY", "US"),
    // Comma-separated ISO country codes outbound calls/texts may reach.
    allowedCountries: optional("ALLOWED_COUNTRIES", "US,CA").split(",").map((c) => c.trim().toUpperCase()),
    maxOutboundPerUserPerDay: Number(optional("MAX_OUTBOUND_PER_USER_PER_DAY", "20")),
    // Outbound calls/texts to third parties only happen inside this local-time window.
    contactHoursStart: Number(optional("CONTACT_HOURS_START", "8")),
    contactHoursEnd: Number(optional("CONTACT_HOURS_END", "21")),
    timezone: optional("TIMEZONE", "America/New_York"),
    maxCallMinutes: Number(optional("MAX_CALL_MINUTES", "15")),
  },
};
