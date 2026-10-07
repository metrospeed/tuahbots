import "./env.js";
import assert from "node:assert/strict";
import { test } from "node:test";

const { validateInput } = await import("../src/agent/llm.js");
const { toE164 } = await import("../src/phone.js");
const { withLock } = await import("../src/lock.js");
const { createRelaySession, takeRelaySession } = await import("../src/voice/sessions.js");
const { buildRelayTwiml } = await import("../src/voice/twiml.js");
const { dtmfAudio, linearToMulaw } = await import("../src/voice/dtmf.js");

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
