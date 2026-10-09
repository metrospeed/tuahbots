import express from "express";
import { complete } from "../agent/llm.js";
import {
  DEFAULT_AI_SETTINGS,
  OPENROUTER_BASE_URL,
  PROVIDERS,
  aiSettings,
  deleteApiKey,
  endpointFor,
  hasStoredKey,
  keyStatuses,
  loadAiSettings,
  redact,
  saveAiSettings,
  saveApiKey,
  validateAiSettings,
  validateApiKey,
  type AiProvider,
  type AiSettings,
} from "../agent/provider.js";
import { config } from "../config.js";
import { checkSecondFactor, loginThrottled, recordFailedLogin } from "./auth.js";
import { esc, fmtDate, layout } from "./views.js";

/**
 * Admin → AI: which provider and model run the agent, the GPT-Live voice, and
 * API keys. Keys are write-only here (only their last 4 characters are shown),
 * and changing a key or where requests go needs a current 2FA code. Mounted
 * behind requireAdmin.
 */
export const aiRouter = express.Router();

const TEST_TIMEOUT_MS = 30_000;

interface PageOptions {
  settings?: AiSettings;
  notice?: string;
  error?: string;
  test?: { ok: boolean; text: string };
}

function aiPage(opts: PageOptions = {}): string {
  const s = opts.settings ?? aiSettings();
  const statuses = keyStatuses();
  const option = (value: string, label: string, selected: string) =>
    `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`;
  const checkbox = (name: string, on: boolean, label: string) =>
    `<label class="check"><input type="checkbox" name="${name}" value="1"${on ? " checked" : ""}> ${esc(label)}</label>`;

  const keyRows = PROVIDERS.map(({ id, label, env }) => {
    const st = statuses.find((k) => k.provider === id)!;
    const where = endpointFor(id, s);
    const state =
      st.source === "saved"
        ? `<span class="ok">Saved</span> (ends in <code>${esc(st.hint || "…")}</code>${st.savedAt ? `, ${esc(fmtDate(new Date(st.savedAt)))}` : ""})`
        : st.source === "env"
          ? `<span class="ok">From the server's <code>${esc(env)}</code></span>${st.hint ? ` (ends in <code>${esc(st.hint)}</code>)` : ""}`
          : `<span class="${id === s.provider && id !== "custom" ? "bad" : "muted"}">Not set</span>`;
    return `<fieldset><legend>${esc(label)}</legend>
      <p class="small">${state}${st.unusable ? `<br><span class="bad">${esc(st.unusable)}</span>` : ""}</p>
      <p class="small muted">Sent only to <code>${esc(where || "(no endpoint set)")}</code>.${id === "openai" ? " Also used for GPT-Live voice." : ""}${id === "custom" ? ` Leave empty if your server doesn't need a key.` : ""}</p>
      <div class="row">
        <label>New key<input type="password" name="key_${id}" autocomplete="new-password" spellcheck="false" maxlength="512" size="40" placeholder="${st.source === "none" ? "Paste API key" : "Leave empty to keep the current key"}"></label>
        ${hasStoredKey(id) ? checkbox(`remove_${id}`, false, `Remove the saved key${config.ai.keys[id] ? ` (falls back to ${env})` : ""}`) : ""}
      </div></fieldset>`;
  }).join("");

  return layout(
    "AI",
    `${opts.notice ? `<div class="card ok">${esc(opts.notice)}</div>` : ""}${opts.error ? `<div class="card bad" role="alert">Not saved. ${esc(opts.error)}</div>` : ""}
     ${opts.test ? `<div class="card ${opts.test.ok ? "ok" : "bad"}" role="status">${esc(opts.test.text)}</div>` : ""}
     <form method="post" action="/admin/ai" autocomplete="off">
      <div class="card"><h3>Agent model</h3>
       <p class="small muted">Runs the web chat, the work delegated during calls, call summaries and the "is this call over?" check. Changes apply to the next chat reply or call.</p>
       <div class="row">
        <label>Provider<select name="provider">${PROVIDERS.map((p) => option(p.id, p.label, s.provider)).join("")}</select></label>
        <label>Model<input name="model" value="${esc(s.model)}" required maxlength="200" size="32" spellcheck="false"></label>
       </div>
       <p class="small muted">Model ids: on OpenAI e.g. <code>gpt-6-luna</code>; on OpenRouter <code>provider/model</code>, e.g. <code>openai/gpt-6-luna</code> or <code>anthropic/claude-sonnet-5.5</code>.
       The model needs tool (function) calling, and image and PDF input for uploaded files. Default: <code>${esc(DEFAULT_AI_SETTINGS.model)}</code>.</p>
       <fieldset><legend>Custom OpenAI-compatible endpoint</legend>
        <div class="row">
         <label>Base URL<input name="baseUrl" type="url" value="${esc(s.baseUrl)}" maxlength="300" size="40" placeholder="https://llm.example.com/v1" spellcheck="false"></label>
         <label>API format<select name="apiFormat">${option("chat", "Chat Completions (/chat/completions)", s.apiFormat)}${option("responses", "Responses (/responses)", s.apiFormat)}</select></label>
        </div>
        <p class="small muted">Only used when the provider is "Custom". Works with servers such as vLLM, LM Studio, Ollama, LiteLLM, Together or Groq. Must be <code>https://</code>; plain <code>http://</code> is allowed only for this server or a private network.
        OpenAI always uses the Responses API and OpenRouter (<code>${esc(OPENROUTER_BASE_URL)}</code>) Chat Completions.</p>
       </fieldset>
       ${checkbox("reasoning", s.reasoning, "Send a reasoning effort with each request (turn off if the model or server rejects it)")}<br>
       ${checkbox("openrouterNoDataCollection", s.openrouterNoDataCollection, "OpenRouter: only use providers that don't store or train on prompts (data_collection: deny)")}
      </div>
      <div class="card"><h3>Voice (GPT-Live)</h3>
       <p class="small muted">${config.voice.engine === "gpt-live" ? "Talks on every call. Always runs on OpenAI, with the OpenAI key below." : "Not in use: VOICE_ENGINE is relay, so the agent model speaks on calls."}</p>
       <div class="row">
        <label>Model<input name="liveModel" value="${esc(s.liveModel)}" required maxlength="200" spellcheck="false"></label>
        <label>Voice<input name="liveVoice" value="${esc(s.liveVoice)}" required maxlength="40" spellcheck="false"></label>
       </div>
       <p class="small muted">Voices include marin, cedar, alloy, coral, sage and verse. Applies to the next call.</p>
      </div>
      <div class="card"><h3>API keys</h3>
       <p class="small muted">Keys are encrypted before they're stored and never shown again; only the last 4 characters are displayed.
       A saved key is tied to its endpoint and won't be sent anywhere else. A saved key takes priority over one set on the server.</p>
       ${keyRows}
      </div>
      <div class="card">
       <div class="row">
        <label>Authenticator code<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="20" size="10"></label>
        <button class="primary">Save AI settings</button>
       </div>
       <p class="small muted">A current code is needed to change the provider, the endpoint URL, or any key.</p>
      </div>
     </form>
     <form method="post" action="/admin/ai/test" class="card">
      <h3>Test the connection</h3>
      <div class="row"><button>Send a test request</button>
      <span class="small muted">Sends a one-line request to ${esc(PROVIDERS.find((p) => p.id === aiSettings().provider)!.label)} with the saved settings.</span></div>
     </form>`,
    "/admin/ai",
  );
}

function noStore(res: express.Response): void {
  res.setHeader("Cache-Control", "no-store");
}

aiRouter.get("/admin/ai", async (req, res) => {
  await loadAiSettings();
  noStore(res);
  res.send(aiPage({ notice: req.query.saved !== undefined ? "AI settings saved." : "" }));
});

aiRouter.post("/admin/ai", async (req, res) => {
  await loadAiSettings();
  noStore(res);
  const current = aiSettings();
  const field = (name: string) => (typeof req.body[name] === "string" ? req.body[name].trim() : "");
  const next: AiSettings = {
    provider: field("provider") as AiProvider,
    model: field("model"),
    baseUrl: field("baseUrl").replace(/\/+$/, ""),
    apiFormat: field("apiFormat") as AiSettings["apiFormat"],
    reasoning: req.body.reasoning === "1",
    openrouterNoDataCollection: req.body.openrouterNoDataCollection === "1",
    liveModel: field("liveModel"),
    liveVoice: field("liveVoice"),
  };
  const fail = (error: string) => res.status(400).send(aiPage({ settings: next, error }));

  const problem = validateAiSettings(next);
  if (problem) return void fail(problem);

  const newKeys = new Map<AiProvider, string>();
  const removals: AiProvider[] = [];
  for (const { id, label } of PROVIDERS) {
    const key = field(`key_${id}`);
    if (key) {
      const keyProblem = validateApiKey(key);
      if (keyProblem) return void fail(`${label}: ${keyProblem}`);
      newKeys.set(id, key);
    } else if (req.body[`remove_${id}`] === "1" && hasStoredKey(id)) {
      removals.push(id);
    }
  }

  // A saved key belongs to the endpoint it was saved for. Moving the endpoint
  // needs the new endpoint's key (or an explicit removal), so a typo'd or
  // hostile URL can't quietly receive the old one.
  const endpointMoved = endpointFor("custom", next) !== endpointFor("custom", current);
  if (endpointMoved && hasStoredKey("custom") && !newKeys.has("custom") && !removals.includes("custom")) {
    return void fail("The custom endpoint URL changed. Enter the API key for the new endpoint, or tick \"Remove the saved key\" if it doesn't need one.");
  }
  if (newKeys.has("custom") && !next.baseUrl) return void fail("Set the custom endpoint URL before saving a key for it.");

  const sensitive = next.provider !== current.provider || endpointMoved || newKeys.size > 0 || removals.length > 0;
  if (sensitive) {
    const ip = req.ip ?? "unknown";
    if (loginThrottled(`code:${ip}`)) return void fail("Too many wrong codes. Try again in 15 minutes.");
    if (!(await checkSecondFactor(field("code")))) {
      recordFailedLogin(`code:${ip}`);
      return void fail("Enter a current authenticator code to change the provider, endpoint or keys.");
    }
  }

  await saveAiSettings(next);
  for (const provider of removals) await deleteApiKey(provider);
  for (const [provider, key] of newKeys) await saveApiKey(provider, key, next);
  // An audit line, never with key material.
  const changedKeys = [...newKeys.keys(), ...removals.map((p) => `${p} (removed)`)];
  console.log(
    `Admin updated AI settings: provider=${next.provider} model=${next.model}${next.provider === "custom" ? ` endpoint=${next.baseUrl}` : ""}` +
      `${changedKeys.length ? ` keys changed: ${changedKeys.join(", ")}` : ""}`,
  );
  res.redirect("/admin/ai?saved=1");
});

aiRouter.post("/admin/ai/test", async (_req, res) => {
  await loadAiSettings();
  noStore(res);
  const s = aiSettings();
  const label = PROVIDERS.find((p) => p.id === s.provider)!.label;
  const started = Date.now();
  let test: { ok: boolean; text: string };
  try {
    const reply = await complete("You are a connection test. Reply with the single word OK.", "Connection test: reply OK.", {
      maxTokens: 1000,
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    const shown = reply.replace(/\s+/g, " ").slice(0, 120);
    test = { ok: true, text: `Connected to ${label} (${s.model}) in ${Date.now() - started} ms. Reply: "${shown || "(empty)"}"` };
  } catch (err) {
    const message = redact(String((err as Error)?.message ?? err)).slice(0, 400);
    test = { ok: false, text: `The test request to ${label} (${s.model}) failed: ${message}` };
  }
  res.send(aiPage({ test }));
});
