import express from "express";
import { config } from "../config.js";
import { listMessages, pool, query, queryOne, type Attachment, type Conversation, type Task, type User, type UserNumber } from "../db/index.js";
import { formatPhone, toE164 } from "../phone.js";
import { issueInviteLink } from "../web/auth.js";
import { setCallbackAllowed } from "../numbers.js";
import { fetchRecording } from "../twilio.js";
import {
  checkPassword,
  clearSessionCookie,
  loginThrottled,
  recordFailedLogin,
  requireAdmin,
  setSessionCookie,
} from "./auth.js";
import { esc, fmtDate, layout, loginPage, setCallsEnabledBanner } from "./views.js";
import { DEFAULT_SETTINGS, GREETING_PLACEHOLDERS, getSettings, saveSettings, validateSettings, type Settings } from "../settings.js";
import { twilioClient } from "../twilio.js";

export const adminRouter = express.Router();

adminRouter.get("/admin/login", (_req, res) => res.send(loginPage()));

adminRouter.post("/admin/login", (req, res) => {
  const ip = req.ip ?? "unknown";
  if (loginThrottled(ip)) return res.status(429).send(loginPage("Too many attempts. Try again in 15 minutes."));
  if (!checkPassword(String(req.body.password ?? ""))) {
    recordFailedLogin(ip);
    return res.status(401).send(loginPage("Wrong password."));
  }
  setSessionCookie(res);
  res.redirect("/admin/conversations");
});

adminRouter.post("/admin/logout", (_req, res) => {
  clearSessionCookie(res);
  res.redirect("/admin/login");
});

adminRouter.use("/admin", requireAdmin);
adminRouter.use("/admin", async (_req, _res, next) => {
  setCallsEnabledBanner((await getSettings()).callsEnabled);
  next();
});

adminRouter.get("/admin", (_req, res) => res.redirect("/admin/conversations"));

const KIND_LABELS: Record<string, string> = {
  user_web: "Web chat",
  user_sms: "User texts",
  user_call: "User call",
  task_call: "Task call",
  task_sms: "Task texts",
  unknown_sms: "Inbound texts",
  unknown_call: "Unknown call",
};

function statusClass(status: string | null): string {
  if (!status) return "";
  if (["completed", "in-progress"].includes(status)) return "ok";
  if (["failed", "busy", "no-answer", "canceled", "cancelled"].includes(status)) return "bad";
  return "";
}

// ---- Conversations -------------------------------------------------------

adminRouter.get("/admin/conversations", async (req, res) => {
  const kind = typeof req.query.kind === "string" && KIND_LABELS[req.query.kind] ? req.query.kind : "";
  const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const params: unknown[] = [];
  const where: string[] = [];
  if (kind) {
    params.push(kind);
    where.push(`c.kind = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(c.counterpart_phone ILIKE $${params.length} OR u.name ILIKE $${params.length} OR t.target_name ILIKE $${params.length}
      OR EXISTS (SELECT 1 FROM messages s WHERE s.conversation_id = c.id AND s.body ILIKE $${params.length}))`);
  }
  const rows = await query<Conversation & { user_name: string | null; target_name: string | null; preview: string | null; message_count: number }>(
    `SELECT c.*, u.name AS user_name, t.target_name,
       (SELECT body FROM messages m WHERE m.conversation_id = c.id AND m.role <> 'event' ORDER BY id DESC LIMIT 1) AS preview,
       (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.role <> 'event') AS message_count
     FROM conversations c
     LEFT JOIN users u ON u.id = c.user_id
     LEFT JOIN tasks t ON t.id = c.task_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY c.last_activity_at DESC LIMIT 200`,
    params,
  );

  const options = Object.entries(KIND_LABELS)
    .map(([k, label]) => `<option value="${k}" ${k === kind ? "selected" : ""}>${label}</option>`)
    .join("");
  const table = rows.length
    ? `<table><tr><th>Last activity</th><th>Type</th><th>User</th><th>Other party</th><th>Latest</th><th>Lines</th></tr>
      ${rows
        .map(
          (c) => `<tr>
        <td class="small"><a href="/admin/conversations/${c.id}">${esc(fmtDate(c.last_activity_at))}</a></td>
        <td><span class="badge">${esc(KIND_LABELS[c.kind])}</span>${c.cleared_at ? ` <span class="badge" title="The user cleared this chat; it's kept here">cleared by user</span>` : ""}${c.recording_sid ? ` <span title="Recorded">🎙</span>` : ""}
          ${c.call_status ? `<div class="small ${statusClass(c.call_status)}">${esc(c.call_status)}</div>` : ""}</td>
        <td>${esc(c.user_name ?? "")}</td>
        <td>${c.kind.startsWith("user") ? "" : `${esc(c.target_name ?? "")} <span class="muted small">${esc(formatPhone(c.counterpart_phone))}</span>`}</td>
        <td class="small">${esc((c.summary || c.preview || "").slice(0, 140))}</td>
        <td>${c.message_count}</td></tr>`,
        )
        .join("")}</table>`
    : `<p class="muted">No conversations yet.</p>`;

  res.send(
    layout(
      "Transcripts",
      `<div class="card"><form class="row" method="get">
        <label>Type<select name="kind"><option value="">All</option>${options}</select></label>
        <label>Search<input name="q" value="${esc(search)}" placeholder="Name, number or text"></label>
        <button>Filter</button></form></div>
       <div class="card">${table}</div>`,
      "/admin/conversations",
    ),
  );
});

adminRouter.get("/admin/conversations/:id", async (req, res) => {
  const id = Number(req.params.id);
  const c = await queryOne<Conversation & { user_name: string | null }>(
    "SELECT c.*, u.name AS user_name FROM conversations c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = $1",
    [id],
  );
  if (!c) return res.status(404).send(layout("Not found", "<p>Conversation not found.</p>"));
  const task = c.task_id ? await queryOne<Task>("SELECT * FROM tasks WHERE id = $1", [c.task_id]) : undefined;
  const messages = await listMessages(id, 5000);
  const attachments = await query<Omit<Attachment, "data">>(
    "SELECT id, message_id, content_type, created_at FROM attachments WHERE message_id = ANY($1)",
    [messages.map((m) => m.id)],
  );

  const otherLabel = c.kind.startsWith("user") ? c.user_name ?? "User" : task?.target_name || formatPhone(c.counterpart_phone);
  const transcript = messages
    .map((m) => {
      if (m.role === "event") return `<div class="event">${esc(m.body)} · ${esc(fmtDate(m.created_at))}</div>`;
      const who = m.role === "assistant" ? config.agent.name : m.role === "user" ? c.user_name ?? "User" : otherLabel;
      const files = attachments
        .filter((a) => a.message_id === m.id)
        .map((a) =>
          a.content_type.startsWith("image/")
            ? `<a href="/admin/attachments/${a.id}" target="_blank"><img class="att" src="/admin/attachments/${a.id}" alt="attachment"></a>`
            : `<div><a href="/admin/attachments/${a.id}" target="_blank">📎 ${esc(a.content_type)}</a></div>`,
        )
        .join("");
      return `<div class="msg ${m.role}"><div class="meta">${esc(who)} · ${esc(fmtDate(m.created_at))}</div>${esc(m.body)}${files}</div>`;
    })
    .join("");

  const info = [
    `<b>${esc(KIND_LABELS[c.kind])}</b> · ${c.direction} · ${esc(formatPhone(c.counterpart_phone))}`,
    c.cleared_at ? `<span class="muted">Cleared by the user ${esc(fmtDate(c.cleared_at))}. They no longer see it; it's kept here.</span>` : "",
    c.user_name ? `Invited user: ${esc(c.user_name)}` : "",
    c.call_status ? `Call status: <span class="${statusClass(c.call_status)}">${esc(c.call_status)}</span>` : "",
    `Started ${esc(fmtDate(c.started_at))}${c.ended_at ? ` · ended ${esc(fmtDate(c.ended_at))}` : ""}`,
    task
      ? `Task #${task.id} (${esc(task.status)}): ${esc(task.objective)}<details><summary class="small">Brief given to the agent</summary><pre style="white-space:pre-wrap">${esc(task.context)}</pre></details>`
      : "",
  ]
    .filter(Boolean)
    .map((line) => `<div>${line}</div>`)
    .join("");

  res.send(
    layout(
      `Conversation ${id}`,
      `<p><a href="/admin/conversations">← All transcripts</a></p>
       <div class="card">${info}
        ${c.recording_sid ? `<p><audio controls preload="none" src="/admin/recordings/${c.id}.mp3"></audio><span class="small muted">${c.recording_duration ?? "?"}s recording</span></p>` : ""}
        ${c.summary ? `<p><b>Summary:</b> ${esc(c.summary)}</p>` : ""}</div>
       <div class="card">${transcript || `<p class="muted">No messages.</p>`}</div>`,
      "/admin/conversations",
    ),
  );
});

adminRouter.get("/admin/recordings/:id.mp3", async (req, res) => {
  const c = await queryOne<Conversation>("SELECT * FROM conversations WHERE id = $1", [Number(req.params.id)]);
  if (!c?.recording_sid) return res.sendStatus(404);
  const upstream = await fetchRecording(c.recording_sid);
  if (!upstream.ok || !upstream.body) return res.sendStatus(502);
  res.type("audio/mpeg");
  res.send(Buffer.from(await upstream.arrayBuffer()));
});

const INLINE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"]);

adminRouter.get("/admin/attachments/:id", async (req, res) => {
  const a = await queryOne<Attachment>("SELECT * FROM attachments WHERE id = $1", [Number(req.params.id)]);
  if (!a) return res.sendStatus(404);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox");
  if (INLINE_TYPES.has(a.content_type)) {
    res.type(a.content_type);
  } else {
    res.type("application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="attachment-${a.id}"`);
  }
  res.send(a.data);
});

// ---- Tasks ---------------------------------------------------------------

adminRouter.get("/admin/tasks", async (_req, res) => {
  const tasks = await query<Task & { user_name: string; conversation_ids: number[] }>(
    `SELECT t.*, u.name AS user_name,
       ARRAY(SELECT id FROM conversations c WHERE c.task_id = t.id ORDER BY id) AS conversation_ids
     FROM tasks t JOIN users u ON u.id = t.user_id ORDER BY t.id DESC LIMIT 200`,
  );
  const rows = tasks
    .map(
      (t) => `<tr><td>#${t.id}<div class="small muted">${esc(fmtDate(t.created_at))}</div></td>
      <td>${esc(t.user_name)}</td><td><span class="badge">${t.kind}</span></td>
      <td>${esc(t.target_name)} <span class="small muted">${esc(formatPhone(t.target_phone))}</span></td>
      <td class="small">${esc(t.objective)}${t.result ? `<div class="muted">→ ${esc(t.result)}</div>` : ""}</td>
      <td class="${statusClass(t.status)}">${t.status}</td>
      <td>${t.conversation_ids.map((id) => `<a href="/admin/conversations/${id}">view</a>`).join(" ")}</td></tr>`,
    )
    .join("");
  res.send(
    layout(
      "Tasks",
      `<div class="card">${tasks.length ? `<table><tr><th>Task</th><th>Requested by</th><th>Kind</th><th>Recipient</th><th>Objective / result</th><th>Status</th><th></th></tr>${rows}</table>` : `<p class="muted">No tasks yet.</p>`}</div>`,
      "/admin/tasks",
    ),
  );
});

// ---- Users ---------------------------------------------------------------

adminRouter.get("/admin/users", async (req, res) => {
  const users = await query<User>("SELECT * FROM users ORDER BY name");
  const error = typeof req.query.error === "string" ? req.query.error : "";
  const rows = users
    .map(
      (u) => `<tr><td>${esc(u.name)}<div class="small ${u.password_hash ? "muted" : "bad"}">${
        u.password_hash ? esc(u.email ?? "") : u.login_token_hash ? "Invite not used yet" : "No login"
      }</div></td>
      <td><form method="post" action="/admin/users/${u.id}/details" class="row">
        <input name="phone" value="${esc(u.phone ? formatPhone(u.phone) : "")}" placeholder="Phone (optional)" size="14">
        <textarea name="notes" rows="2" cols="30" placeholder="Background the agent should know">${esc(u.notes)}</textarea><button>Save</button></form></td>
      <td class="${u.active ? "ok" : "bad"}">${u.active ? "Active" : "Disabled"}</td>
      <td><form class="inline" method="post" action="/admin/users/${u.id}/link" onsubmit="return confirm('${
        u.password_hash
          ? `Make a password reset link for ${esc(u.name)}? They are signed out everywhere until they use it.`
          : `Make a new invite link for ${esc(u.name)}? Any earlier link stops working.`
      }')"><button>${u.password_hash ? "Reset link" : "New invite link"}</button></form>
      <form class="inline" method="post" action="/admin/users/${u.id}/toggle"><button>${u.active ? "Disable" : "Enable"}</button></form>
      <form class="inline" method="post" action="/admin/users/${u.id}/delete" onsubmit="return confirm('Delete ${esc(u.name)}? Their tasks are deleted too; transcripts are kept.')"><button>Delete</button></form></td></tr>`,
    )
    .join("");
  res.send(
    layout(
      "Invited users",
      `<div class="card"><h3>Invite someone</h3>
       ${error ? `<p class="bad">${esc(error)}</p>` : ""}
       <form class="row" method="post" action="/admin/users">
        <label>Name<input name="name" required></label>
        <label>Phone (optional)<input name="phone" placeholder="(555) 123-4567"></label>
        <button class="primary">Create invite link</button></form>
       <p class="small muted">Invited people use the agent from a private web page. You'll get a one-time link to send them; they use it to create their login. There's no public sign-up.
       If you add their phone number, they can also call ${esc(formatPhone(config.twilio.phoneNumber))} to talk to the agent.</p></div>
       <div class="card">${users.length ? `<table><tr><th>Name and login</th><th>Phone and notes for the agent</th><th>Status</th><th></th></tr>${rows}</table>` : `<p class="muted">Nobody invited yet.</p>`}</div>`,
      "/admin/users",
    ),
  );
});

function inviteLinkPage(user: User, link: string): string {
  return layout(
    "Invite link",
    `<div class="card"><h3>${user.password_hash ? "Password reset link" : "Invite link"} for ${esc(user.name)}</h3>
     <p>Send this link to ${esc(user.name)}. ${
       user.password_hash
         ? "It lets them choose a new password."
         : "It lets them create their login (email and password), then they sign in at /login."
     } It works once and is shown only here, so send it privately: whoever opens it first gets the account.</p>
     <div class="row"><input id="link" value="${esc(link)}" readonly style="flex:1;min-width:260px">
     <button class="primary" onclick="navigator.clipboard.writeText(document.getElementById('link').value);this.textContent='Copied'">Copy</button></div>
     <p><a href="/admin/users">← Back to invited users</a></p></div>`,
    "/admin/users",
  );
}

/** Empty input clears the phone; anything else must be a valid number. */
function parseOptionalPhone(raw: unknown): { phone: string | null; error?: string } {
  const text = String(raw ?? "").trim();
  if (!text) return { phone: null };
  const phone = toE164(text);
  return phone ? { phone } : { phone: null, error: "That phone number isn't valid." };
}

adminRouter.post("/admin/users", async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  const { phone, error } = parseOptionalPhone(req.body.phone);
  if (!name || error) return res.redirect(`/admin/users?error=${encodeURIComponent(error ?? "Enter a name.")}`);
  const user = await queryOne<User>("INSERT INTO users (name, phone) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING RETURNING *", [name, phone]);
  if (!user) return res.redirect(`/admin/users?error=${encodeURIComponent("Someone with that phone number is already invited.")}`);
  res.send(inviteLinkPage(user, await issueInviteLink(user.id)));
});

adminRouter.post("/admin/users/:id/link", async (req, res) => {
  const user = await queryOne<User>("SELECT * FROM users WHERE id = $1", [Number(req.params.id)]);
  if (!user) return res.redirect("/admin/users");
  res.send(inviteLinkPage(user, await issueInviteLink(user.id)));
});

adminRouter.post("/admin/users/:id/toggle", async (req, res) => {
  // Disabling also signs them out of every device.
  await pool.query("UPDATE users SET active = NOT active, session_version = session_version + 1 WHERE id = $1", [Number(req.params.id)]);
  res.redirect("/admin/users");
});

adminRouter.post("/admin/users/:id/details", async (req, res) => {
  const { phone, error } = parseOptionalPhone(req.body.phone);
  if (error) return res.redirect(`/admin/users?error=${encodeURIComponent(error)}`);
  try {
    await pool.query("UPDATE users SET phone = $2, notes = $3 WHERE id = $1", [
      Number(req.params.id),
      phone,
      String(req.body.notes ?? "").slice(0, 4000),
    ]);
  } catch {
    return res.redirect(`/admin/users?error=${encodeURIComponent("Someone else already has that phone number.")}`);
  }
  res.redirect("/admin/users");
});

adminRouter.post("/admin/users/:id/delete", async (req, res) => {
  await pool.query("DELETE FROM users WHERE id = $1", [Number(req.params.id)]);
  res.redirect("/admin/users");
});

// ---- Blocked numbers -----------------------------------------------------

adminRouter.get("/admin/blocked", async (_req, res) => {
  const rows = await query<{ phone: string; reason: string; created_at: Date }>("SELECT * FROM blocked_numbers ORDER BY created_at DESC");
  res.send(
    layout(
      "Blocked numbers",
      `<div class="card"><h3>Block a number</h3><p class="small muted">The agent will never call a blocked number, and calls from it are not answered by the agent.</p>
       <form class="row" method="post" action="/admin/blocked">
        <label>Phone<input name="phone" required></label><label>Reason<input name="reason"></label><button class="primary">Block</button></form></div>
       <div class="card">${
         rows.length
           ? `<table><tr><th>Phone</th><th>Reason</th><th>Since</th><th></th></tr>${rows
               .map(
                 (r) => `<tr><td>${esc(formatPhone(r.phone))}</td><td>${esc(r.reason)}</td><td class="small">${esc(fmtDate(r.created_at))}</td>
             <td><form class="inline" method="post" action="/admin/blocked/delete"><input type="hidden" name="phone" value="${esc(r.phone)}"><button>Unblock</button></form></td></tr>`,
               )
               .join("")}</table>`
           : `<p class="muted">No blocked numbers.</p>`
       }</div>`,
      "/admin/blocked",
    ),
  );
});

adminRouter.post("/admin/blocked", async (req, res) => {
  const phone = toE164(String(req.body.phone ?? ""));
  if (phone) {
    await pool.query("INSERT INTO blocked_numbers (phone, reason) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET reason = $2", [
      phone,
      String(req.body.reason ?? "Blocked by admin"),
    ]);
  }
  res.redirect("/admin/blocked");
});

adminRouter.post("/admin/blocked/delete", async (req, res) => {
  await pool.query("DELETE FROM blocked_numbers WHERE phone = $1", [String(req.body.phone ?? "")]);
  res.redirect("/admin/blocked");
});


// ---- Settings ------------------------------------------------------------

const GREETING_FIELDS: Array<[keyof typeof GREETING_PLACEHOLDERS, string, string]> = [
  ["greetingOutbound", "Calls the agent places to other people", "Played when the person answers. The agent keeps talking right after it, so don't end it with a question."],
  ["greetingUserInbound", "Invited users calling the agent", "Only for users with a phone number on file."],
  ["greetingCallback", "Other people calling back", "When someone the agent called calls the number back."],
];

function settingsPage(settings: Settings, notice = "", error = ""): string {
  const greetings = GREETING_FIELDS.map(
    ([key, label, hint]) => `<fieldset><legend>${esc(label)}</legend>
      <textarea class="wide" name="${key}" rows="3" maxlength="600" required>${esc(settings[key])}</textarea>
      <div class="small muted">${esc(hint)} Placeholders: ${GREETING_PLACEHOLDERS[key].map((p) => `<code>${p}</code>`).join(", ")}.
      Default: <i>${esc(DEFAULT_SETTINGS[key])}</i></div></fieldset>`,
  ).join("");
  return layout(
    "Settings",
    `${notice ? `<div class="card ok">${esc(notice)}</div>` : ""}${error ? `<div class="card bad">${esc(error)}</div>` : ""}
     <div class="card"><h3>Calls</h3>
      <form method="post" action="/admin/settings/calls" class="switch"
        ${settings.callsEnabled ? `onsubmit="return confirm('Turn off all calls? Calls in progress will be hung up, and the agent won\\'t place or answer calls until you turn them back on.')"` : ""}>
        <span class="state ${settings.callsEnabled ? "ok" : "bad"}">${settings.callsEnabled ? "On" : "Off"}</span>
        <input type="hidden" name="enabled" value="${settings.callsEnabled ? "0" : "1"}">
        <button class="${settings.callsEnabled ? "danger" : "primary"}">${settings.callsEnabled ? "Turn off all calls" : "Turn calls back on"}</button>
        <span class="small muted">${settings.callsEnabled ? "Turning calls off hangs up any call in progress. The web chat keeps working." : "The agent won't place or answer calls. The web chat still works."}</span>
      </form></div>
     <form method="post" action="/admin/settings">
      <div class="card"><h3>Recording greetings</h3>
       <p class="small muted">Played word for word at the start of every call, before the AI joins. Each one must say the call is recorded, and greetings to other people must say it's an AI assistant.</p>
       ${greetings}</div>
      <div class="card"><h3>Calling hours and time limit</h3>
       <div class="row">
        <label>Calls allowed from (hour, 0–23)<input type="number" name="contactHoursStart" min="0" max="23" value="${settings.contactHoursStart}" required></label>
        <label>until (hour, 1–24)<input type="number" name="contactHoursEnd" min="1" max="24" value="${settings.contactHoursEnd}" required></label>
        <label>Time zone<input name="timezone" value="${esc(settings.timezone)}" required placeholder="America/New_York"></label>
        <label>Call time limit (minutes)<input type="number" name="maxCallMinutes" min="1" max="60" value="${settings.maxCallMinutes}" required></label>
       </div>
       <p class="small muted">Hours apply to calls the agent places. At the time limit the agent says goodbye and hangs up.</p></div>
      <button class="primary">Save settings</button>
     </form>`,
    "/admin/settings",
  );
}

adminRouter.get("/admin/settings", async (req, res) => {
  const ended = Number(req.query.ended) || 0;
  const notice =
    req.query.saved !== undefined
      ? "Settings saved."
      : req.query.calls === "on"
        ? "Calls are on."
        : req.query.calls === "off"
          ? `Calls are off.${ended ? ` Ended ${ended} call${ended === 1 ? "" : "s"} in progress.` : ""}`
          : "";
  res.send(settingsPage(await getSettings(), notice));
});

adminRouter.post("/admin/settings", async (req, res) => {
  const current = await getSettings();
  const next: Settings = {
    ...current,
    greetingOutbound: String(req.body.greetingOutbound ?? "").trim(),
    greetingUserInbound: String(req.body.greetingUserInbound ?? "").trim(),
    greetingCallback: String(req.body.greetingCallback ?? "").trim(),
    contactHoursStart: Number(req.body.contactHoursStart),
    contactHoursEnd: Number(req.body.contactHoursEnd),
    timezone: String(req.body.timezone ?? "").trim(),
    maxCallMinutes: Number(req.body.maxCallMinutes),
  };
  const error = validateSettings(next);
  if (error) return void res.status(400).send(settingsPage(next, "", error));
  const { callsEnabled: _unchanged, ...changes } = next;
  await saveSettings(changes);
  res.redirect("/admin/settings?saved=1");
});

adminRouter.post("/admin/settings/calls", async (req, res) => {
  const enabled = req.body.enabled === "1";
  await saveSettings({ callsEnabled: enabled });
  setCallsEnabledBanner(enabled);
  let ended = 0;
  if (!enabled) ended = await endActiveCalls();
  res.redirect(`/admin/settings?calls=${enabled ? "on" : "off"}&ended=${ended}`);
});

/** Hang up (or cancel, if still ringing) every call that hasn't ended. */
async function endActiveCalls(): Promise<number> {
  const active = await query<Conversation>(
    `SELECT * FROM conversations
     WHERE call_sid IS NOT NULL AND ended_at IS NULL AND started_at > now() - interval '3 hours'
       AND COALESCE(call_status, '') NOT IN ('completed', 'busy', 'no-answer', 'failed', 'canceled')`,
  );
  let ended = 0;
  for (const c of active) {
    const ringing = ["queued", "initiated", "ringing"].includes(c.call_status ?? "");
    try {
      await twilioClient.calls(c.call_sid!).update({ status: ringing ? "canceled" : "completed" });
      ended++;
    } catch (err) {
      console.error(`Could not end call ${c.call_sid}`, err);
    }
  }
  return ended;
}

// ---- Numbers -------------------------------------------------------------

adminRouter.get("/admin/numbers", async (req, res) => {
  const filter = req.query.status;
  const rows = await query<UserNumber & { user_name: string; calls: number }>(
    `SELECT n.*, u.name AS user_name,
       (SELECT count(*)::int FROM tasks t WHERE t.user_id = n.user_id AND t.target_phone = n.phone) AS calls
     FROM user_numbers n JOIN users u ON u.id = n.user_id
     ORDER BY n.last_called_at DESC LIMIT 500`,
  );
  const shown = rows.filter((n) =>
    filter === "allowed" ? n.callback_allowed && !n.callback_locked : filter === "locked" ? n.callback_locked : true,
  );
  const status = (n: UserNumber) =>
    n.callback_locked
      ? `<span class="bad">Locked off</span><div class="small muted">User cleared it; stays off until they ask the agent to call it again.</div>`
      : n.callback_allowed
        ? `<span class="ok">Call back allowed</span>`
        : `<span class="muted">Call back off</span>`;
  const table = shown.length
    ? `<table><tr><th>Number</th><th>User</th><th>Last called</th><th>Calls</th><th>Call back</th><th></th></tr>${shown
        .map(
          (n) => `<tr>
        <td>${esc(n.name || "")}<div class="${n.name ? "small muted" : ""}">${esc(formatPhone(n.phone))}</div></td>
        <td>${esc(n.user_name)}${n.hidden ? `<div class="small muted">Removed from their list</div>` : ""}</td>
        <td class="small">${esc(fmtDate(n.last_called_at))}</td>
        <td>${n.calls}</td>
        <td>${status(n)}</td>
        <td>${
          n.callback_locked
            ? ""
            : `<form class="inline" method="post" action="/admin/numbers/${n.id}">
                <input type="hidden" name="allowed" value="${n.callback_allowed ? "0" : "1"}">
                <button>${n.callback_allowed ? "Turn off" : "Allow"}</button></form>`
        }</td></tr>`,
        )
        .join("")}</table>`
    : `<p class="muted">No numbers${filter ? " match" : " yet"}.</p>`;
  const tab = (value: string, label: string) =>
    `<a href="/admin/numbers${value ? `?status=${value}` : ""}" class="badge"${(filter ?? "") === value ? ' style="outline:2px solid var(--accent)"' : ""}>${label}</a>`;
  res.send(
    layout(
      "Numbers",
      `<div class="card"><h3>Numbers called for users</h3>
       <p class="small muted">Every number the agent has called on someone's behalf. When a number calls back, the agent only answers if at least one user still allows it.
       Numbers a user cleared stay here and are locked off until that user asks the agent to call them again.</p>
       <p>${tab("", "All")} ${tab("allowed", "Call back allowed")} ${tab("locked", "Locked off")}</p></div>
       <div class="card">${table}</div>`,
      "/admin/numbers",
    ),
  );
});

adminRouter.post("/admin/numbers/:id", async (req, res) => {
  const result = await setCallbackAllowed(Number(req.params.id), req.body.allowed === "1");
  if (result === "locked") return void res.status(409).send(layout("Locked", `<div class="card">That number was cleared by its user and stays off until they ask the agent to call it again. <a href="/admin/numbers">Back</a></div>`));
  res.redirect("/admin/numbers");
});
