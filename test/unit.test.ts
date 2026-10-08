import "./env.js";
import assert from "node:assert/strict";
import { test } from "node:test";

const { validateInput } = await import("../src/agent/llm.js");
const { toE164 } = await import("../src/phone.js");
const { withLock } = await import("../src/lock.js");
const { createRelaySession, takeRelaySession } = await import("../src/voice/sessions.js");
const { buildRelayTwiml } = await import("../src/voice/twiml.js");
const { dtmfAudio, linearToMulaw } = await import("../src/voice/dtmf.js");
const { normalizeRecording } = await import("../src/recordings.js");
const { execFileSync, spawnSync } = await import("node:child_process");

let hasFfmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  hasFfmpeg = false;
}

/** A quiet MP3 like Twilio's: 8 kHz mono, a tone peaking around -30 dBFS. */
function quietMp3(): Buffer {
  return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=400:d=3,volume=0.03", "-ar", "8000", "-ac", "1", "-b:a", "32k", "-f", "mp3", "pipe:1"]);
}

/** Mean volume of some audio in dB, as measured by ffmpeg. */
function meanVolume(audio: Buffer): number {
  const out = spawnSync("ffmpeg", ["-hide_banner", "-i", "pipe:0", "-af", "volumedetect", "-f", "null", "-"], { input: audio }).stderr.toString();
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(out)?.[1]);
}

test("toE164 normalizes US numbers and rejects junk", () => {
  assert.equal(toE164("(415) 555-2671"), "+14155552671");
  assert.equal(toE164("+1 415 555 2671"), "+14155552671");
  assert.equal(toE164("12345"), null);
});

test("validateInput checks required fields and types", () => {
  const tool = {
    name: "t",
    description: "test tool",
    parameters: {
      type: "object" as const,
      properties: { phone: { type: "string" }, task_id: { type: "integer" } },
      required: ["phone"],
    },
  };
  assert.equal(validateInput(tool, { phone: "1" }), null);
  assert.match(validateInput(tool, {})!, /Missing required field "phone"/);
  assert.match(validateInput(tool, { phone: "1", task_id: 1.5 })!, /integer/);
  assert.match(validateInput(tool, "nope")!, /JSON object/);
});

test("withLock serializes work per key", async () => {
  const order: string[] = [];
  const slow = withLock("k", async () => {
    await new Promise((r) => setTimeout(r, 20));
    order.push("first");
  });
  const fast = withLock("k", async () => order.push("second"));
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["first", "second"]);
});

test("relay session tokens are single use", () => {
  const token = createRelaySession({ mode: "user", conversationId: 1, userId: 1, greeting: "hi" });
  assert.equal(takeRelaySession(token)?.conversationId, 1);
  assert.equal(takeRelaySession(token), undefined);
});

test("relay TwiML speaks an uninterruptible greeting and points at our websocket", () => {
  const xml = buildRelayTwiml("tok", "This call is being recorded.");
  assert.match(xml, /<ConversationRelay [^>]*url="wss:\/\/agent\.test\/twilio\/relay\?token=tok"/);
  assert.match(xml, /welcomeGreeting="This call is being recorded\."/);
  assert.match(xml, /welcomeGreetingInterruptible="none"/);
});

test("DTMF tones are 8 kHz mu-law: 200 ms tone plus 100 ms gap per digit", () => {
  assert.equal(linearToMulaw(0), 0xff);
  assert.equal(linearToMulaw(32767), 0x80);
  assert.equal(linearToMulaw(-32768), 0x00);
  assert.equal(dtmfAudio("1").length, 2400);
  assert.equal(dtmfAudio("1w2").length, 2400 * 2 + 4000);
  assert.equal(dtmfAudio("x").length, 0);
});

const { fillGreeting, validateSettings, DEFAULT_SETTINGS } = await import("../src/settings.js");

test("greeting templates fill placeholders and keep unknown ones", () => {
  assert.equal(fillGreeting("Hi {recipient}, {agent} for {requester}. {other}", { recipient: "Mike", agent: "Tuah", requester: "Pat" }), "Hi Mike, Tuah for Pat. {other}");
});

test("settings validation keeps the disclosures and sane hours", () => {
  assert.equal(validateSettings(DEFAULT_SETTINGS), null);
  assert.match(validateSettings({ ...DEFAULT_SETTINGS, greetingOutbound: "Hi, it's {agent} for {requester}, an AI." })!, /recorded/);
  assert.match(validateSettings({ ...DEFAULT_SETTINGS, greetingCallback: "Hi there. This call is recorded." })!, /AI assistant/);
  assert.match(validateSettings({ ...DEFAULT_SETTINGS, contactHoursStart: 21, contactHoursEnd: 8 })!, /hours/);
  assert.match(validateSettings({ ...DEFAULT_SETTINGS, maxCallMinutes: 0 })!, /time limit/);
  assert.match(validateSettings({ ...DEFAULT_SETTINGS, timezone: "Nowhere/Land" })!, /time zone/);
});

test("quiet call recordings are normalized to a comfortable volume", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const quiet = quietMp3();
  const louder = await normalizeRecording(quiet);
  assert.ok(louder?.length);
  const before = meanVolume(quiet);
  const after = meanVolume(louder);
  assert.ok(after - before > 15, `expected at least 15 dB louder, got ${before} -> ${after}`);
  assert.ok(after < -3, "not clipped");
  // Anything ffmpeg can't decode is reported as null, so the original is kept.
  assert.equal(await normalizeRecording(Buffer.alloc(500, 7)), null);
});

const { endsWithFarewell, isClosingReply } = await import("../src/voice/goodbye.js");

test("goodbye detection: the agent's farewell at the end of what it said", () => {
  for (const said of ["Thanks so much, goodbye!", "Great, bye!", "Bye bye.", "Have a great day!", "Okay, take care.", "Thank you, have a nice weekend, Mike!", "Talk to you soon."]) {
    assert.ok(endsWithFarewell(said), said);
  }
  for (const said of ["Before I say goodbye, what's your reference number?", "Could you spell your name?", "Bye the way, is it ready?x not", "I'll take care of that. What time works for you?"]) {
    assert.ok(!endsWithFarewell(said), said);
  }
});

test("goodbye detection: closing replies vs. a new topic", () => {
  for (const reply of ["Bye!", "Thanks, you too.", "Okay, bye bye", "Thank you so much, have a good day", "mhm"]) assert.ok(isClosingReply(reply), reply);
  for (const reply of ["Wait, one more thing", "Actually can you also ask about Friday?", "Hold on, the price changed"]) assert.ok(!isClosingReply(reply), reply);
});

const prompts = await import("../src/agent/prompts.js");

test("prompts use the built-in defaults when no override is stored", () => {
  for (const def of prompts.PROMPTS) {
    assert.equal(prompts.isPromptOverridden(def.key), false);
    assert.equal(prompts.promptTemplate(def.key), def.defaultText);
    assert.equal(prompts.validatePrompt(def.key, def.defaultText), null, `${def.key} default is valid`);
  }
  assert.match(prompts.USER_ASSISTANT_PROMPT, /^You are Tuah, an AI assistant that invited users chat with/);
  assert.doesNotMatch(prompts.USER_ASSISTANT_PROMPT, /\{agent\}/);
  assert.match(prompts.taskCallPrompt(), /^You are Tuah, an AI assistant placing a phone call/);
  // GPT-Live prompts get the shared style filled in and their runtime context appended.
  const live = prompts.liveUserInstructions("You are talking with Pat.");
  assert.match(live, /\n\nYou are speaking on a live phone call\. Sound natural/);
  assert.match(live, /\n\nYou are talking with Pat\.$/);
  assert.match(prompts.liveTaskInstructions("Objective: confirm the quote"), /\n\nObjective: confirm the quote$/);
});

test("prompt edits are validated: not empty, not too long, known placeholders, required ones kept", () => {
  assert.equal(prompts.validatePrompt("userAssistant", "You are {agent}.\r\nBe brief."), null);
  assert.match(prompts.validatePrompt("userAssistant", " \r\n ")!, /can't be empty/);
  assert.match(prompts.validatePrompt("userAssistant", "x".repeat(prompts.MAX_PROMPT_LENGTH + 1))!, /under 8,000 characters/);
  assert.match(prompts.validatePrompt("userAssistant", "You are {name} for {requester}.")!, /Unknown placeholders \{name\}, \{requester\}/);
  assert.match(prompts.validatePrompt("taskCall", "Use {style}.")!, /Unknown placeholder \{style\}/);
  assert.match(prompts.validatePrompt("liveTask", "You are {agent} on a call.")!, /must keep \{style\}/);
  assert.equal(prompts.validatePrompt("liveTask", "You are {agent} on a call.\n{style}"), null);
  assert.equal(prompts.validatePrompt("userAssistant", 'Reply as JSON like {"ok": true}.'), null, "braces that aren't placeholders are fine");
  assert.equal(prompts.normalizePrompt("  a\r\nb\rc  "), "a\nb\nc");
  assert.equal(prompts.promptDefinition("nope"), undefined);
});
