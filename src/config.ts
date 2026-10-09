function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

// "claude-relay" is the old name for "relay".
const voiceEngine = optional("VOICE_ENGINE", "gpt-live").replace(/^claude-relay$/, "relay");
if (voiceEngine !== "gpt-live" && voiceEngine !== "relay") {
  throw new Error(`VOICE_ENGINE must be "gpt-live" or "relay", got "${voiceEngine}"`);
}
const aiProvider = optional("AI_PROVIDER", "openai");
if (!["openai", "openrouter", "custom"].includes(aiProvider)) {
  throw new Error(`AI_PROVIDER must be "openai", "openrouter" or "custom", got "${aiProvider}"`);
}
const aiApiFormat = optional("AI_API_FORMAT", "chat");
if (aiApiFormat !== "chat" && aiApiFormat !== "responses") {
  throw new Error(`AI_API_FORMAT must be "chat" or "responses", got "${aiApiFormat}"`);
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
    // Only changed in tests, to point recording downloads/deletes at a fake.
    apiBaseUrl: optional("TWILIO_API_BASE_URL", "https://api.twilio.com").replace(/\/$/, ""),
  },

  voice: {
    // "gpt-live": OpenAI GPT-Live speaks on calls and hands tasks to the agent model.
    // "relay": Twilio ConversationRelay speech <-> agent model text.
    engine: voiceEngine as "gpt-live" | "relay",
    // Twilio <Say> voice for the fixed recording disclosure played before GPT-Live joins.
    disclosureVoice: optional("DISCLOSURE_VOICE", "Polly.Joanna-Neural"),
  },

  openai: {
    // Only changed in tests (and for proxies): where OpenAI API and GPT-Live requests go.
    baseUrl: optional("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, ""),
    liveModel: optional("OPENAI_LIVE_MODEL", "gpt-live-1"),
    liveVoice: optional("OPENAI_LIVE_VOICE", "marin"),
  },


  admin: {
    password: required("ADMIN_PASSWORD"),
    sessionSecret: required("SESSION_SECRET"),
  },

  // Defaults for the agent model's provider; the admin panel (AI) can change
  // them. API keys come from these variables or are saved, encrypted, in the
  // admin panel; they are never shown again or sent anywhere but their endpoint.
  ai: {
    provider: aiProvider as "openai" | "openrouter" | "custom",
    // Custom OpenAI-compatible endpoint, e.g. https://llm.example.com/v1
    baseUrl: optional("AI_BASE_URL", "").replace(/\/$/, ""),
    apiFormat: aiApiFormat as "chat" | "responses",
    keys: {
      openai: process.env.OPENAI_API_KEY ?? "",
      openrouter: process.env.OPENROUTER_API_KEY ?? "",
      // Only sent to AI_BASE_URL.
      custom: process.env.AI_API_KEY ?? "",
    },
  },

  agent: {
    // Model behind the chat agent, call agents and call summaries.
    model: optional("AGENT_MODEL", "gpt-6-luna"),
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
