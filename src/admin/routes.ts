import express from "express";
import { config } from "../config.js";
import { listMessages, pool, query, queryOne, type Attachment, type Conversation, type Task, type User } from "../db/index.js";
import { formatPhone, toE164 } from "../phone.js";
import { notifyUser } from "../tasks.js";
import { fetchRecording } from "../twilio.js";
import {
  checkPassword,
  clearSessionCookie,
  loginThrottled,
  recordFailedLogin,
  requireAdmin,
  setSessionCookie,
} from "./auth.js";
import { esc, fmtDate, layout, loginPage } from "./views.js";

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

adminRouter.get("/admin", (_req, res) => res.redirect("/admin/conversations"));

const KIND_LABELS: Record<string, string> = {
  user_sms: "User texts",
  user_call: "User call",
  task_call: "Task call",
  task_sms: "Task texts",
  unknown_sms: "Unknown texts",
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
        <td><span class="badge">${esc(KIND_LABELS[c.kind])}</span>${c.recording_sid ? ` <span title="Recorded">🎙</span>` : ""}
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
      (u) => `<tr><td>${esc(u.name)}</td><td>${esc(formatPhone(u.phone))}</td>
      <td><form method="post" action="/admin/users/${u.id}/notes" class="row"><textarea name="notes" rows="2" cols="34" placeholder="Background the agent should know">${esc(u.notes)}</textarea><button>Save</button></form></td>
      <td class="${u.active ? "ok" : "bad"}">${u.active ? "Active" : "Disabled"}</td>
      <td><form class="inline" method="post" action="/admin/users/${u.id}/toggle"><button>${u.active ? "Disable" : "Enable"}</button></form>
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
        <label>Phone<input name="phone" required placeholder="(555) 123-4567"></label>
        <label style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" name="welcome" value="1" checked> Send welcome text</label>
        <button class="primary">Invite</button></form>
       <p class="small muted">Only invited, active users can text or call ${esc(formatPhone(config.twilio.phoneNumber))} and ask the agent to contact others.</p></div>
       <div class="card">${users.length ? `<table><tr><th>Name</th><th>Phone</th><th>Notes for the agent</th><th>Status</th><th></th></tr>${rows}</table>` : `<p class="muted">Nobody invited yet.</p>`}</div>`,
      "/admin/users",
    ),
  );
});

adminRouter.post("/admin/users", async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  const phone = toE164(String(req.body.phone ?? ""));
  if (!name || !phone) return res.redirect(`/admin/users?error=${encodeURIComponent("Enter a name and a valid phone number.")}`);
  const user = await queryOne<User>(
    "INSERT INTO users (name, phone) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING RETURNING *",
    [name, phone],
  );
  if (!user) return res.redirect(`/admin/users?error=${encodeURIComponent("That number is already invited.")}`);
  await pool.query("DELETE FROM blocked_numbers WHERE phone = $1", [phone]);
  if (req.body.welcome) {
    try {
      await notifyUser(
        user,
        `Hi ${name.split(" ")[0]}, you've been invited to use ${config.agent.name}, an AI assistant. Text or call this number and ask me to call or text someone for you, e.g. "Call 555-123-4567 and get the status of the quote I just sent you." Calls are recorded. Reply STOP to opt out.`,
      );
    } catch (err) {
      console.error("Welcome text failed", err);
      return res.redirect(`/admin/users?error=${encodeURIComponent(`Invited, but the welcome text failed: ${(err as Error).message}`)}`);
    }
  }
  res.redirect("/admin/users");
});

adminRouter.post("/admin/users/:id/toggle", async (req, res) => {
  await pool.query("UPDATE users SET active = NOT active WHERE id = $1", [Number(req.params.id)]);
  res.redirect("/admin/users");
});

adminRouter.post("/admin/users/:id/notes", async (req, res) => {
  await pool.query("UPDATE users SET notes = $2 WHERE id = $1", [Number(req.params.id), String(req.body.notes ?? "").slice(0, 4000)]);
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
      `<div class="card"><h3>Block a number</h3><p class="small muted">The agent will never call or text a blocked number. People who reply STOP are added automatically.</p>
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

