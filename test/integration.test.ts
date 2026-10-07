import "./env.js";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import twilio from "twilio";
import { WebSocket } from "ws";

const enabled = !!process.env.TEST_DATABASE_URL;
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
  assert.match(xml, /<ConversationRelay/);
  assert.match(xml, /this call is recorded and transcribed/);

  // The websocket only accepts the token we minted.
  const bad = new WebSocket(`${base.replace("http", "ws")}/twilio/relay?token=nope`);
  await new Promise<void>((resolve) => bad.on("error", () => resolve()));

  const token = decodeURIComponent(/token=([^"&]+)/.exec(xml)![1]);
  const ws = new WebSocket(`${base.replace("http", "ws")}/twilio/relay?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  ws.close();

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
