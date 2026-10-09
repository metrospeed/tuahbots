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

const {
  endsWithFarewell,
  isClosingReply,
  isAudibleMulaw,
  GoodbyeWatcher,
  GOODBYE_QUIET_MS,
  CALLER_GOODBYE_QUIET_MS,
  ANSWER_WAIT_MS,
  GOODBYE_MAX_WAIT_MS,
  CALLER_GOODBYE_MAX_WAIT_MS,
  GOODBYE_ABSOLUTE_MAX_MS,
  GOODBYE_BACKSTOP_MS,
  CALLER_PAUSE_MS,
  LineSound,
} = await import("../src/voice/goodbye.js");

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

test("goodbye detection: a farewell followed by a name or 'for now', but not a question", () => {
  for (const said of ["Goodbye, Mr. Smith!", "Bye for now.", "Okay, bye Tuah", "Thanks, have a good one, Gail."]) assert.ok(endsWithFarewell(said), said);
  for (const said of ["Goodbye, what's your number?", "Bye, did you get that?", "Take care of the invoice and send it over today please"]) {
    assert.ok(!endsWithFarewell(said), said);
  }
});

test("goodbye watcher: hangs up after the agent's goodbye, whatever the other side answers", () => {
  // The agent says goodbye; the other side replies with something we don't list as a closing.
  let w = new GoodbyeWatcher();
  w.agentSaid("You're welcome, Gail. ", 0);
  w.agentSaid("Goodbye!", 500);
  assert.equal(w.isOver(500 + GOODBYE_QUIET_MS - 1), false, "waits for a quiet moment");
  w.callerSaid("Perfect, thanks for all your help", 1500);
  assert.equal(w.isOver(1500 + GOODBYE_QUIET_MS), false, "gives the agent a chance to answer");
  assert.equal(w.isOver(1500 + ANSWER_WAIT_MS), true, "the agent had nothing to add, so the call ends");
  assert.equal(w.endedBy, "agent");

  // A plain "bye" back only needs the short quiet period.
  w = new GoodbyeWatcher();
  w.agentSaid("Okay, bye!", 0);
  w.callerSaid("Bye.", 800);
  assert.equal(w.isOver(800 + GOODBYE_QUIET_MS), true);

  // The agent carries on after "wait, one more thing": no hang-up.
  w = new GoodbyeWatcher();
  w.agentSaid("Okay, bye!", 0);
  w.callerSaid("Wait, one more thing, can you also call the plumber?", 800);
  w.agentSaid("Sure", 2000);
  w.agentSaid(", what's the plumber's number?", 2200);
  assert.equal(w.isOver(60_000), false);

  // A goodbye in the middle of a sentence doesn't count once the agent keeps going.
  w = new GoodbyeWatcher();
  w.agentSaid("Before I say goodbye", 0);
  w.agentSaid(", could you spell your last name for me?", 300);
  assert.equal(w.isOver(60_000), false);
});

test("goodbye watcher: hangs up when the other side says goodbye and the agent just closes", () => {
  let w = new GoodbyeWatcher();
  w.agentSaid("Your appointment is booked for Friday at 3.", 0);
  w.callerSaid("Great, thank you. Bye!", 1000);
  w.agentSaid("You too!", 1600);
  assert.equal(w.isOver(1600 + CALLER_GOODBYE_QUIET_MS - 1), false);
  assert.equal(w.isOver(1600 + CALLER_GOODBYE_QUIET_MS), true);
  assert.equal(w.endedBy, "caller");

  // ...but not if the agent answers with more business.
  w = new GoodbyeWatcher();
  w.callerSaid("Okay, bye!", 0);
  w.agentSaid("Before you go, could you confirm the total?", 700);
  assert.equal(w.isOver(60_000), false);

  // Audio still arriving counts as the agent talking.
  w = new GoodbyeWatcher();
  w.agentSaid("Goodbye!", 0);
  w.agentAudio(2500);
  assert.equal(w.isOver(GOODBYE_QUIET_MS), false);
  assert.equal(w.isOver(2500 + GOODBYE_QUIET_MS), true);
});

test("goodbye detection: more everyday farewells, without matching ordinary requests", () => {
  for (const said of ["Enjoy the rest of your day!", "See you later!", "Have a great week!", "Good night!", "All the best!", "Enjoy your weekend, Pat."]) {
    assert.ok(endsWithFarewell(said), said);
  }
  for (const said of ["I'll see you Friday at 3", "Can I have one.", "Have a look at the invoice.", "Take care of the invoice please"]) assert.ok(!endsWithFarewell(said), said);
});

test("goodbye watcher: silent audio, empty fragments and line noise can't keep a finished call open", () => {
  // GPT-Live keeps streaming after the goodbye: whatever arrives, the call ends within the cap.
  let w = new GoodbyeWatcher();
  w.agentSaid("Thanks, Gail. Goodbye!", 1000);
  for (let t = 1000; t <= 1000 + GOODBYE_MAX_WAIT_MS; t += 20) {
    w.agentAudio(t); // even if it counted as audible
    if (t % 1000 === 0) w.agentSaid("", t);
    if (t % 500 === 0) w.callerSaid(" ", t);
  }
  assert.equal(w.isOver(1000 + GOODBYE_MAX_WAIT_MS), true);

  // Noise transcribed as punctuation isn't speech at all.
  w = new GoodbyeWatcher();
  w.agentSaid("Goodbye!", 0);
  for (let t = 500; t < GOODBYE_QUIET_MS; t += 500) w.callerSaid("…", t);
  assert.equal(w.isOver(GOODBYE_QUIET_MS), true);

  // Noise transcribed as words looks like someone talking: it can push the wait back, but not past the backstop.
  w = new GoodbyeWatcher();
  w.agentSaid("Okay, bye!", 0);
  let over = -1;
  for (let t = 1000; t <= GOODBYE_BACKSTOP_MS && over < 0; t += 1000) {
    w.callerSaid("[inaudible]", t);
    if (w.isOver(t + 999)) over = t + 999;
  }
  assert.ok(over >= GOODBYE_ABSOLUTE_MAX_MS && over < GOODBYE_BACKSTOP_MS + 1000, `ended at ${over}`);

  // The other side says goodbye; the agent's audio keeps arriving, so the cap ends it.
  w = new GoodbyeWatcher();
  w.callerSaid("Thanks, bye!", 0);
  for (let t = 0; t < CALLER_GOODBYE_MAX_WAIT_MS; t += 20) w.agentAudio(t);
  assert.equal(w.isOver(CALLER_GOODBYE_MAX_WAIT_MS - 1), false);
  assert.equal(w.isOver(CALLER_GOODBYE_MAX_WAIT_MS), true);
});

test("goodbye watcher: a backchannel in the middle of a farewell doesn't hide it", () => {
  const w = new GoodbyeWatcher();
  w.agentSaid("Thanks so much, have a great", 0);
  w.callerSaid("Mhm.", 200);
  w.agentSaid(" day!", 400);
  assert.equal(w.isOver(400 + GOODBYE_QUIET_MS), true);
});

test("goodbye watcher: the agent answering a last question is never cut off by the cap", () => {
  const w = new GoodbyeWatcher();
  w.agentSaid("Okay, bye!", 0);
  // A long "one more thing" from the other side, finishing well after the agent's goodbye.
  for (let t = 1000; t <= 9000; t += 1000) w.callerSaid(" and one more thing about the plumber", t);
  w.agentSaid("Sure", 9500);
  // The agent's answer is audibly under way; 12.5 s after its goodbye it must not be cut off.
  for (let t = 9500; t <= 12_500; t += 20) w.agentAudio(t);
  assert.equal(w.isOver(12_500), false, "the cap restarted when the other side added something");
  w.agentSaid(", what's their number?", 12_600);
  assert.equal(w.isOver(60_000), false, "the agent carried on");
});

test("goodbye watcher: never cuts off someone still talking after the agent's goodbye", () => {
  const w = new GoodbyeWatcher();
  w.agentSaid("Okay, I'll call them now. Goodbye!", 0);
  // A long second errand, dictated over 40 s while the agent only says "Mhm".
  for (let t = 2000; t <= 40_000; t += 400) {
    w.callerSaid(" the number is four one five", t);
    if (t % 8000 === 0) w.agentSaid("Mhm.", t + 100);
    assert.equal(w.isOver(t + 200), false, `still talking at ${t}`);
  }
  // Once they stop, the agent gets its chance to answer; if it doesn't, the call ends.
  assert.equal(w.isOver(40_000 + CALLER_PAUSE_MS - 1), false, "the agent gets a moment to answer");
  assert.equal(w.isOver(40_000 + ANSWER_WAIT_MS), true);
  // Words that never stop still end at the backstop.
  const noisy = new GoodbyeWatcher();
  noisy.agentSaid("Goodbye!", 0);
  for (let t = 500; t < GOODBYE_BACKSTOP_MS; t += 500) noisy.callerSaid(" blah", t);
  assert.equal(noisy.isOver(GOODBYE_BACKSTOP_MS - 1), false);
  assert.equal(noisy.isOver(GOODBYE_BACKSTOP_MS), true);
  assert.ok(GOODBYE_ABSOLUTE_MAX_MS < GOODBYE_BACKSTOP_MS);
});

test("goodbye watcher: ordinary small talk with farewell-like words doesn't hang up", () => {
  const run = (lines: Array<[speaker: "agent" | "caller", text: string]>) => {
    const w = new GoodbyeWatcher();
    let t = 0;
    for (const [speaker, text] of lines) {
      t += 1000;
      if (speaker === "agent") w.agentSaid(text, t);
      else w.callerSaid(text, t);
    }
    return w.isOver(t + 60_000);
  };
  assert.equal(run([["caller", "Sure, let me check if Saturday is a good night."], ["agent", "Sure, thanks!"]]), false);
  assert.equal(run([["agent", "Would Friday be a good night?"], ["caller", "Yeah."], ["agent", "Perfect, thank you so much."]]), false);
  assert.equal(run([["agent", "Did you have a good weekend?"], ["caller", "Yeah."], ["agent", "Great!"]]), false);
  assert.equal(run([["agent", "Done, the plumber will see you later today."], ["caller", "Great, thanks."]]), false);
  // A question split from its "?" isn't a goodbye either.
  assert.equal(run([["caller", "Can we talk later"], ["caller", "?"], ["agent", "Yes, perfect!"]]), false);
});

test("goodbye watcher: a request that ends in farewell words still gets an answer", () => {
  const w = new GoodbyeWatcher();
  w.agentSaid("Alright, goodbye!", 0);
  w.callerSaid("Oh wait, can you call my mom and tell her good night.", 1000);
  assert.equal(w.isOver(1000 + GOODBYE_QUIET_MS + 1000), false, "the agent gets the full answer window");
  assert.equal(w.isOver(1000 + ANSWER_WAIT_MS), true);
});

test("line sound: hold music counts, dead air and clicks don't", () => {
  const tone = Buffer.from(Array.from({ length: 160 }, (_, i) => linearToMulaw(3000 * Math.sin((2 * Math.PI * 440 * i) / 8000))));
  const silence = Buffer.alloc(160, 0xff);
  let line = new LineSound();
  let heard = false;
  for (let i = 0; i < 50; i++) heard = line.frame(tone);
  assert.equal(heard, true, "a second of hold music");
  line = new LineSound();
  for (let i = 0; i < 50; i++) heard = line.frame(i % 10 === 0 ? tone : silence);
  assert.equal(heard, false, "occasional clicks");
  for (let i = 0; i < 50; i++) heard = line.frame(silence);
  assert.equal(heard, false, "dead air");
});

test("silent μ-law audio isn't counted as speech", () => {
  assert.equal(isAudibleMulaw(Buffer.alloc(160, 0xff)), false);
  assert.equal(isAudibleMulaw(Buffer.alloc(160, 0x7f)), false);
  assert.equal(isAudibleMulaw(Buffer.alloc(0)), false);
  assert.equal(isAudibleMulaw(dtmfAudio("5").subarray(0, 160)), true);
  // Mean |sample| of a sine is 2A/π: about 100 (-50 dBFS, hiss) must be silent, about 260 (-40 dBFS, a soft consonant) audible.
  const sine = (amplitude: number) => Buffer.from(Array.from({ length: 160 }, (_, i) => linearToMulaw(amplitude * Math.sin((2 * Math.PI * 4 * i) / 160))));
  assert.equal(isAudibleMulaw(sine(157)), false, "a faint hiss");
  assert.equal(isAudibleMulaw(sine(408)), true, "a soft consonant");
  assert.equal(isAudibleMulaw(sine(1500)), true, "quiet speech");
});

test("goodbye detection: promises and passed-on messages aren't goodbyes", () => {
  for (const said of [
    "Okay, I'll take care of it.",
    "Let me take care of that.",
    "Sure, I'll text her good night.",
    "Okay, I'll tell him see you soon.",
    "I'll wish them all the best.",
    "I'll tell her goodbye for you.",
    "Call my mom and tell her good night.",
  ]) {
    assert.ok(!endsWithFarewell(said), said);
  }
  for (const said of ["Take care of yourself!", "Have a wonderful rest of your evening!", "Have a great rest of your week!", "Thanks, good night!", "I hope you have a great day!"]) {
    assert.ok(endsWithFarewell(said), said);
  }
});

test("goodbye watcher: the other side handing the call on isn't a goodbye", () => {
  const w = new GoodbyeWatcher();
  w.callerSaid("Okay, I'm going to transfer you to billing now. Have a great day!", 0);
  w.agentSaid("Thank you so much!", 1000);
  assert.equal(w.isOver(60_000), false);
});

test("goodbye watcher: a noisy line repeating closings doesn't stretch the wait", () => {
  const w = new GoodbyeWatcher();
  w.agentSaid("All set. Goodbye!", 0);
  for (let t = 1000; t <= 20_000; t += 1000) w.callerSaid("Okay.", t);
  assert.equal(w.isOver(GOODBYE_MAX_WAIT_MS), true, "the cap from the goodbye still applies");
});

test("goodbye watcher: extend() restarts the timers for a result the agent still has to relay", () => {
  const w = new GoodbyeWatcher();
  w.agentSaid("Will do, bye!", 0);
  assert.ok(w.agentSaidGoodbyeSince(0));
  assert.equal(w.agentSaidGoodbyeSince(1), false);
  w.extend(20_000); // a slow errand just finished
  assert.equal(w.isOver(20_000 + GOODBYE_QUIET_MS - 1), false);
  // Relaying the result doesn't take the goodbye back...
  w.agentSaid("All done, they moved it to Friday.", 21_000);
  assert.equal(w.isOver(21_000 + GOODBYE_QUIET_MS - 1), false, "waits for the result to be heard");
  assert.equal(w.isOver(21_000 + GOODBYE_QUIET_MS), true);
  // ...but asking something does.
  const q = new GoodbyeWatcher();
  q.agentSaid("Will do, bye!", 0);
  q.extend(10_000);
  q.agentSaid("They're full on Friday. Should I try Saturday?", 11_000);
  assert.equal(q.isOver(60_000), false);
});

test("goodbye watcher: a transfer or hold isn't the end of the call, from either side", () => {
  const sim = (lines: Array<[speaker: "agent" | "caller", text: string]>) => {
    const w = new GoodbyeWatcher();
    let t = 0;
    for (const [speaker, text] of lines) {
      t += 1500;
      if (speaker === "agent") w.agentSaid(text, t);
      else w.callerSaid(text, t);
    }
    return { w, t };
  };
  // The agent mirrors the receptionist's farewell; ringback follows.
  let { w, t } = sim([["caller", "Okay, I'm going to transfer you to billing now. Have a great day!"], ["agent", "Thank you! You have a great day too."]]);
  assert.equal(w.isOver(t + 60_000), false);
  // The hand-off and the farewell in separate turns.
  ({ w, t } = sim([["caller", "Sure, let me transfer you to billing."], ["agent", "Great, thank you!"], ["caller", "Mhm, have a great day!"], ["agent", "You too!"]]));
  assert.equal(w.isOver(t + 60_000), false);
  ({ w, t } = sim([["caller", "Let me get you over to the pharmacy, hang on. Have a good one."], ["agent", "Thank you!"]]));
  assert.equal(w.isOver(t + 60_000), false);
  // Once someone new picks up, goodbyes count again.
  ({ w, t } = sim([["caller", "Please hold."], ["agent", "Sure."], ["caller", "Billing, this is Sara, how can I help?"], ["agent", "Hi Sara, I'm calling about invoice 42."], ["caller", "That's sorted now. Have a great day!"], ["agent", "Thanks, you too, goodbye!"]]));
  assert.equal(w.isOver(t + GOODBYE_QUIET_MS), true);
  // On a user's own call, "hold on" is just a pause.
  const own = new GoodbyeWatcher({ handoffs: false });
  own.callerSaid("Hold on, actually never mind. Thanks, bye!", 0);
  own.agentSaid("Bye!", 1000);
  assert.equal(own.isOver(1000 + GOODBYE_QUIET_MS), true);
  // A hold earlier in the turn, then a goodbye, still counts.
  ({ w, t } = sim([["caller", "One moment please. Okay, you're booked for Friday at three, have a great day!"], ["agent", "Thank you, goodbye!"]]));
  assert.equal(w.isOver(t + GOODBYE_QUIET_MS), true);
});

test("goodbye watcher: a reply that opens with a goodbye counts as one", () => {
  for (const reply of ["Bye, see you tomorrow!", "Bye, Mark! Have fun tonight!", "Good night, talk to you tomorrow!", "Goodnight, Mark, sleep well!"]) {
    const w = new GoodbyeWatcher();
    w.callerSaid("Okay, thanks, bye!", 0);
    w.agentSaid(reply, 1000);
    assert.equal(w.isOver(1000 + GOODBYE_QUIET_MS), true, reply);
  }
  const w = new GoodbyeWatcher();
  w.callerSaid("Okay, thanks, bye!", 0);
  w.agentSaid("Bye! Oh wait, did you want me to call them too?", 1000);
  assert.equal(w.isOver(60_000), false, "a question carries on");
});

test("goodbye detection: someone else's plans or advice aren't the agent's goodbye", () => {
  for (const said of [
    "Yes, I told your mom you'd be late, and she said she'll talk to you later.",
    "Not yet. The nurse said Dr. Kim will talk to you later today.",
    "Mario's has you down for Saturday at seven, so you should have a great weekend.",
    "Okay, and tell her to have a great day.",
    "So take care driving.",
    "They don't have a good one.",
  ]) {
    assert.ok(!endsWithFarewell(said), said);
  }
  for (const said of ["We'll talk soon, bye!", "I'll talk to you later!", "She'll talk to you later. Bye!", "Have a great day, Mrs. O'Brien!", "Thank you for calling, goodbye."]) {
    assert.ok(endsWithFarewell(said), said);
  }
});
