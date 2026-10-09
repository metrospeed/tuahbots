import { isIP } from "node:net";
import OpenAI from "openai";
import { config } from "../config.js";
import { openSecret, redactSecrets, sealSecret, secretHint } from "../secrets.js";
import { deleteSettingValues, readSettingValues, saveSettingValues } from "../settings.js";

/**
 * Which AI service runs the agent model (web chat, call agents, summaries),
 * and the keys for it. GPT-Live voice always runs on OpenAI.
 *
 * API keys are handled like this:
 * - They come from the environment (OPENAI_API_KEY, OPENROUTER_API_KEY,
 *   AI_API_KEY) or are saved by the admin, encrypted (AES-256-GCM), in the
 *   settings table. A saved key wins over the environment.
 * - A saved key is bound to the endpoint it was saved for: it won't decrypt
 *   for any other URL, so changing an endpoint can't send it somewhere new.
 * - Keys are write-only in the admin panel: only the last 4 characters are
 *   ever shown, and changing one (or where it goes) needs a fresh 2FA code.
 * - Keys are never logged; errors shown to the admin are redacted.
 */
export type AiProvider = "openai" | "openrouter" | "custom";
export type ApiFormat = "responses" | "chat";

export const PROVIDERS: Array<{ id: AiProvider; label: string; env: string }> = [
  { id: "openai", label: "OpenAI", env: "OPENAI_API_KEY" },
  { id: "openrouter", label: "OpenRouter", env: "OPENROUTER_API_KEY" },
  { id: "custom", label: "Custom OpenAI-compatible endpoint", env: "AI_API_KEY" },
];

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface AiSettings {
  provider: AiProvider;
  /** Model id at the provider, e.g. gpt-6-luna, or anthropic/claude-sonnet-5.5 on OpenRouter. */
  model: string;
  /** Custom provider only: the endpoint's base URL (…/v1). */
  baseUrl: string;
  /** Custom provider only. OpenAI always uses the Responses API, OpenRouter Chat Completions. */
  apiFormat: ApiFormat;
  /** Send a reasoning effort with requests. Turn off for models or servers that reject it. */
  reasoning: boolean;
  /** OpenRouter only: route only to providers that don't store or train on prompts. */
  openrouterNoDataCollection: boolean;
  /** GPT-Live voice model and voice (OpenAI). */
  liveModel: string;
  liveVoice: string;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: config.ai.provider,
  model: config.agent.model,
  baseUrl: config.ai.baseUrl,
  apiFormat: config.ai.apiFormat,
  reasoning: true,
  openrouterNoDataCollection: true,
  liveModel: config.openai.liveModel,
  liveVoice: config.openai.liveVoice,
};

const SETTINGS_KEY = "ai.settings";
const keyRow = (provider: AiProvider) => `ai.key.${provider}`;
const KEY_PURPOSE = "ai-api-key";

interface StoredKey {
  /** Sealed with the provider and endpoint as context. */
  sealed: string;
  endpoint: string;
  savedAt: string;
}

/** The endpoint a provider's requests (and key) go to, or "" if none is set. */
export function endpointFor(provider: AiProvider, settings: AiSettings = current): string {
  if (provider === "openai") return config.openai.baseUrl;
  if (provider === "openrouter") return OPENROUTER_BASE_URL;
  return settings.baseUrl;
}

const keyContext = (provider: AiProvider, endpoint: string) => `${provider}|${endpoint}`;

// ---- Loaded state ----------------------------------------------------------

let current: AiSettings = { ...DEFAULT_AI_SETTINGS };
let storedKeys: Partial<Record<AiProvider, StoredKey>> = {};
let clients = new Map<string, OpenAI>();

export function aiSettings(): AiSettings {
  return current;
}

/** Re-read AI settings and saved keys. Called at startup, before chats and calls, and after admin edits. */
export async function loadAiSettings(): Promise<void> {
  const rows = await readSettingValues("ai.");
  current = mergeSettings(rows[SETTINGS_KEY]);
  storedKeys = {};
  for (const { id } of PROVIDERS) {
    const row = rows[keyRow(id)] as StoredKey | undefined;
    if (row && typeof row.sealed === "string") storedKeys[id] = row;
  }
  clients = new Map();
}

function mergeSettings(stored: unknown): AiSettings {
  const merged = { ...DEFAULT_AI_SETTINGS };
  if (stored && typeof stored === "object") {
    for (const key of Object.keys(DEFAULT_AI_SETTINGS) as Array<keyof AiSettings>) {
      const value = (stored as Record<string, unknown>)[key];
      if (value !== undefined && typeof value === typeof DEFAULT_AI_SETTINGS[key]) (merged as any)[key] = value;
    }
  }
  return merged;
}

// ---- Keys --------------------------------------------------------------------

export type KeySource = "saved" | "env" | "none";

/** The key to send to `provider`'s current endpoint, and where it came from. */
function resolveKey(provider: AiProvider, settings: AiSettings = current): { key: string; source: KeySource } {
  const endpoint = endpointFor(provider, settings);
  const stored = storedKeys[provider];
  if (stored && endpoint && stored.endpoint === endpoint) {
    const key = openSecret(stored.sealed, KEY_PURPOSE, keyContext(provider, endpoint));
    if (key) return { key, source: "saved" };
  }
  const env = config.ai.keys[provider];
  // A custom endpoint's environment key only goes to the endpoint set beside it.
  if (env && (provider !== "custom" || (endpoint && endpoint === config.ai.baseUrl))) return { key: env, source: "env" };
  return { key: "", source: "none" };
}

export interface KeyStatus {
  provider: AiProvider;
  source: KeySource;
  /** Last 4 characters, if the key is long enough to show them safely. */
  hint: string;
  savedAt?: string;
  /** A saved key exists but is for another endpoint, or can't be decrypted (SESSION_SECRET changed). */
  unusable?: string;
}

/** What the admin panel may show about each key. Never the key itself. */
export function keyStatuses(): KeyStatus[] {
  return PROVIDERS.map(({ id }) => {
    const { key, source } = resolveKey(id);
    const stored = storedKeys[id];
    let unusable: string | undefined;
    if (stored && source !== "saved") {
      unusable =
        stored.endpoint !== endpointFor(id)
          ? `A saved key is for ${stored.endpoint}, not the current endpoint, so it isn't used.`
          : "A saved key can't be decrypted (SESSION_SECRET changed?). Enter it again.";
    }
    return { provider: id, source, hint: source === "none" ? "" : secretHint(key), savedAt: source === "saved" ? stored?.savedAt : undefined, unusable };
  });
}

export function hasStoredKey(provider: AiProvider): boolean {
  return !!storedKeys[provider];
}

/** Every key currently in use, so error text can be scrubbed of them. */
function knownKeys(): string[] {
  return PROVIDERS.map(({ id }) => resolveKey(id).key).filter(Boolean);
}

export function redact(text: string): string {
  return redactSecrets(text, knownKeys());
}

// ---- Clients -----------------------------------------------------------------

export class MissingApiKeyError extends Error {}

function client(provider: AiProvider, settings: AiSettings = current): OpenAI {
  const endpoint = endpointFor(provider, settings);
  if (!endpoint) throw new MissingApiKeyError("No endpoint URL is set for the custom AI provider. Set one in the admin panel (AI).");
  const { key } = resolveKey(provider, settings);
  if (!key && provider !== "custom") {
    const env = PROVIDERS.find((p) => p.id === provider)!.env;
    throw new MissingApiKeyError(`No ${provider === "openai" ? "OpenAI" : "OpenRouter"} API key. Add one in the admin panel (AI) or set ${env}.`);
  }
  const cacheKey = `${provider}|${endpoint}|${key}`;
  let c = clients.get(cacheKey);
  if (!c) {
    // Local servers often need no key; the SDK still wants one, so send a placeholder.
    // OPENAI_ORG_ID / OPENAI_PROJECT_ID from the environment are only for OpenAI itself.
    const scope = provider === "openai" ? {} : { organization: null, project: null };
    c = new OpenAI({ apiKey: key || "no-key", baseURL: endpoint, ...scope });
    clients.set(cacheKey, c);
  }
  return c;
}

/** How the agent model is reached right now. */
export interface AgentEndpoint {
  client: OpenAI;
  provider: AiProvider;
  model: string;
  format: ApiFormat;
  reasoning: boolean;
  /** Extra request fields for this provider (e.g. OpenRouter routing preferences). */
  extraBody: Record<string, unknown>;
}

export function agentEndpoint(settings: AiSettings = current): AgentEndpoint {
  const provider = settings.provider;
  const format: ApiFormat = provider === "openai" ? "responses" : provider === "openrouter" ? "chat" : settings.apiFormat;
  const extraBody: Record<string, unknown> = {};
  if (provider === "openrouter" && settings.openrouterNoDataCollection) extraBody.provider = { data_collection: "deny" };
  return { client: client(provider, settings), provider, model: settings.model, format, reasoning: settings.reasoning, extraBody };
}

/** OpenAI client for GPT-Live voice. */
export function liveClient(): OpenAI {
  return client("openai");
}

// ---- Admin changes ---------------------------------------------------------

const MODEL_PATTERN = /^[A-Za-z0-9][\w.:/@+-]{0,199}$/;

/** Problems with an admin's AI settings form, or null. */
export function validateAiSettings(input: AiSettings): string | null {
  if (!PROVIDERS.some((p) => p.id === input.provider)) return "Pick a provider.";
  if (!MODEL_PATTERN.test(input.model)) return "Enter a model id (letters, digits and . _ - : / @ +), e.g. gpt-6-luna or anthropic/claude-sonnet-5.5.";
  if (input.apiFormat !== "chat" && input.apiFormat !== "responses") return "Pick an API format.";
  if (input.baseUrl) {
    const problem = checkEndpointUrl(input.baseUrl);
    if (problem) return problem;
  }
  if (input.provider === "custom" && !input.baseUrl) return "A custom provider needs its endpoint URL, e.g. https://llm.example.com/v1.";
  if (!MODEL_PATTERN.test(input.liveModel)) return "Enter a GPT-Live model id, e.g. gpt-live-1.";
  if (!/^[\w-]{1,40}$/.test(input.liveVoice)) return "Enter a GPT-Live voice name, e.g. marin.";
  return null;
}

/**
 * Endpoint URLs must use HTTPS, so keys and transcripts aren't sent in the
 * clear. Plain HTTP is allowed only to this machine or a private network
 * (e.g. a model server in the same Docker network). Cloud metadata addresses
 * and URLs carrying credentials are refused.
 */
export function checkEndpointUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "The endpoint URL isn't valid. Use a full URL like https://llm.example.com/v1.";
  }
  if (raw.length > 300) return "The endpoint URL is too long.";
  if (url.username || url.password) return "Don't put credentials in the endpoint URL. Enter the API key in its own field.";
  if (url.search || url.hash) return "The endpoint URL can't have a query string or #fragment.";
  if (url.protocol !== "https:" && url.protocol !== "http:") return "The endpoint URL must start with https://.";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isMetadataHost(host)) return "That address is not allowed.";
  if (url.protocol === "http:" && !isLocalHost(host)) {
    return "Use https:// for endpoints on the internet. Plain http:// is only allowed for this server or a private network.";
  }
  return null;
}

function isMetadataHost(host: string): boolean {
  if (host === "metadata.google.internal" || host === "metadata") return true;
  if (isIP(host) === 4) return host.startsWith("169.254.") || host === "100.100.100.200";
  if (isIP(host) === 6) return /^fe[89ab]/.test(host) || host === "fd00:ec2::254";
  return false;
}

function isLocalHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  // Single-label names: Docker Compose services and the like.
  if (!host.includes(".") && isIP(host) === 0) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(host) === 6) return host === "::1" || /^f[cd]/.test(host);
  return false;
}

/** API keys: printable ASCII with no spaces, of a sensible length. */
export function validateApiKey(key: string): string | null {
  if (key.length < 8 || key.length > 512) return "That API key doesn't look right (8 to 512 characters).";
  if (!/^[\x21-\x7e]+$/.test(key)) return "API keys can't contain spaces or special characters.";
  return null;
}

export async function saveAiSettings(settings: AiSettings): Promise<void> {
  await saveSettingValues({ [SETTINGS_KEY]: settings });
  await loadAiSettings();
}

/** Encrypt and save a key, bound to the provider's endpoint under `settings`. */
export async function saveApiKey(provider: AiProvider, key: string, settings: AiSettings = current): Promise<void> {
  const endpoint = endpointFor(provider, settings);
  if (!endpoint) throw new Error("No endpoint for this provider");
  const stored: StoredKey = {
    sealed: sealSecret(key, KEY_PURPOSE, keyContext(provider, endpoint)),
    endpoint,
    savedAt: new Date().toISOString(),
  };
  await saveSettingValues({ [keyRow(provider)]: stored });
  await loadAiSettings();
}

export async function deleteApiKey(provider: AiProvider): Promise<void> {
  await deleteSettingValues([keyRow(provider)]);
  await loadAiSettings();
}
