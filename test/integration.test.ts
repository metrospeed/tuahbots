import "./env.js";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import twilio from "twilio";
import { WebSocket, WebSocketServer } from "ws";

const enabled = !!process.env.TEST_DATABASE_URL;

// A stand-in for the GPT-Live API, so calls can be exercised end to end.
const fakeLive = new WebSocketServer({ port: 0 });
await new Promise((resolve) => fakeLive.once("listening", resolve));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(fakeLive.address() as AddressInfo).port}/v1`;
// Claude is unreachable in tests; the call should still recover gracefully.
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
const liveConnections: Array<{ ws: WebSocket; path: string; received: any[] }> = [];
fakeLive.on("connection", (ws, req) => {
  const conn = { ws, path: req.url ?? "", received: [] as any[] };
  liveConnections.push(conn);
  ws.on("message", (data) => conn.received.push(JSON.parse(data.toString())));
});
const { createServer } = await import("../src/app.js");
const db = await import("../src/db/index.js");

let base = "";
let server: ReturnType<typeof createServer>;

before(async () => {
  if (!enabled) return;
  await db.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await db.migrate();
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  fakeLive.close();
  if (!enabled) return;
  server.close();
  await db.pool.end();
});

/** POST a form the way Twilio does, with a valid signature. */
async function twilioPost(path: string, params: Record<string, string>): Promise<Response> {
  const signature = twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN!, `https://agent.test${path}`, params);
  return fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
    body: new URLSearchParams(params),
  });
}

async function login(): Promise<string> {
  const res = await fetch(`${base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "admin-pass" }),
  });
  assert.equal(res.status, 302);
  return res.headers.get("set-cookie")!.split(";")[0];
}

test("webhooks reject unsigned requests", { skip: !enabled }, async () => {
  const res = await fetch(`${base}/twilio/voice`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "From=%2B14155552671&CallSid=CA1",
  });
  assert.equal(res.status, 403);
});

test("calls from uninvited numbers are rejected and logged", { skip: !enabled }, async () => {
  const res = await twilioPost("/twilio/voice", { From: "+14155550000", CallSid: "CAunknown" });
  const xml = await res.text();
  assert.match(xml, /only takes calls from invited users/);
  assert.match(xml, /<Hangup\/>/);
  const rows = await db.query("SELECT * FROM conversations WHERE call_sid = 'CAunknown'");
  assert.equal(rows[0].kind, "unknown_call");
});

test("admin requires login", { skip: !enabled }, async () => {
  const res = await fetch(`${base}/admin/conversations`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/admin/login");
  const bad = await fetch(`${base}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "password=wrong",
  });
  assert.equal(bad.status, 401);
});

test("invited users get a recorded-call disclosure and a relay session", { skip: !enabled }, async () => {
  const cookie = await login();
  const invite = await fetch(`${base}/admin/users`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams({ name: "Pat Example", phone: "(415) 555-2671" }),
  });
  assert.equal(invite.status, 302);
  const users = await (await fetch(`${base}/admin/users`, { headers: { Cookie: cookie } })).text();
  assert.match(users, /Pat Example/);

  const res = await twilioPost("/twilio/voice", { From: "+14155552671", CallSid: "CAuser" });
  const xml = await res.text();
  // The disclosure is spoken verbatim by Twilio before GPT-Live joins.
  assert.match(xml, /<Say[^>]*>Hi Pat, it's Tuah\. Just so you know, this call is recorded and transcribed\./);
  assert.match(xml, /<Stream url="wss:\/\/agent\.test\/twilio\/stream">/);
  const token = /<Parameter name="token" value="([^"]+)"/.exec(xml)![1];

  const streamUrl = `${base.replace("http", "ws")}/twilio/stream`;
  const open = async () => {
    const ws = new WebSocket(streamUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    return ws;
  };
  const start = (t: string) =>
    JSON.stringify({ event: "start", streamSid: "MZ1", start: { streamSid: "MZ1", callSid: "CAuser", customParameters: { token: t } } });

  // A forged token is refused.
  const bad = await open();
  const badClosed = new Promise((resolve) => bad.on("close", resolve));
  bad.send(start("forged"));
  await badClosed;

  const twilioSide = await open();
  const toCaller: any[] = [];
  twilioSide.on("message", (data) => toCaller.push(JSON.parse(data.toString())));
  twilioSide.send(start(token));
  twilioSide.send(JSON.stringify({ event: "media", streamSid: "MZ1", media: { track: "inbound", payload: "AAAA" } }));

  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(check());
  };
  await waitFor(() => liveConnections.length === 1 && liveConnections[0].received.length > 0);
  const live = liveConnections[0];
  assert.equal(live.path, "/v1/live/sessions");
  const sessionStart = live.received[0];
  assert.equal(sessionStart.type, "session.start");
  assert.equal(sessionStart.session.model, "gpt-live-1");
  assert.deepEqual(sessionStart.session.audio.format, { type: "audio/pcmu", rate: 8000 });
  assert.deepEqual(sessionStart.session.delegation, { type: "client" });
  assert.match(sessionStart.session.instructions, /You are talking with Pat Example/);
  assert.match(sessionStart.session.input[1].content[0].text, /recorded and transcribed/);

  // Caller audio buffered before session.started is forwarded once it starts.
  const send = (event: object) => live.ws.send(JSON.stringify(event));
  send({ type: "session.started", event_id: "e1", session: { id: "sess_1", model: "gpt-live-1", status: "active", expires_at: 0 } });
  await waitFor(() => live.received.some((e) => e.type === "session.input_audio.append" && e.audio === "AAAA"));

  // GPT-Live speech is played to the caller.
  send({ type: "session.output_audio.delta", delta: "//8=" });
  await waitFor(() => toCaller.some((m) => m.event === "media" && m.media.payload === "//8=" && m.streamSid === "MZ1"));

  // Transcripts are stored; a delegation gets an answer even when the backend fails.
  send({ type: "session.input_transcript.delta", event_id: "t1", delta: "Call my plumber please", start_ms: 3000, end_ms: 4000 });
  send({ type: "session.output_transcript.delta", event_id: "t2", delta: "Sure, one moment.", start_ms: 4500, end_ms: 5500 });
  send({ type: "session.delegation.created", event_id: "d1", offset_ms: 5600, delegation: { id: "del_1", target: "client", type: "delegation" } });
  await waitFor(() => live.received.some((e) => e.type === "session.commentary.append" && e.delegation_id === "del_1"));

  twilioSide.send(JSON.stringify({ event: "stop", streamSid: "MZ1" }));
  await waitFor(() => live.ws.readyState === WebSocket.CLOSED);
  const conversation = (await db.query("SELECT id FROM conversations WHERE call_sid = 'CAuser'"))[0];
  await new Promise((r) => setTimeout(r, 300));
  const lines = await db.query("SELECT role, body FROM messages WHERE conversation_id = $1 ORDER BY id", [conversation.id]);
  assert.ok(lines.some((l) => l.role === "user" && l.body === "Call my plumber please"));
  assert.ok(lines.some((l) => l.role === "assistant" && l.body === "Sure, one moment."));

  const page = await (await fetch(`${base}/admin/conversations`, { headers: { Cookie: cookie } })).text();
  assert.match(page, /User call/);
});

test("texts from unknown numbers are stored without replying", { skip: !enabled }, async () => {
  const res = await twilioPost("/twilio/sms", { From: "+14155550001", Body: "hello?", MessageSid: "SM1", NumMedia: "0" });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));
  const rows = await db.query("SELECT m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.kind = 'unknown_sms'");
  assert.equal(rows[0].body, "hello?");
});
