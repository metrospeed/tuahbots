function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

const voiceEngine = optional("VOICE_ENGINE", "gpt-live");
if (voiceEngine !== "gpt-live" && voiceEngine !== "claude-relay") {
  throw new Error(`VOICE_ENGINE must be "gpt-live" or "claude-relay", got "${voiceEngine}"`);
}
if (voiceEngine === "gpt-live") required("OPENAI_API_KEY");

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

  voice: {
    // "gpt-live": OpenAI GPT-Live speaks on calls and hands tasks to Claude.
    // "claude-relay": Twilio ConversationRelay speech <-> Claude text.
    engine: optional("VOICE_ENGINE", "gpt-live") as "gpt-live" | "claude-relay",
    // Twilio <Say> voice for the fixed recording disclosure played before GPT-Live joins.
    disclosureVoice: optional("DISCLOSURE_VOICE", "Polly.Joanna-Neural"),
  },

  openai: {
    liveModel: optional("OPENAI_LIVE_MODEL", "gpt-live-1"),
    liveVoice: optional("OPENAI_LIVE_VOICE", "marin"),
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
    // Comma-separated ISO country codes outbound calls may reach.
    allowedCountries: optional("ALLOWED_COUNTRIES", "US,CA").split(",").map((c) => c.trim().toUpperCase()),
    maxOutboundPerUserPerDay: Number(optional("MAX_OUTBOUND_PER_USER_PER_DAY", "20")),
    // Outbound calls to third parties only happen inside this local-time window.
    contactHoursStart: Number(optional("CONTACT_HOURS_START", "8")),
    contactHoursEnd: Number(optional("CONTACT_HOURS_END", "21")),
    timezone: optional("TIMEZONE", "America/New_York"),
    maxCallMinutes: Number(optional("MAX_CALL_MINUTES", "15")),
  },
};
