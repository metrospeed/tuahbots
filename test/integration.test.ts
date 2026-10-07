import "./env.js";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import twilio from "twilio";
import { WebSocket, WebSocketServer } from "ws";
import http from "node:http";
import { functionCall, rejectUnknown, sendResponseStream, textMessage, unknownInputField } from "./fake-openai.js";

const enabled = !!process.env.TEST_DATABASE_URL;

// A stand-in for the OpenAI API: GPT-Live over WebSocket, and the Responses API
// over HTTP. In a call, the agent model ends the call; elsewhere it errors, so
// the app's failure handling is exercised too.
const fakeOpenAI = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const request = JSON.parse(body || "{}");
    const tools: string[] = (request.tools ?? []).map((t: any) => t.name);
    // Summaries send a plain-string input; tool loops send a list of items.
    const answered = Array.isArray(request.input) && request.input.some((i: any) => i.type === "function_call_output");
    const unknown = unknownInputField(request);
    if (unknown) return rejectUnknown(res, unknown);
    if (!tools.includes("end_call")) return void res.writeHead(400).end(JSON.stringify({ error: { message: "test" } }));
    sendResponseStream(res, request.model, answered ? [textMessage("Ending the call.")] : [functionCall("end_call", { reason: "done" })]);
  });
});
const fakeLive = new WebSocketServer({ server: fakeOpenAI });

// A stand-in for Twilio's recordings API: download (.mp3) and delete (.json).
const twilioRecordings = new Map<string, Buffer>();
const twilioDeletes: string[] = [];
let failNextDelete = false;
const fakeTwilio = http.createServer((req, res) => {
  const m = /\/Recordings\/(\w+)\.(mp3|json)$/.exec(req.url ?? "");
  const sid = m?.[1] ?? "";
  if (m && req.method === "GET" && m[2] === "mp3" && twilioRecordings.has(sid)) {
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    return void res.end(twilioRecordings.get(sid));
  }
  if (m && req.method === "DELETE" && m[2] === "json") {
    if (failNextDelete) {
      failNextDelete = false;
      return void res.writeHead(500).end();
    }
    twilioDeletes.push(sid);
    const existed = twilioRecordings.delete(sid);
    return void res.writeHead(existed ? 204 : 404).end();
  }
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => fakeTwilio.listen(0, resolve));
process.env.TWILIO_API_BASE_URL = `http://127.0.0.1:${(fakeTwilio.address() as AddressInfo).port}`;
await new Promise<void>((resolve) => fakeOpenAI.listen(0, resolve));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(fakeOpenAI.address() as AddressInfo).port}/v1`;
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
  // Prewarmed GPT-Live sessions for calls that never streamed are still open;
  // drop them so the process can exit.
  for (const client of fakeLive.clients) client.terminate();
  fakeLive.close();
  fakeOpenAI.closeAllConnections();
  fakeOpenAI.close();
  fakeTwilio.close();
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
  assert.equal(invite.status, 200);
  assert.match(await invite.text(), /https:\/\/agent\.test\/join\//);
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

  // Transcripts are stored. When the conversation is over, GPT-Live delegates
  // and the agent model ends the call: silently, once the goodbye has played.
  send({ type: "session.input_transcript.delta", event_id: "t1", delta: "That's all, thanks!", start_ms: 3000, end_ms: 4000 });
  send({ type: "session.output_transcript.delta", event_id: "t2", delta: "You're welcome, bye!", start_ms: 4500, end_ms: 5500 });
  send({ type: "session.delegation.created", event_id: "d1", offset_ms: 5600, delegation: { id: "del_1", target: "client", type: "delegation" } });
  await waitFor(() => live.received.some((e) => e.type === "session.thinking.append" && e.delegation_id === "del_1"));
  assert.ok(!live.received.some((e) => e.type === "session.commentary.append"), "no extra goodbye is requested");

  // We ask Twilio to tell us when queued audio has played, and only then hang up.
  await waitFor(() => toCaller.some((m) => m.event === "mark" && m.mark.name === "hangup"));
  assert.ok(!live.received.some((e) => e.type === "session.close"));
  twilioSide.send(JSON.stringify({ event: "mark", streamSid: "MZ1", mark: { name: "hangup" } }));
  await waitFor(() => live.received.some((e) => e.type === "session.close"));

  twilioSide.send(JSON.stringify({ event: "stop", streamSid: "MZ1" }));
  await waitFor(() => live.ws.readyState === WebSocket.CLOSED);
  const conversation = (await db.query("SELECT id FROM conversations WHERE call_sid = 'CAuser'"))[0];
  await new Promise((r) => setTimeout(r, 300));
  const lines = await db.query("SELECT role, body FROM messages WHERE conversation_id = $1 ORDER BY id", [conversation.id]);
  assert.ok(lines.some((l) => l.role === "user" && l.body === "That's all, thanks!"));
  assert.ok(lines.some((l) => l.role === "assistant" && l.body === "You're welcome, bye!"));
  assert.ok(lines.some((l) => l.role === "event" && l.body === "Agent ended the call"));

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

test("invited users chat on the web via their invite link", { skip: !enabled }, async () => {
  const cookie = await login();
  const invite = await fetch(`${base}/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams({ name: "Web Only", phone: "" }),
  });
  const link = /https:\/\/agent\.test(\/join\/[A-Za-z0-9_-]+)/.exec(await invite.text())![1];

  // Not signed in yet: the app sends you to sign in; a forged link doesn't work.
  const signedOut = await fetch(`${base}/app`, { redirect: "manual" });
  assert.equal(signedOut.status, 302);
  assert.equal(signedOut.headers.get("location"), "/login?next=%2Fapp");
  assert.equal((await fetch(`${base}/join/forged`)).status, 404);

  // The invite link opens a form to create a login; it doesn't sign you in by itself.
  const form = await fetch(base + link, { redirect: "manual" });
  assert.equal(form.status, 200);
  assert.equal(form.headers.get("set-cookie"), null);
  assert.match(await form.text(), /Create your login|Welcome, Web/);
  const userCookie = await createLogin(link, "web@example.com", "correct horse battery");

  const page = await fetch(`${base}/app`, { headers: { Cookie: userCookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Web Only/);

  // Uploads are restricted to photos, PDFs and text.
  const bad = await fetch(`${base}/app/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userCookie },
    body: JSON.stringify({ text: "hi", files: [{ type: "text/html", data: Buffer.from("<b>x</b>").toString("base64") }] }),
  });
  assert.equal(bad.status, 400);

  const pdf = Buffer.from("%PDF-1.4 quote").toString("base64");
  const sent = await fetch(`${base}/app/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userCookie },
    body: JSON.stringify({ text: "Call Acme about this quote", files: [{ type: "application/pdf", data: pdf }] }),
  });
  assert.equal(sent.status, 200);

  // The agent model errors in tests, so the agent answers with an apology.
  let state: any;
  for (let i = 0; i < 100; i++) {
    state = await (await fetch(`${base}/app/api/state`, { headers: { Cookie: userCookie } })).json();
    if (!state.busy && state.messages.length >= 2) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(state.messages[0].role, "user");
  assert.equal(state.messages[0].body, "Call Acme about this quote");
  assert.equal(state.messages[0].files[0].type, "application/pdf");
  assert.equal(state.messages[1].role, "assistant");
  assert.match(state.messages[1].body, /something went wrong/);

  // Their file is theirs alone.
  const fileId = state.messages[0].files[0].id;
  assert.equal((await fetch(`${base}/app/files/${fileId}`, { headers: { Cookie: userCookie } })).status, 200);

  // The invite link was used up when the login was created.
  assert.equal((await fetch(base + link)).status, 404);
});

/** Fill in an invite or reset link's form; returns the signed-in cookie. */
async function createLogin(link: string, email: string, password: string, confirm = password, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(base + link, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ email, password, confirm }),
  });
  assert.equal(res.status, 302, await res.text());
  assert.equal(res.headers.get("location"), "/app");
  return res.headers.get("set-cookie")!.split(";")[0];
}

async function signIn(email: string, password: string, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...extra },
    body: new URLSearchParams({ email, password, next: "/app" }),
  });
}

test("invite-only login: create from invite, sign in, change password, reset", { skip: !enabled }, async () => {
  const admin = await login();
  const invite = await fetch(`${base}/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: admin },
    body: new URLSearchParams({ name: "Sam Login", phone: "" }),
  });
  const link = /https:\/\/agent\.test(\/join\/[A-Za-z0-9_-]+)/.exec(await invite.text())![1];

  // There's no public sign-up: only the invite form can create a login.
  assert.equal((await fetch(`${base}/signup`)).status, 404);

  // The form validates input and keeps emails unique.
  const short = await fetch(base + link, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "sam@example.com", password: "short", confirm: "short" }),
  });
  assert.equal(short.status, 400);
  assert.match(await short.text(), /at least 10 characters/);
  await db.query("INSERT INTO users (name, email) VALUES ('Someone Else', 'taken@example.com')");
  const taken = await fetch(base + link, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "TAKEN@example.com", password: "a long password", confirm: "a long password" }),
  });
  assert.match(await taken.text(), /already used/);
  const crossSite = await fetch(base + link, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example" },
    body: new URLSearchParams({ email: "sam@example.com", password: "a long password", confirm: "a long password" }),
  });
  assert.equal(crossSite.status, 403);

  // Browsers send an Origin header on form posts; our own origin is accepted.
  const page = await fetch(base + link);
  assert.equal(page.headers.get("referrer-policy"), "same-origin");
  const first = await createLogin(link, " Sam@Example.com ", "first password 123", undefined, { Origin: "https://agent.test" });
  const row = (await db.query("SELECT email, password_hash, login_token_hash FROM users WHERE name = 'Sam Login'"))[0];
  assert.equal(row.email, "sam@example.com");
  assert.match(row.password_hash, /^scrypt\$/);
  assert.doesNotMatch(row.password_hash, /first password/);
  assert.equal(row.login_token_hash, null);

  // Sign in from another device; wrong passwords and other sites are refused.
  assert.equal((await signIn("sam@example.com", "wrong password")).status, 401);
  assert.equal((await signIn("nobody@example.com", "first password 123")).status, 401);
  assert.equal((await signIn("sam@example.com", "first password 123", { Origin: "https://evil.example" })).status, 403);
  const ok = await signIn("SAM@example.com", "first password 123");
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get("location"), "/app");
  const second = ok.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await fetch(`${base}/app/api/state`, { headers: { Cookie: second } })).status, 200);

  // Off-site redirects after sign-in are ignored.
  const sneaky = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "sam@example.com", password: "first password 123", next: "//evil.example/app" }),
  });
  assert.equal(sneaky.headers.get("location"), "/app");

  // Changing the password needs the current one, keeps this device, signs out others.
  const account = (body: Record<string, string>, cookie: string) =>
    fetch(`${base}/app/account`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams(body),
    });
  const wrongCurrent = await account({ current: "nope nope nope", password: "second password 456", confirm: "second password 456" }, second);
  assert.match(await wrongCurrent.text(), /Your current password isn&#39;t right/);
  const changed = await account({ current: "first password 123", password: "second password 456", confirm: "second password 456" }, second);
  assert.match(await changed.text(), /Password changed/);
  const kept = changed.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await fetch(`${base}/app/api/state`, { headers: { Cookie: kept } })).status, 200);
  assert.equal((await fetch(`${base}/app/api/state`, { headers: { Cookie: first } })).status, 401);
  assert.equal((await signIn("sam@example.com", "first password 123")).status, 401);
  assert.equal((await signIn("sam@example.com", "second password 456")).status, 302);

  // Admin reset link: signs them out everywhere; the link sets a new password once.
  const users = await (await fetch(`${base}/admin/users`, { headers: { Cookie: admin } })).text();
  assert.match(users, /sam@example\.com/);
  assert.match(users, /Reset link/);
  const userId = (await db.query("SELECT id FROM users WHERE name = 'Sam Login'"))[0].id;
  const resetPage = await (await fetch(`${base}/admin/users/${userId}/link`, { method: "POST", headers: { Cookie: admin } })).text();
  assert.match(resetPage, /Password reset link/);
  const resetLink = /https:\/\/agent\.test(\/join\/[A-Za-z0-9_-]+)/.exec(resetPage)![1];
  assert.equal((await fetch(`${base}/app/api/state`, { headers: { Cookie: kept } })).status, 401);
  assert.match(await (await fetch(base + resetLink)).text(), /Set a new password/);
  await createLogin(resetLink, "sam@example.com", "third password 789");
  assert.equal((await signIn("sam@example.com", "third password 789")).status, 302);
  assert.equal((await fetch(base + resetLink)).status, 404);

  // Disabled users can't sign in.
  await fetch(`${base}/admin/users/${userId}/toggle`, { method: "POST", headers: { Cookie: admin } });
  assert.equal((await signIn("sam@example.com", "third password 789")).status, 401);
});

test("repeated failed sign-ins are throttled", { skip: !enabled }, async () => {
  let last: Response | undefined;
  for (let i = 0; i < 11; i++) last = await signIn("throttle@example.com", `wrong ${i}`);
  assert.equal(last!.status, 429);
  assert.match(await last!.text(), /Too many attempts/);
});

test("admin settings control greetings, hours, time limit and the calls switch", { skip: !enabled }, async () => {
  const cookie = await login();
  const form = (fields: Record<string, string>) =>
    fetch(`${base}/admin/settings`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams(fields),
    });
  const valid = {
    greetingOutbound: "Hello {recipient}, {agent} here, an AI assistant for {requester}. This call is recorded.",
    greetingUserInbound: "Hey {caller}! {agent} here. This call is recorded.",
    greetingCallback: "Hi, {agent}, AI assistant for {requester}. This call is recorded.",
    contactHoursStart: "9",
    contactHoursEnd: "17",
    timezone: "America/Chicago",
    maxCallMinutes: "5",
  };

  // Greetings must keep the recording disclosure.
  const bad = await form({ ...valid, greetingUserInbound: "Hey {caller}!" });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /must say the call is recorded/);
  assert.equal((await form({ ...valid, contactHoursStart: "18" })).status, 400);
  assert.equal((await form({ ...valid, timezone: "Mars/Olympus" })).status, 400);

  assert.equal((await form(valid)).status, 302);
  const page = await (await fetch(`${base}/admin/settings`, { headers: { Cookie: cookie } })).text();
  assert.match(page, /America\/Chicago/);
  assert.match(page, /value="5"/);

  // The custom greeting is what Twilio plays to an invited caller.
  const call = await (await twilioPost("/twilio/voice", { From: "+14155552671", CallSid: "CAgreet" })).text();
  assert.match(call, /<Say[^>]*>Hey Pat! Tuah here\. This call is recorded\.<\/Say>/);

  // Calls off: callers are turned away, the chat agent is told, and a banner shows.
  const off = await fetch(`${base}/admin/settings/calls`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: "enabled=0",
  });
  assert.match(await off.text(), /Calls are off/);
  const rejected = await (await twilioPost("/twilio/voice", { From: "+14155552671", CallSid: "CAoff" })).text();
  assert.match(rejected, /isn't taking calls right now/);
  assert.doesNotMatch(rejected, /<Stream/);
  const admin = await (await fetch(`${base}/admin/conversations`, { headers: { Cookie: cookie } })).text();
  assert.match(admin, /Calls are turned off/);

  await fetch(`${base}/admin/settings/calls`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: "enabled=1",
  });
  const back = await (await twilioPost("/twilio/voice", { From: "+14155552671", CallSid: "CAon" })).text();
  assert.match(back, /<Stream/);
});

test("an answered outbound call plays the configured greeting, unless calls were turned off", { skip: !enabled }, async () => {
  const cookie = await login();
  const user = (await db.query("SELECT * FROM users WHERE phone = '+14155552671'"))[0];
  const task = (
    await db.query(
      "INSERT INTO tasks (user_id, kind, target_phone, target_name, objective, status) VALUES ($1, 'call', '+14155550123', 'Mike', 'Quote status', 'in_progress') RETURNING *",
      [user.id],
    )
  )[0];
  const conversation = (
    await db.query(
      "INSERT INTO conversations (kind, user_id, task_id, counterpart_phone, direction, call_sid) VALUES ('task_call', $1, $2, '+14155550123', 'outbound', 'CAout') RETURNING *",
      [user.id, task.id],
    )
  )[0];
  const path = `/twilio/voice/answered/${conversation.id}`;

  // Another call can't use this conversation's instructions.
  assert.match(await (await twilioPost(path, { CallSid: "CAother" })).text(), /<Hangup\/>/);

  const xml = await (await twilioPost(path, { CallSid: "CAout" })).text();
  assert.match(xml, /<Say[^>]*>Hello Mike, Tuah here, an AI assistant for Pat Example\. This call is recorded\.<\/Say>/);
  assert.match(xml, /<Stream url="wss:\/\/agent\.test\/twilio\/stream">/);

  // GPT-Live was started while the greeting played; once the stream attaches
  // (greeting over), it is told to keep talking instead of waiting for "hello?".
  const before = liveConnections.length;
  await new Promise((r) => setTimeout(r, 300));
  const live = liveConnections[liveConnections.length - 1];
  assert.ok(liveConnections.length >= before && live.received[0]?.type === "session.start");
  assert.match(live.received[0].session.instructions, /keep talking without waiting for a reply/);
  live.ws.send(JSON.stringify({ type: "session.started", event_id: "s1", session: { id: "sess_out", model: "gpt-live-1", status: "active", expires_at: 0 } }));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!live.received.some((e) => e.type === "session.commentary.append"), "nothing is said while the greeting plays");

  const token = /<Parameter name="token" value="([^"]+)"/.exec(xml)![1];
  const stream = new WebSocket(`${base.replace("http", "ws")}/twilio/stream`);
  await new Promise((resolve) => stream.on("open", resolve));
  stream.send(JSON.stringify({ event: "start", streamSid: "MZout", start: { streamSid: "MZout", callSid: "CAout", customParameters: { token } } }));
  for (let i = 0; i < 50 && !live.received.some((e) => e.type === "session.commentary.append"); i++) await new Promise((r) => setTimeout(r, 50));
  const kickoff = live.received.find((e) => e.type === "session.commentary.append");
  assert.ok(kickoff, "GPT-Live is prompted to speak first");
  assert.equal(kickoff.delegation_id, null);
  assert.match(kickoff.content, /Quote status/);
  stream.close();

  await fetch(`${base}/admin/settings/calls`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: "enabled=0",
  });
  assert.match(await (await twilioPost(path, { CallSid: "CAout" })).text(), /^<Response><Hangup\/><\/Response>$/);
  await fetch(`${base}/admin/settings/calls`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: "enabled=1",
  });
});

test("numbers panel: call-back toggles, clearing locks them, calling again unlocks, clearing chat keeps admin history", { skip: !enabled }, async () => {
  const { recordCalledNumber } = await import("../src/numbers.js");
  const admin = await login();
  const invite = await fetch(`${base}/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: admin },
    body: new URLSearchParams({ name: "Nora Numbers", phone: "" }),
  });
  const link = /https:\/\/agent\.test(\/join\/[A-Za-z0-9_-]+)/.exec(await invite.text())![1];
  const cookie = await createLogin(link, "nora@example.com", "nora password 1");
  const user = (await db.query("SELECT * FROM users WHERE email = 'nora@example.com'"))[0];

  // Two numbers the agent called for Nora.
  const A = "+14155550301";
  const B = "+14155550302";
  for (const [phone, name] of [[A, "Bakery"], [B, "Plumber"]]) {
    await db.query("INSERT INTO tasks (user_id, kind, target_phone, target_name, objective, status) VALUES ($1, 'call', $2, $3, 'Ask a question', 'completed')", [user.id, phone, name]);
    await recordCalledNumber(user.id, phone, name);
  }
  const api = (path: string, body: object = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
  const state = async () => (await fetch(`${base}/app/api/state`, { headers: { Cookie: cookie } })).json();
  const callFrom = async (from: string, sid: string) => (await twilioPost("/twilio/voice", { From: from, CallSid: sid })).text();

  let s = await state();
  assert.deepEqual(s.numbers.map((n: any) => [n.name, n.callbackAllowed]), [["Plumber", true], ["Bakery", true]]);
  const idOf = (name: string) => s.numbers.find((n: any) => n.name === name).id;
  const bakery = idOf("Bakery");
  const plumber = idOf("Plumber");

  // Allowed numbers get through when they call back; turned-off ones don't.
  assert.match(await callFrom(A, "CAnum1"), /<Stream/);
  assert.equal((await api(`/app/api/numbers/${bakery}`, { allowed: false })).status, 200);
  assert.match(await callFrom(A, "CAnum2"), /only takes calls from invited users/);
  assert.match(await callFrom(B, "CAnum3"), /<Stream/);
  // Other users' numbers can't be toggled.
  const otherUser = (await db.query("INSERT INTO users (name) VALUES ('Other Person') RETURNING id"))[0];
  const other = (await db.query("INSERT INTO user_numbers (user_id, phone) VALUES ($1, '+14155550399') RETURNING id", [otherUser.id]))[0];
  assert.equal((await api(`/app/api/numbers/${other.id}`, { allowed: true })).status, 404);

  // Clearing the list: gone from Nora's view, locked off, still visible to the admin.
  assert.equal((await api("/app/api/numbers/clear")).status, 200);
  s = await state();
  assert.deepEqual(s.numbers, []);
  assert.match(await callFrom(B, "CAnum4"), /only takes calls from invited users/);
  assert.equal((await api(`/app/api/numbers/${plumber}`, { allowed: true })).status, 404);
  const adminToggle = await fetch(`${base}/admin/numbers/${plumber}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: admin },
    body: "allowed=1",
  });
  assert.equal(adminToggle.status, 409);
  const adminPage = await (await fetch(`${base}/admin/numbers`, { headers: { Cookie: admin } })).text();
  assert.match(adminPage, /Plumber/);
  assert.match(adminPage, /Locked off/);
  assert.match(adminPage, /Removed from their list/);

  // Nora asks the agent to call the plumber again: back on her list, call-back on.
  await recordCalledNumber(user.id, B, "");
  s = await state();
  assert.deepEqual(s.numbers.map((n: any) => [n.name, n.callbackAllowed]), [["Plumber", true]]);
  assert.match(await callFrom(B, "CAnum5"), /<Stream/);
  // The bakery stays locked: only calling it again would unlock it.
  assert.match(await callFrom(A, "CAnum6"), /only takes calls from invited users/);

  // Clear chat: fresh thread, calls and numbers gone for Nora, all kept for the admin.
  await api("/app/api/messages", { text: "Call the plumber again tomorrow" });
  for (let i = 0; i < 50 && (await state()).messages.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  const oldConversation = (await db.query("SELECT id FROM conversations WHERE user_id = $1 AND kind = 'user_web' AND cleared_at IS NULL", [user.id]))[0].id;
  const oldTask = (await db.query("SELECT id FROM tasks WHERE user_id = $1 LIMIT 1", [user.id]))[0].id;
  assert.equal((await fetch(`${base}/app/tasks/${oldTask}`, { headers: { Cookie: cookie } })).status, 200);

  assert.equal((await api("/app/api/chat/clear")).status, 200);
  s = await state();
  assert.deepEqual(s.messages, []);
  assert.deepEqual(s.tasks, []);
  assert.deepEqual(s.numbers, []);
  assert.match(await callFrom(B, "CAnum7"), /only takes calls from invited users/);
  assert.equal((await fetch(`${base}/app/tasks/${oldTask}`, { headers: { Cookie: cookie } })).status, 404);

  const kept = await db.query("SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1", [oldConversation]);
  assert.ok(kept[0].n >= 2, "old chat is kept");
  const adminChat = await (await fetch(`${base}/admin/conversations/${oldConversation}`, { headers: { Cookie: admin } })).text();
  assert.match(adminChat, /Call the plumber again tomorrow/);
  assert.match(adminChat, /Cleared by the user/);

  // New messages go to a fresh thread.
  await api("/app/api/messages", { text: "Hello again" });
  for (let i = 0; i < 50 && (await state()).messages.length < 1; i++) await new Promise((r) => setTimeout(r, 50));
  s = await state();
  assert.equal(s.messages[0].body, "Hello again");
});

test("recordings are copied to our database, then deleted from Twilio; failures are retried", { skip: !enabled }, async () => {
  const { sweepRecordings } = await import("../src/recordings.js");
  const admin = await login();
  const conversation = (
    await db.query("INSERT INTO conversations (kind, counterpart_phone, direction, call_sid) VALUES ('task_call', '+14155550400', 'outbound', 'CArec') RETURNING id")
  )[0];
  const audio = Buffer.alloc(3000, 7);
  twilioRecordings.set("RE1", audio);
  const stored = async (sid: string) => (await db.query("SELECT length(data) AS size, twilio_deleted_at FROM recordings WHERE recording_sid = $1", [sid]))[0];
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(await check());
  };

  await twilioPost("/twilio/voice/recording", { CallSid: "CArec", RecordingSid: "RE1", RecordingDuration: "12", RecordingStatus: "completed" });
  await waitFor(async () => !!(await stored("RE1"))?.twilio_deleted_at);
  assert.equal((await stored("RE1")).size, 3000);
  assert.ok(!twilioRecordings.has("RE1"), "deleted from Twilio");

  // Playback now comes from our copy (Twilio no longer has it), and supports seeking.
  const full = await fetch(`${base}/admin/recordings/${conversation.id}.mp3`, { headers: { Cookie: admin } });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), audio);
  const part = await fetch(`${base}/admin/recordings/${conversation.id}.mp3`, { headers: { Cookie: admin, Range: "bytes=100-199" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 100-199/3000");
  assert.equal((await part.arrayBuffer()).byteLength, 100);

  // A failed delete keeps our copy and is retried by the sweeper.
  await db.query("INSERT INTO conversations (kind, counterpart_phone, direction, call_sid) VALUES ('task_call', '+14155550401', 'outbound', 'CArec2')");
  twilioRecordings.set("RE2", Buffer.alloc(500, 1));
  failNextDelete = true;
  await twilioPost("/twilio/voice/recording", { CallSid: "CArec2", RecordingSid: "RE2", RecordingDuration: "3", RecordingStatus: "completed" });
  await waitFor(async () => !!(await stored("RE2")));
  assert.equal((await stored("RE2")).twilio_deleted_at, null);
  assert.ok(twilioRecordings.has("RE2"), "still on Twilio after the failed delete");
  await sweepRecordings();
  assert.ok((await stored("RE2")).twilio_deleted_at);
  assert.ok(!twilioRecordings.has("RE2"));

  // A failed download deletes nothing; the sweeper copies it once it's available.
  await db.query("INSERT INTO conversations (kind, counterpart_phone, direction, call_sid) VALUES ('task_call', '+14155550402', 'outbound', 'CArec3')");
  const deletesBefore = twilioDeletes.length;
  await twilioPost("/twilio/voice/recording", { CallSid: "CArec3", RecordingSid: "RE3", RecordingDuration: "3", RecordingStatus: "completed" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await stored("RE3"), undefined);
  assert.equal(twilioDeletes.length, deletesBefore, "nothing deleted without a saved copy");
  twilioRecordings.set("RE3", Buffer.alloc(800, 2));
  await sweepRecordings();
  assert.equal((await stored("RE3")).size, 800);
  assert.ok(!twilioRecordings.has("RE3"));
});
