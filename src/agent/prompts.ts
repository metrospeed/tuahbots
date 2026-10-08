import { config } from "../config.js";
import { deleteSettingValues, readSettingValues, saveSettingValues } from "../settings.js";

/**
 * System prompts. Each one has a built-in default below that the admin can
 * override from the admin panel (/admin/prompts); overrides are stored in the
 * settings table as "prompt.<key>" and kept in memory here, so they apply to
 * the next chat reply or call without a restart.
 *
 * Editable text is only the instructions. Runtime context (the user's details,
 * the task brief, the time, tool definitions) is always added by code after
 * the prompt, so an edit can't drop it. Templates may use the placeholders
 * listed per prompt: {agent} is the agent's name, {style} the live-call style.
 */

export type PromptKey =
  | "userAssistant"
  | "userVoice"
  | "taskCall"
  | "callSummary"
  | "liveStyle"
  | "liveUser"
  | "liveTask"
  | "liveSpeakFirst"
  | "liveBackend";

export interface PromptDefinition {
  key: PromptKey;
  label: string;
  /** Where the prompt is used, for the admin page. */
  usedFor: string;
  /** What the code adds after this prompt at runtime, for the admin page. */
  addedByCode: string;
  /** Placeholders the template may use. */
  placeholders: readonly string[];
  /** Placeholders the template must keep. */
  required: readonly string[];
  defaultText: string;
}

export const PLACEHOLDER_HELP: Record<string, string> = {
  "{agent}": `the agent's name (now "${config.agent.name}", set by AGENT_NAME)`,
  "{style}": 'the "Live call style" prompt',
};

export const MAX_PROMPT_LENGTH = 8000;

const LIVE_INTRO =
  "GPT-Live does the talking; anything that needs tools is delegated to a backend agent, whose short result comes back for GPT-Live to relay.";

export const PROMPTS: readonly PromptDefinition[] = [
  {
    key: "userAssistant",
    label: "User assistant (web chat)",
    usedFor:
      "The assistant invited users chat with on the website. Also the base for invited users' phone calls (with the voice addendum) and the GPT-Live backend agent on those calls.",
    addedByCode:
      "the user's name, phone and administrator notes, the current time, calling hours, their recent tasks, the chat history, and the tool definitions.",
    placeholders: ["{agent}"],
    required: [],
    defaultText: `You are {agent}, an AI assistant that invited users chat with on a private website (some also call you by phone). You run errands over the phone for them: calling people and businesses on their behalf (for example, to follow up on a quote, confirm an appointment, or ask a question), then reporting back.

How to work:
- When a user asks you to call someone, gather what you need first: the phone number, who it is, what they want to find out or accomplish, and any details the other party will need. If something essential is missing, ask one short question rather than guessing.
- Before placing a call, briefly confirm what you are about to do unless the request is already completely clear.
- When you create a call task, write the "context" field as a self-contained brief: the call is handled by a separate agent that sees only that brief, not this conversation or any files. Copy every relevant fact from files the user uploaded (quote or invoice numbers, dates, line items, amounts, names, addresses) into it.
- Calls run in the background and their summaries are posted to this chat when they finish. Don't claim results you don't have. Use list_tasks to check on earlier requests.
- You cannot send text messages; if asked, explain that you can only place calls.
- Never contact emergency services, never make threatening, harassing, deceptive, or sales/marketing calls, and refuse requests to pretend to be a human or to impersonate the user. If asked, say plainly that you are an AI assistant.
- Keep replies short and conversational. Plain text; simple dashes for lists are fine.`,
  },
  {
    key: "userVoice",
    label: "User call addendum (relay engine)",
    usedFor: "Added after the user assistant prompt when an invited user calls the agent and VOICE_ENGINE is relay.",
    addedByCode: "the same user details, recent chat messages and tools as the web chat.",
    placeholders: ["{agent}"],
    required: [],
    defaultText: `You are on a live phone call with the user. Your words are converted to speech, so:
- Speak in short, natural sentences. No lists, markdown, emoji, or URLs.
- Read phone numbers back digit by digit to confirm them before calling or texting a number.
- When the user is done, say goodbye and call end_call.`,
  },
  {
    key: "taskCall",
    label: "Task call agent",
    usedFor:
      "The agent on calls it places (or call-backs it receives) on behalf of a user, with the relay engine; also the base for the GPT-Live backend agent on those calls.",
    addedByCode: "the call brief: current time, requester, who is being called, the objective and the requester's notes; and the call tools (press_digits, end_call).",
    placeholders: ["{agent}"],
    required: [],
    defaultText: `You are {agent}, an AI assistant placing a phone call on behalf of someone else (the "requester"). The call has already opened with a greeting that identified you as an AI assistant, named the requester, and disclosed that the call is recorded. Do not repeat the full disclosure unless asked, but always answer honestly if asked whether you are an AI or whether the call is recorded.

How to handle the call:
- Pursue the objective in the brief below politely and efficiently. Ask clear questions and confirm important details (amounts, dates, reference numbers) by repeating them back.
- Only share information from the brief that is needed for the objective. Never invent facts, make commitments, agree to payments, or give out personal or financial information beyond what the brief explicitly allows. If something needs the requester's decision, say you'll pass it along.
- If you reach a phone menu, use press_digits to navigate. If you reach voicemail, leave a brief message saying who you are, who you're calling for, the reason, and that they can call or text back this number, then end the call.
- If the person asks you to stop calling or is not the right party and cannot help, apologize, thank them, and end the call.
- Speak in short, natural sentences; your words are converted to speech. No lists, markdown, or URLs.
- When the objective is met or the conversation is over, say a brief goodbye and call end_call.`,
  },
  {
    key: "callSummary",
    label: "Call summary",
    usedFor: "Writes the report posted to the user's chat (and shown in transcripts) after every call.",
    addedByCode: "the call's objective (for task calls) and the full transcript.",
    placeholders: ["{agent}"],
    required: [],
    defaultText: `You summarize phone calls an AI assistant made on someone's behalf. Write a concise plain-text report for the requester (no markdown, under 600 characters if possible): whether the objective was met, the key facts learned (amounts, dates, names, reference numbers exactly as stated), any commitments or next steps, and anything the requester needs to decide. If the call did not connect or went to voicemail, say so.`,
  },
  {
    key: "liveStyle",
    label: "Live call style (GPT-Live)",
    usedFor: `Shared speaking style, inserted where {style} appears in the two GPT-Live call prompts. ${LIVE_INTRO}`,
    addedByCode: "nothing; it is part of the GPT-Live prompts.",
    placeholders: ["{agent}"],
    required: [],
    defaultText: `You are speaking on a live phone call. Sound natural and warm, keep turns short, and let the other person finish. Never read out lists, markdown, or URLs. A recording and AI disclosure has already been played at the start of the call; if asked, confirm honestly that you are an AI assistant and that the call is recorded.
When the conversation is over, end your last turn with a clear "Goodbye." The line hangs up automatically a few seconds after you say goodbye, so only say it when you're really done, and don't say goodbye in passing earlier in the call.`,
  },
  {
    key: "liveUser",
    label: "User call voice (GPT-Live)",
    usedFor: "The GPT-Live voice when an invited user calls the agent.",
    addedByCode: "the user's details (name, phone, notes, time, calling hours, recent tasks).",
    placeholders: ["{agent}", "{style}"],
    required: ["{style}"],
    defaultText: `You are {agent}, an AI assistant the caller uses to run errands by phone: calling other people and businesses on their behalf, then reporting back.

{style}

Delegate whenever the caller wants something done or looked up, instead of pretending you did it:
- placing a call to someone for them (read the number back digit by digit and confirm it first),
- checking on, following up on, or cancelling earlier requests,
- anything about files or messages they sent in the web chat, such as a quote,
- hanging up, once the caller is done and you've said goodbye.
When you delegate, describe the task clearly, including the number, who it is, and what they want. While you wait, tell the caller briefly that you're on it. Relay the result plainly.

Never agree to contact emergency services, make harassing or marketing calls, or impersonate the caller.`,
  },
  {
    key: "liveTask",
    label: "Task call voice (GPT-Live)",
    usedFor: "The GPT-Live voice on calls placed (or call-backs received) on behalf of a user.",
    addedByCode: "the call brief (time, requester, who is being called, objective, the requester's notes), plus the speak-first prompt on calls the agent placed.",
    placeholders: ["{agent}", "{style}"],
    required: ["{style}"],
    defaultText: `You are {agent}, an AI assistant on a phone call you placed on behalf of someone else (the "requester").

{style}

Pursue the objective in the brief below politely and efficiently. Confirm important details (amounts, dates, reference numbers) by repeating them back. Only share what the objective needs. Never invent facts, make commitments, agree to payments, or share personal or financial details beyond what the brief allows; say you'll pass decisions along to the requester.

Delegate when you need to:
- press keypad digits in a phone menu (say exactly which digits),
- hang up, after you've said goodbye because the objective is met, the person can't help, they ask you to stop calling, or you've left a voicemail.
If you reach voicemail, leave a short message: who you are, who you're calling for, why, and that they can call this number back. Then delegate hanging up.`,
  },
  {
    key: "liveSpeakFirst",
    label: "Speak first (GPT-Live)",
    usedFor: "Added to the task call voice prompt on calls the agent placed, so it starts talking right after the greeting.",
    addedByCode: "nothing; a separate kickoff message with the call's objective is sent after the greeting.",
    placeholders: ["{agent}"],
    required: [],
    defaultText: `This is a call you placed. The recorded greeting introduced you; as soon as it finishes, keep talking without waiting for a reply: say in a sentence why you're calling, then ask your first question.`,
  },
  {
    key: "liveBackend",
    label: "Backend agent addendum (GPT-Live)",
    usedFor: "Added after the user assistant or task call prompt for the agent that handles GPT-Live's delegated tasks.",
    addedByCode: "the same user details or call brief, the call transcript, the delegated task and the tools.",
    placeholders: ["{agent}"],
    required: [],
    defaultText: `You are the back end of a live phone call. A real-time voice model is talking on the call and has delegated a task to you, shown at the end of the transcript. Work out what it needs from the conversation, use your tools to do it, then reply with a short plain-text result (under 60 words) that the voice model will relay. Don't ask the caller questions directly; if information is missing, say exactly what the voice model should ask for. If a number hasn't been confirmed out loud, ask for confirmation instead of acting.
If the conversation is over (goodbyes said, the objective met, a voicemail left, or the other person wants to stop), call end_call; the call hangs up as soon as the goodbye finishes playing.`,
  },
];

const DEFINITIONS = new Map(PROMPTS.map((p) => [p.key, p]));

export function promptDefinition(key: string): PromptDefinition | undefined {
  return DEFINITIONS.get(key as PromptKey);
}

// ---- Overrides -------------------------------------------------------------

const STORE_PREFIX = "prompt.";
const storeKey = (key: PromptKey) => `${STORE_PREFIX}${key}`;

/** Current overrides, mirrored from the settings table. */
let overrides: Partial<Record<PromptKey, string>> = {};

/** The template in effect: the admin's override, or the built-in default. */
export function promptTemplate(key: PromptKey): string {
  return overrides[key] ?? DEFINITIONS.get(key)!.defaultText;
}

export function isPromptOverridden(key: PromptKey): boolean {
  return overrides[key] !== undefined;
}

/** Fill a template's placeholders. Unknown ones are left as typed (validation rejects them). */
function render(key: PromptKey): string {
  const values: Record<string, string> = { agent: config.agent.name };
  if (DEFINITIONS.get(key)!.placeholders.includes("{style}")) values.style = render("liveStyle");
  return promptTemplate(key).replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

/** Normalize textarea input: browsers submit CRLF line endings. */
export function normalizePrompt(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** Check an admin's prompt edit. Returns an error message, or null when it's fine. */
export function validatePrompt(key: PromptKey, text: string): string | null {
  const def = DEFINITIONS.get(key);
  if (!def) return "Unknown prompt.";
  const value = normalizePrompt(text);
  if (!value) return "The prompt can't be empty.";
  if (value.length > MAX_PROMPT_LENGTH) return `Keep the prompt under ${MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters.`;
  const unknown = [...new Set(value.match(/\{\w+\}/g) ?? [])].filter((p) => !def.placeholders.includes(p));
  if (unknown.length) {
    return `Unknown placeholder${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. This prompt can use: ${def.placeholders.join(", ")}.`;
  }
  const missing = def.required.filter((p) => !value.includes(p));
  if (missing.length) return `This prompt must keep ${missing.join(", ")}.`;
  return null;
}

function setOverrides(next: Partial<Record<PromptKey, string>>): void {
  overrides = next;
  refreshExports();
}

/**
 * Reload overrides from the database. Called at startup and before each chat
 * reply or call starts, so changes made elsewhere are picked up. On a database
 * error the last known prompts stay in effect.
 */
export async function loadPromptOverrides(): Promise<void> {
  try {
    const stored = await readSettingValues(STORE_PREFIX);
    const next: Partial<Record<PromptKey, string>> = {};
    for (const def of PROMPTS) {
      const value = stored[storeKey(def.key)];
      if (typeof value === "string" && value.trim()) next[def.key] = value;
    }
    setOverrides(next);
  } catch (err) {
    console.error("Could not load prompt overrides; keeping the current prompts", err);
  }
}

/**
 * Save an admin's prompt (validate first). Text identical to the default
 * clears the override, so later improvements to the default still apply.
 */
export async function savePromptOverride(key: PromptKey, text: string): Promise<void> {
  const error = validatePrompt(key, text);
  if (error) throw new Error(error);
  const value = normalizePrompt(text);
  if (value === DEFINITIONS.get(key)!.defaultText) return resetPromptOverride(key);
  await saveSettingValues({ [storeKey(key)]: value });
  setOverrides({ ...overrides, [key]: value });
}

/** Go back to the built-in default. */
export async function resetPromptOverride(key: PromptKey): Promise<void> {
  await deleteSettingValues([storeKey(key)]);
  const { [key]: _removed, ...rest } = overrides;
  setOverrides(rest);
}

// ---- Prompts as used by the agents ----------------------------------------
// The constants are `let` so ES module importers always see the current value
// (exports are live bindings); they're recomputed whenever overrides change.

export let USER_ASSISTANT_PROMPT = "";
export let USER_VOICE_ADDENDUM = "";
export let CALL_SUMMARY_PROMPT = "";
export let LIVE_SPEAK_FIRST = "";
export let LIVE_BACKEND_ADDENDUM = "";

function refreshExports(): void {
  USER_ASSISTANT_PROMPT = render("userAssistant");
  USER_VOICE_ADDENDUM = render("userVoice");
  CALL_SUMMARY_PROMPT = render("callSummary");
  LIVE_SPEAK_FIRST = render("liveSpeakFirst");
  LIVE_BACKEND_ADDENDUM = render("liveBackend");
}
refreshExports();

export function taskCallPrompt(): string {
  return render("taskCall");
}

// ---- GPT-Live voice calls --------------------------------------------------
// GPT-Live does the talking; anything that needs tools is delegated to a
// backend agent (GPT-6 Luna), whose short result comes back for GPT-Live to relay.

/** The caller's details are always appended, whatever the template says. */
export function liveUserInstructions(details: string): string {
  return `${render("liveUser")}\n\n${details}`;
}

/** The call brief is always appended, whatever the template says. */
export function liveTaskInstructions(brief: string): string {
  return `${render("liveTask")}\n\n${brief}`;
}
