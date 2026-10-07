import { config } from "../config.js";

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function fmtDate(d: Date | null | undefined): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: config.agent.timezone,
  }).format(d);
}

const NAV = [
  ["/admin/conversations", "Transcripts"],
  ["/admin/tasks", "Tasks"],
  ["/admin/users", "Invited users"],
  ["/admin/blocked", "Blocked numbers"],
];

export function layout(title: string, body: string, active = ""): string {
  const nav = NAV.map(([href, label]) => `<a href="${href}" class="${href === active ? "on" : ""}">${label}</a>`).join("");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(config.agent.name)} admin</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2330;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--user:#e8f0fe;--them:#fef3e2;--bot:#eef2f5;--bad:#b91c1c;--ok:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--ink:#e6e8ec;--muted:#9aa3b2;--line:#2a303b;--accent:#6ea0ff;--user:#1d2a44;--them:#3a2c16;--bot:#222833;--bad:#f87171;--ok:#4ade80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header b{margin-right:8px}header a{color:var(--muted);text-decoration:none;padding:4px 0}header a.on{color:var(--ink);border-bottom:2px solid var(--accent)}
header form{margin-left:auto}
main{max-width:1100px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px;overflow-x:auto}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:13px}
a{color:var(--accent)}.muted{color:var(--muted)}.small{font-size:13px}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;background:var(--bot);white-space:nowrap}
.bad{color:var(--bad)}.ok{color:var(--ok)}
.msg{max-width:80%;padding:8px 12px;border-radius:12px;margin:6px 0;white-space:pre-wrap;word-wrap:break-word}
.msg.user{background:var(--user)}.msg.counterpart{background:var(--them)}.msg.assistant{background:var(--bot);margin-left:auto}
.msg .meta{font-size:12px;color:var(--muted);margin-bottom:2px}
.event{text-align:center;font-size:12px;color:var(--muted);margin:8px 0}
input,textarea,select,button{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)}
button{cursor:pointer}button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
form.inline{display:inline}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:end}.row label{display:flex;flex-direction:column;font-size:13px;color:var(--muted)}
img.att{max-width:240px;max-height:240px;border-radius:8px;display:block;margin-top:6px}
audio{width:100%}
</style></head><body>
<header><b>${esc(config.agent.name)} admin</b>${nav}
<form method="post" action="/admin/logout"><button>Log out</button></form></header>
<main>${body}</main></body></html>`;
}

export function loginPage(error = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin login</title>
<style>body{font:15px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9}
@media (prefers-color-scheme:dark){body{background:#0f1218;color:#e6e8ec}}
form{display:flex;flex-direction:column;gap:10px;width:280px}input,button{font:inherit;padding:8px;border-radius:6px;border:1px solid #ccc}
button{background:#2563eb;color:#fff;border:0}</style></head>
<body><form method="post" action="/admin/login"><h2>${esc(config.agent.name)} admin</h2>
${error ? `<div style="color:#b91c1c">${esc(error)}</div>` : ""}
<input type="password" name="password" placeholder="Password" autofocus required>
<button>Log in</button></form></body></html>`;
}
