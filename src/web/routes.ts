import express from "express";
import { fmtDate } from "../admin/views.js";
import { listMessages, query, queryOne, type Attachment, type Conversation, type Task } from "../db/index.js";
import { formatPhone } from "../phone.js";
import { getSettings } from "../settings.js";
import { clearChat, clearUserNumbers, listUserNumbers, setCallbackAllowed } from "../numbers.js";
import { recentTasks, userChatConversation, visibleTask } from "../tasks.js";
import { fetchRecording } from "../twilio.js";
import {
  changePassword,
  checkLogin,
  clearUserCookie,
  completeInvite,
  currentUser,
  emailTaken,
  fromOurSite,
  requireUser,
  setUserCookie,
  Throttle,
  userForInviteToken,
} from "./auth.js";
import { normalizeEmail, passwordProblem } from "./passwords.js";
import { ALLOWED_UPLOAD_TYPES, isBusy, MAX_UPLOAD_BYTES, MAX_UPLOADS_PER_MESSAGE, postUserMessage, type Upload } from "./chat.js";
import { accountPage, callPage, chatPage, invitePage, loginPage, simplePage } from "./pages.js";

export const webRouter = express.Router();

const INVALID_LINK = simplePage(
  "Link not valid",
  "This link has already been used or was replaced. If you already created a login, sign in at /login; otherwise ask for a new link.",
);

/** Only redirect back into the app after sign-in, never off-site. */
function safeNext(raw: unknown): string {
  const next = String(raw ?? "");
  return /^\/app(\/|\?|$)/.test(next) && !next.startsWith("//") ? next : "/app";
}

// Failed sign-in attempts: per IP and per email, 10 per 15 minutes.
const loginThrottle = new Throttle(10, 15 * 60 * 1000);

// ---- Invite and reset links ------------------------------------------------

webRouter.get("/join/:token", async (req, res) => {
  const user = await userForInviteToken(req.params.token);
  if (!user) return void res.status(404).send(INVALID_LINK);
  // Links carry the secret in the URL; keep it out of other sites' referrers and caches.
  // ("no-referrer" would make browsers send Origin: null on the form post.)
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  res.send(invitePage(user, req.params.token));
});

webRouter.post("/join/:token", async (req, res) => {
  if (!fromOurSite(req)) return void res.sendStatus(403);
  const token = req.params.token;
  const user = await userForInviteToken(token);
  if (!user) return void res.status(404).send(INVALID_LINK);
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  const rawEmail = String(req.body.email ?? "");
  const email = normalizeEmail(rawEmail);
  const problem = !email
    ? "Enter a valid email address."
    : (await emailTaken(email, user.id))
      ? "That email is already used by another account."
      : passwordProblem(String(req.body.password ?? ""), String(req.body.confirm ?? ""));
  if (problem) return void res.status(400).send(invitePage(user, token, { error: problem, email: rawEmail }));
  const updated = await completeInvite(user.id, email!, String(req.body.password));
  setUserCookie(res, updated);
  res.redirect("/app");
});

// ---- Sign in ---------------------------------------------------------------

webRouter.get("/login", async (req, res) => {
  if (await currentUser(req)) return void res.redirect(safeNext(req.query.next));
  res.send(loginPage({ next: safeNext(req.query.next), notice: req.query.out !== undefined ? "You're signed out." : undefined }));
});

webRouter.post("/login", async (req, res) => {
  if (!fromOurSite(req)) return void res.sendStatus(403);
  const ip = req.ip ?? "unknown";
  const rawEmail = String(req.body.email ?? "");
  const email = normalizeEmail(rawEmail) ?? rawEmail.trim().toLowerCase();
  const next = safeNext(req.body.next);
  if (loginThrottle.blocked(`ip:${ip}`) || loginThrottle.blocked(`email:${email}`)) {
    return void res.status(429).send(loginPage({ email: rawEmail, next, error: "Too many attempts. Try again in 15 minutes." }));
  }
  const user = await checkLogin(email, String(req.body.password ?? ""));
  if (!user) {
    loginThrottle.fail(`ip:${ip}`);
    loginThrottle.fail(`email:${email}`);
    return void res.status(401).send(loginPage({ email: rawEmail, next, error: "That email and password don't match." }));
  }
  loginThrottle.reset(`email:${email}`);
  setUserCookie(res, user);
  res.redirect(next);
});

webRouter.use("/app", requireUser);
webRouter.use("/app/api", express.json({ limit: "45mb" }));

webRouter.get("/app", (req, res) => res.send(chatPage(req.user!)));

webRouter.post("/app/logout", (_req, res) => {
  clearUserCookie(res);
  res.redirect("/login?out");
});

// ---- Account ----------------------------------------------------------------

webRouter.get("/app/account", (req, res) => res.send(accountPage(req.user!)));

webRouter.post("/app/account", async (req, res) => {
  const user = req.user!;
  const password = String(req.body.password ?? "");
  const confirm = String(req.body.confirm ?? "");
  let email = user.email;
  if (user.password_hash) {
    const throttleKey = `account:${user.id}`;
    if (loginThrottle.blocked(throttleKey)) {
      return void res.status(429).send(accountPage(user, { error: "Too many attempts. Try again in 15 minutes." }));
    }
    if (!(await checkLogin(user.email ?? "", String(req.body.current ?? "")))) {
      loginThrottle.fail(throttleKey);
      return void res.status(400).send(accountPage(user, { error: "Your current password isn't right." }));
    }
  } else {
    email = normalizeEmail(String(req.body.email ?? ""));
    if (!email) return void res.status(400).send(accountPage(user, { error: "Enter a valid email address." }));
    if (await emailTaken(email, user.id)) return void res.status(400).send(accountPage(user, { error: "That email is already used by another account." }));
  }
  const problem = passwordProblem(password, confirm);
  if (problem) return void res.status(400).send(accountPage(user, { error: problem }));
  const updated = user.password_hash ? await changePassword(user.id, password) : await completeInvite(user.id, email!, password);
  // This device stays signed in; other devices are signed out.
  setUserCookie(res, updated);
  res.send(accountPage(updated, { notice: user.password_hash ? "Password changed." : "Login created. You can now sign in from any device." }));
});

/** Chat messages after `after`, the user's recent calls, and whether a reply is pending. */
webRouter.get("/app/api/state", async (req, res) => {
  const user = req.user!;
  const after = Number(req.query.after ?? 0) || 0;
  const conversation = await userChatConversation(user);
  const messages = await query<{ id: number; role: string; body: string; created_at: Date }>(
    `SELECT id, role, body, created_at FROM messages
     WHERE conversation_id = $1 AND id > $2 AND role IN ('user', 'assistant') ORDER BY id LIMIT 200`,
    [conversation.id, after],
  );
  const files = await query<{ id: number; message_id: number; content_type: string }>(
    "SELECT id, message_id, content_type FROM attachments WHERE message_id = ANY($1)",
    [messages.map((m) => m.id)],
  );
  const tasks = await recentTasks(user.id, 15);
  const numbers = await listUserNumbers(user.id);
  res.json({
    busy: isBusy(user.id),
    callsEnabled: (await getSettings()).callsEnabled,
    messages: messages.map((m) => ({
      ...m,
      time: fmtDate(m.created_at),
      files: files.filter((f) => f.message_id === m.id).map((f) => ({ id: f.id, type: f.content_type })),
    })),
    numbers: numbers.map((n) => ({
      id: n.id,
      name: n.name,
      phone: formatPhone(n.phone),
      callbackAllowed: n.callback_allowed,
      lastCalled: fmtDate(n.last_called_at),
    })),
    tasks: tasks.map((t) => ({
      id: t.id,
      who: t.target_name || formatPhone(t.target_phone),
      status: t.status,
      objective: t.objective,
      time: fmtDate(t.created_at),
    })),
  });
});

/** Clear the user's number list: hidden from them, and call-backs off until they call a number again. */
webRouter.post("/app/api/numbers/clear", async (req, res) => {
  res.json({ ok: true, cleared: await clearUserNumbers(req.user!.id) });
});

/** Allow or stop call-backs from one of the user's numbers. */
webRouter.post("/app/api/numbers/:id", async (req, res) => {
  const result = await setCallbackAllowed(Number(req.params.id), req.body?.allowed === true, req.user!.id);
  if (result === "not_found") return void res.status(404).json({ error: "That number isn't on your list." });
  res.json({ ok: true });
});

/** Start a fresh chat. The old one is kept for the admin; the number list is cleared too. */
webRouter.post("/app/api/chat/clear", async (req, res) => {
  await clearChat(req.user!);
  res.json({ ok: true });
});

webRouter.post("/app/api/messages", async (req, res) => {
  const text = String(req.body?.text ?? "").trim().slice(0, 8000);
  const rawFiles: unknown[] = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!text && !rawFiles.length) return void res.status(400).json({ error: "Type a message or attach a file." });
  if (rawFiles.length > MAX_UPLOADS_PER_MESSAGE) {
    return void res.status(400).json({ error: `Attach at most ${MAX_UPLOADS_PER_MESSAGE} files at a time.` });
  }
  const uploads: Upload[] = [];
  for (const f of rawFiles as Array<{ type?: unknown; data?: unknown }>) {
    const contentType = String(f?.type ?? "");
    if (!ALLOWED_UPLOAD_TYPES.has(contentType)) {
      return void res.status(400).json({ error: "Only photos (JPEG, PNG, GIF, WebP), PDFs and text files can be attached." });
    }
    const data = Buffer.from(String(f?.data ?? ""), "base64");
    if (!data.length || data.length > MAX_UPLOAD_BYTES) return void res.status(400).json({ error: "Each file must be under 10 MB." });
    uploads.push({ contentType, data });
  }
  await postUserMessage(req.user!, text, uploads);
  res.json({ ok: true });
});

const INLINE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"]);

webRouter.get("/app/files/:id", async (req, res) => {
  const file = await queryOne<Attachment>(
    `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id JOIN conversations c ON c.id = m.conversation_id
     WHERE a.id = $1 AND c.user_id = $2 AND c.kind = 'user_web' AND c.cleared_at IS NULL`,
    [Number(req.params.id), req.user!.id],
  );
  if (!file) return void res.sendStatus(404);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox");
  res.type(INLINE_TYPES.has(file.content_type) ? file.content_type : "text/plain");
  res.send(file.data);
});

/** Transcript and recording of the calls made for one of the user's tasks. */
webRouter.get("/app/tasks/:id", async (req, res) => {
  const task = await visibleTask(req.user!.id, Number(req.params.id));
  if (!task) return void res.status(404).send(simplePage("Not found", "That call doesn't exist."));
  const calls = await query<Conversation>("SELECT * FROM conversations WHERE task_id = $1 ORDER BY id", [task.id]);
  const transcripts = await Promise.all(calls.map(async (c) => ({ call: c, lines: await listMessages(c.id) })));
  res.send(callPage(task, transcripts));
});

webRouter.get("/app/recordings/:id.mp3", async (req, res) => {
  const call = await queryOne<Conversation>(
    "SELECT * FROM conversations WHERE id = $1",
    [Number(req.params.id)],
  );
  if (!call?.task_id || !(await visibleTask(req.user!.id, call.task_id))) return void res.sendStatus(404);
  if (!call?.recording_sid) return void res.sendStatus(404);
  const upstream = await fetchRecording(call.recording_sid);
  if (!upstream.ok) return void res.sendStatus(502);
  res.type("audio/mpeg").send(Buffer.from(await upstream.arrayBuffer()));
});

