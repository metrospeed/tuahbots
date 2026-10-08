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
:root{color-scheme:light;--bg:#f6f6f8;--card:#fff;--soft:#f0f1f4;--ink:#111318;--muted:#6b7080;--line:#e6e7ec;--accent:#5b5bd6;--accent-2:#8b5cf6;--accent-soft:#eeeefc;
  --user:#eeeefc;--them:#fdf3e2;--bot:#f0f1f4;--bad:#c42b2b;--ok:#15803d;--shadow:0 1px 2px rgba(16,18,24,.04),0 4px 16px rgba(16,18,24,.05);--ring:0 0 0 3px rgba(91,91,214,.22)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0c0d10;--card:#15171c;--soft:#1c1f26;--ink:#ecedf1;--muted:#9197a6;--line:#262932;--accent:#8d8df7;--accent-2:#b28cfa;--accent-soft:rgba(141,141,247,.13);
  --user:rgba(141,141,247,.14);--them:rgba(251,191,36,.12);--bot:#1c1f26;--bad:#f87171;--ok:#4ade80;--shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.25);--ring:0 0 0 3px rgba(141,141,247,.3)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
header{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--card) 88%,transparent);backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:4px;align-items:center;flex-wrap:wrap}
header b{display:flex;align-items:center;gap:9px;margin-right:14px;font-weight:650;letter-spacing:-.01em}
header b::before{content:"";width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent-2))}
header a{color:var(--muted);text-decoration:none;padding:6px 11px;border-radius:9px;font-weight:500;font-size:14px}
header a:hover{background:var(--soft);color:var(--ink)}header a.on{color:var(--accent);background:var(--accent-soft)}
header form{margin-left:auto}header form button{border-color:transparent;background:none;color:var(--muted)}header form button:hover{background:var(--soft);color:var(--ink)}
main{max-width:1180px;margin:0 auto;padding:20px 16px 40px}
h3{margin:0 0 12px;font-size:16px;letter-spacing:-.01em}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:16px;overflow-x:auto;box-shadow:var(--shadow)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;background:var(--soft)}
th:first-child{border-top-left-radius:10px}th:last-child{border-top-right-radius:10px}tr:last-child td{border-bottom:0}
tr:hover td{background:color-mix(in srgb,var(--soft) 50%,transparent)}
a{color:var(--accent)}.muted{color:var(--muted)}.small{font-size:12.5px}
.badge{display:inline-block;padding:1px 9px;border-radius:99px;font-size:12px;font-weight:550;background:var(--accent-soft);color:var(--accent);white-space:nowrap}
.bad{color:var(--bad)}.ok{color:var(--ok)}
.msg{max-width:80%;padding:10px 14px;border-radius:16px;margin:8px 0;white-space:pre-wrap;word-wrap:break-word}
.msg.user{background:var(--user);border-bottom-left-radius:5px}.msg.counterpart{background:var(--them);border-bottom-left-radius:5px}.msg.assistant{background:var(--bot);margin-left:auto;border-bottom-right-radius:5px}
.msg .meta{font-size:11.5px;font-weight:550;color:var(--muted);margin-bottom:2px}
.event{text-align:center;font-size:12px;color:var(--muted);margin:10px 0}
input,textarea,select,button{font:inherit;padding:7px 11px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:var(--ring)}
button{cursor:pointer;font-weight:500}button:hover{background:var(--soft)}
button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}button.primary:hover{background:var(--accent);filter:brightness(1.08)}
form.inline{display:inline}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:end}.row label{display:flex;flex-direction:column;gap:4px;font-size:12.5px;font-weight:550;color:var(--muted)}
img.att{max-width:240px;max-height:240px;border-radius:10px;display:block;margin-top:6px}
audio{width:100%}
.callsoff{background:var(--bad);color:#fff;padding:8px 16px;text-align:center;font-weight:500}.callsoff a{color:#fff}
.switch{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.switch .state{font-size:20px;font-weight:650}
button.danger{background:var(--bad);color:#fff;border-color:var(--bad)}
fieldset{border:1px solid var(--line);border-radius:12px;padding:14px;margin:0 0 12px}legend{color:var(--muted);font-size:12.5px;font-weight:550;padding:0 4px}
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
<style>:root{color-scheme:light dark}
body{font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;background:#f6f6f8 radial-gradient(800px 400px at 50% -10%,#eeeefc,transparent);color:#111318;-webkit-font-smoothing:antialiased}
.box{width:100%;max-width:360px;background:#fff;border:1px solid #e6e7ec;border-radius:16px;padding:26px;box-shadow:0 1px 2px rgba(16,18,24,.04),0 4px 16px rgba(16,18,24,.05)}
.box::before{content:"";display:block;width:40px;height:40px;border-radius:12px;margin-bottom:16px;background:linear-gradient(135deg,#5b5bd6,#8b5cf6)}
h2{margin:0 0 6px;font-size:20px;letter-spacing:-.015em}p{margin:6px 0}.muted{color:#6b7080;font-size:13px}.err{color:#c42b2b;background:#fdecec;border-radius:10px;padding:8px 12px;font-size:14px}
form{display:flex;flex-direction:column;gap:10px;margin-top:14px}input,button{font:inherit;padding:10px 12px;border-radius:11px;border:1px solid #e6e7ec}
input{background:#f6f6f8;color:inherit}input:focus{outline:none;border-color:#5b5bd6;box-shadow:0 0 0 3px rgba(91,91,214,.22)}
button,.btn{background:linear-gradient(135deg,#5b5bd6,#8b5cf6);color:#fff;border:0;cursor:pointer;font-weight:600}a{color:#5b5bd6}
.btn{display:block;text-align:center;text-decoration:none;padding:10px;border-radius:11px}
.qr{background:#fff;padding:10px;border-radius:12px;border:1px solid #e6e7ec;width:200px;margin:10px auto}.qr svg{display:block;width:100%;height:auto}
code{font-size:13px;word-break:break-all}.codes{font:15px ui-monospace,monospace;columns:2;margin:10px 0;padding:12px;list-style:none;background:#f0f1f4;border-radius:12px}
@media (prefers-color-scheme:dark){body{background:#0c0d10 radial-gradient(800px 400px at 50% -10%,rgba(141,141,247,.13),transparent);color:#ecedf1}
.box{background:#15171c;border-color:#262932}input{background:#0c0d10;border-color:#262932}.muted{color:#9197a6}a{color:#8d8df7}
.err{background:rgba(248,113,113,.12);color:#f87171}.codes{background:#1c1f26}.qr{border-color:#262932}}</style></head>
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
