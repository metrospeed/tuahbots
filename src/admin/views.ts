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
  ["/admin/numbers", "Numbers"],
  ["/admin/blocked", "Blocked numbers"],
  ["/admin/settings", "Settings"],
];

/** Refreshed by the admin router on each request so every page can show the calls-off banner. */
let callsEnabled = true;
export function setCallsEnabledBanner(enabled: boolean): void {
  callsEnabled = enabled;
}

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
.callsoff{background:var(--bad);color:#fff;padding:8px 16px;text-align:center;font-weight:500}.callsoff a{color:#fff}
.switch{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.switch .state{font-size:20px;font-weight:600}
button.danger{background:var(--bad);color:#fff;border-color:var(--bad)}
fieldset{border:1px solid var(--line);border-radius:8px;padding:12px;margin:0 0 12px}legend{color:var(--muted);font-size:13px;padding:0 4px}
textarea.wide{width:100%}
</style></head><body>
<header><b>${esc(config.agent.name)} admin</b>${nav}
<form method="post" action="/admin/logout"><button>Log out</button></form></header>
${callsEnabled ? "" : `<div class="callsoff">Calls are turned off. The agent won't place or answer any calls. <a href="/admin/settings">Settings</a></div>`}
<main>${body}</main><script src="/assets/admin.js" defer></script></body></html>`;
}

function authPage(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(config.agent.name)} admin</title>
<style>body{font:15px/1.45 system-ui;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;background:#f6f7f9;color:#1d2330}
@media (prefers-color-scheme:dark){body{background:#0f1218;color:#e6e8ec}.box{background:#171b23!important;border-color:#2a303b!important}input{background:#0f1218;color:#e6e8ec;border-color:#2a303b!important}}
.box{width:100%;max-width:340px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:22px}
h2{margin:0 0 6px}p{margin:6px 0}.muted{color:#6b7280;font-size:13px}.err{color:#b91c1c}
form{display:flex;flex-direction:column;gap:10px;margin-top:12px}input,button{font:inherit;padding:9px;border-radius:8px;border:1px solid #ccc}
button,.btn{background:#2563eb;color:#fff;border:0;cursor:pointer}a{color:#2563eb}
.btn{display:block;text-align:center;text-decoration:none;padding:9px;border-radius:8px}
.qr{background:#fff;padding:8px;border-radius:8px;width:200px;margin:8px auto}.qr svg{display:block;width:100%;height:auto}
code{font-size:13px;word-break:break-all}.codes{font:15px ui-monospace,monospace;columns:2;margin:10px 0;padding:0;list-style:none}</style></head>
<body><div class="box">${inner}</div></body></html>`;
}

export function loginPage(error = ""): string {
  return authPage(
    "Sign in",
    `<h2>${esc(config.agent.name)} admin</h2>
    <form method="post" action="/admin/login">
      ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
      <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
      <button>Continue</button>
    </form>`,
  );
}

export function codePage(error = ""): string {
  return authPage(
    "Two-factor code",
    `<h2>Enter your code</h2>
    <p class="muted">Open your authenticator app and enter the 6-digit code. Lost your phone? Enter one of your recovery codes instead.</p>
    <form method="post" action="/admin/login/code">
      ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
      <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="20" autofocus required>
      <button>Sign in</button>
    </form>
    <p class="muted"><a href="/admin/login">Start over</a></p>`,
  );
}

/** First sign-in: scan the QR code into an authenticator app and confirm a code. */
export function setupPage(opts: { qrSvg: string; secret: string; candidate: string; error?: string }): string {
  const grouped = opts.secret.replace(/(.{4})/g, "$1 ").trim();
  return authPage(
    "Set up two-factor",
    `<h2>Set up two-factor sign-in</h2>
    <p class="muted">Scan this with an authenticator app (Google Authenticator, 1Password, Authy, …), then enter the 6-digit code it shows.</p>
    <div class="qr" aria-label="QR code for your authenticator app">${opts.qrSvg}</div>
    <p class="muted">Can't scan? Enter this key manually:<br><code>${esc(grouped)}</code></p>
    <form method="post" action="/admin/login/setup">
      <input type="hidden" name="candidate" value="${esc(opts.candidate)}">
      ${opts.error ? `<div class="err" role="alert">${esc(opts.error)}</div>` : ""}
      <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="6" autofocus required>
      <button>Turn on two-factor</button>
    </form>`,
  );
}

export function recoveryCodesPage(codes: string[], intro: string): string {
  return authPage(
    "Recovery codes",
    `<h2>Save your recovery codes</h2>
    <p>${esc(intro)}</p>
    <p class="muted">Each code works once, in place of an authenticator code, if you lose your phone. Store them somewhere safe (a password manager). They won't be shown again.</p>
    <ul class="codes">${codes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
    <p><a class="btn" href="/admin/conversations">I've saved them, continue</a></p>`,
  );
}
