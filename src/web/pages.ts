import { esc, fmtDate } from "../admin/views.js";
import { config } from "../config.js";
import type { Conversation, Message, Task, User } from "../db/index.js";
import { formatPhone } from "../phone.js";

const name = config.agent.name;

const BASE_CSS = `
:root{--bg:#f4f5f7;--card:#fff;--ink:#1d2330;--muted:#6b7280;--line:#e3e6ea;--accent:#2563eb;--accent-ink:#fff;--me:#2563eb;--me-ink:#fff;--bot:#fff;--ok:#15803d;--bad:#b91c1c;--warn:#a16207}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--ink:#e6e8ec;--muted:#9aa3b2;--line:#2a303b;--accent:#6ea0ff;--accent-ink:#0f1218;--me:#3b6fd8;--me-ink:#fff;--bot:#1c212b;--ok:#4ade80;--bad:#f87171;--warn:#facc15}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
a{color:var(--accent)}button{font:inherit;cursor:pointer}
header{display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--card);border-bottom:1px solid var(--line)}
header .title{font-weight:600}header .who{color:var(--muted);font-size:14px;margin-left:auto}
header form{margin:0}header button{background:none;border:1px solid var(--line);color:var(--muted);border-radius:8px;padding:4px 10px;font-size:14px}
.pill{display:inline-block;flex:none;align-self:flex-start;font-size:12px;line-height:18px;font-weight:500;padding:0 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.pill.completed{color:var(--ok);border-color:currentColor}.pill.failed{color:var(--bad);border-color:currentColor}.pill.in_progress,.pill.pending{color:var(--warn);border-color:currentColor}
`;

export function simplePage(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(name)}</title><style>${BASE_CSS}
main{display:grid;place-items:center;min-height:100vh;padding:16px;text-align:center}</style></head>
<body><main><div><h2>${esc(title)}</h2><p>${esc(text)}</p></div></main></body></html>`;
}

export function chatPage(user: User): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
<title>${esc(name)}</title>
<style>${BASE_CSS}
body{display:flex;flex-direction:column;height:100dvh}
.layout{flex:1;display:flex;min-height:0;max-width:1100px;width:100%;margin:0 auto}
.chat{flex:1;display:flex;flex-direction:column;min-width:0}
#log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}
.msg{max-width:80%;padding:9px 13px;border-radius:16px;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 1px 1px rgba(0,0,0,.04)}
.msg.user{align-self:flex-end;background:var(--me);color:var(--me-ink);border-bottom-right-radius:4px}
.msg.assistant{align-self:flex-start;background:var(--bot);border:1px solid var(--line);border-bottom-left-radius:4px}
.msg .time{display:block;font-size:11px;opacity:.65;margin-top:3px}
.msg img{display:block;max-width:220px;max-height:220px;border-radius:10px;margin-top:6px}
.msg.user a{color:var(--me-ink)}
.typing{align-self:flex-start;color:var(--muted);font-size:14px;padding:4px 6px}
.empty{margin:auto;text-align:center;color:var(--muted);max-width:420px;padding:16px}
.empty b{color:var(--ink)}
form.composer{display:flex;gap:8px;align-items:flex-end;padding:10px 16px 14px;border-top:1px solid var(--line);background:var(--card)}
form.composer textarea{flex:1;resize:none;max-height:160px;padding:10px 12px;border-radius:14px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit}
.iconbtn{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:12px;height:42px;min-width:42px;padding:0 10px}
.send{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px}
.chips span{font-size:13px;background:var(--bg);border:1px solid var(--line);border-radius:99px;padding:2px 10px;margin-top:8px}
.error{color:var(--bad);font-size:14px;padding:0 16px}
.notice{background:var(--bad);color:#fff;font-size:14px;padding:6px 16px;text-align:center}
.setup{background:var(--card);border-bottom:1px solid var(--line);font-size:14px;padding:6px 16px;text-align:center}
header a.who{text-decoration:none}header a.who:hover{text-decoration:underline}
aside{width:300px;border-left:1px solid var(--line);overflow-y:auto;padding:16px;background:var(--card)}
aside h3{margin:0 0 10px;font-size:15px}
.task{display:block;text-decoration:none;color:inherit;padding:10px 0;border-bottom:1px solid var(--line)}
.task .top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;font-weight:500}.task .top>span:first-child{min-width:0;overflow-wrap:anywhere}
.task .obj{color:var(--muted);font-size:13px;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.muted{color:var(--muted);font-size:14px}.small{font-size:12px}
aside h4{margin:14px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.numhead{display:flex;justify-content:space-between;align-items:baseline;margin-top:18px}.numhead h4{margin:0}
button.link{background:none;border:0;color:var(--accent);padding:0;font-size:13px}
button.hbtn{background:none;border:1px solid var(--line);color:var(--muted);border-radius:8px;padding:4px 10px;font-size:14px}
.num{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)}
.num .who{min-width:0}.num .nm{font-weight:500;overflow-wrap:anywhere}.num .ph{color:var(--muted);font-size:13px}
.switch{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);flex:none;cursor:pointer}
.switch input{appearance:none;width:34px;height:20px;border-radius:99px;background:var(--line);position:relative;cursor:pointer;margin:0;transition:background .15s}
.switch input::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
.switch input:checked{background:var(--ok)}.switch input:checked::after{left:16px}
.switch input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.menu-btn,.mobile,.backdrop{display:none}
.menu-btn{position:relative;width:40px;height:40px;margin:-6px 0 -6px -8px;border:0;background:none;color:var(--ink);border-radius:10px;align-items:center;justify-content:center}
.menu-btn:focus-visible,.close-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.bars,.bars::before,.bars::after{display:block;width:20px;height:2px;border-radius:2px;background:currentColor;position:relative}
.bars::before,.bars::after{content:"";position:absolute;left:0}.bars::before{top:-6px}.bars::after{top:6px}
.menu-btn .badge{position:absolute;top:3px;right:1px;min-width:17px;height:17px;padding:0 4px;border-radius:99px;background:var(--accent);color:var(--accent-ink);font-size:11px;font-weight:700;line-height:17px;text-align:center}
.drawer-head{align-items:center;justify-content:space-between;gap:10px;margin:-4px 0 14px;padding-bottom:12px;border-bottom:1px solid var(--line)}
.drawer-user{display:flex;flex-direction:column;color:var(--ink);text-decoration:none;font-weight:600;min-width:0;overflow-wrap:anywhere}
.close-btn{flex:none;width:36px;height:36px;border:1px solid var(--line);background:none;color:var(--muted);border-radius:10px;font-size:16px}
.drawer-actions{gap:8px;margin-top:20px;padding-top:14px;border-top:1px solid var(--line)}
.drawer-actions form{margin:0;flex:1}.drawer-actions .hbtn{width:100%;padding:10px;font-size:15px}.drawer-actions>.hbtn{flex:1}
@media (max-width:760px){
  .desk{display:none!important}
  .menu-btn{display:inline-flex}
  .mobile{display:flex}
  header{gap:8px}
  aside{position:fixed;top:0;bottom:0;left:0;z-index:30;width:min(86vw,340px);border-left:0;border-right:1px solid var(--line);
    padding:calc(14px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom));
    transform:translateX(-102%);visibility:hidden;transition:transform .22s ease,visibility 0s linear .22s;box-shadow:0 0 40px rgba(0,0,0,.35)}
  aside.open{transform:none;visibility:visible;transition:transform .22s ease}
  .backdrop{display:block;position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:opacity .22s}
  .backdrop.show{opacity:1;pointer-events:auto}
  body.menu-open{overflow:hidden}
}
@media (prefers-reduced-motion:reduce){aside,aside.open,.backdrop{transition:none}}
</style></head>
<body data-agent="${esc(name)}" data-first="${esc(user.name.split(" ")[0])}">
<header>
<button type="button" class="menu-btn" id="menuOpen" aria-label="Open menu: calls, numbers and account" aria-controls="tasks" aria-expanded="false">
  <span class="bars" aria-hidden="true"></span><span class="badge" id="menuBadge" hidden></span>
</button>
<span class="title">${esc(name)}</span>
<a class="who desk" href="/app/account" title="Account">${esc(user.name)}</a>
<button type="button" class="hbtn desk js-clear-chat">Clear chat</button>
<form method="post" action="/app/logout" class="desk"><button>Sign out</button></form></header>
${user.password_hash ? "" : `<div class="setup">You're signed in on this device only. <a href="/app/account">Create a login</a> to sign in anywhere.</div>`}
<div class="notice" id="callsOff" hidden>Calling is turned off right now. You can still chat, but ${esc(name)} can't place calls.</div>
<div class="layout">
  <section class="chat">
    <div id="log" aria-live="polite"></div>
    <div class="chips" id="chips"></div>
    <div class="error" id="error"></div>
    <form class="composer" id="composer">
      <input type="file" id="file" accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain" multiple hidden>
      <button type="button" class="iconbtn" id="attach" title="Attach a photo or PDF" aria-label="Attach a file">📎</button>
      <textarea id="text" rows="1" placeholder="Ask ${esc(name)} to call someone…" autocomplete="off"></textarea>
      <button class="iconbtn send" id="send">Send</button>
    </form>
  </section>
  <div class="backdrop" id="backdrop"></div>
  <aside id="tasks" aria-label="Calls and numbers">
    <div class="drawer-head mobile">
      <a href="/app/account" class="drawer-user">${esc(user.name)}<span class="muted small">Account</span></a>
      <button type="button" class="close-btn" id="menuClose" aria-label="Close menu">✕</button>
    </div>
    <h3 id="tasksHeading">Calls &amp; numbers</h3>
    <div class="list">
      <h4>Your calls</h4><div id="taskList"><p class="muted">No calls yet.</p></div>
      <div class="numhead"><h4>Numbers</h4><button type="button" id="clearNumbers" class="link" hidden>Clear list</button></div>
      <p class="muted small">Numbers ${esc(name)} has called for you. Turn on <b>Call back</b> to let a number call ${esc(name)} back about your request.</p>
      <div id="numberList"><p class="muted">No numbers yet.</p></div>
    </div>
    <div class="drawer-actions mobile">
      <button type="button" class="hbtn js-clear-chat">Clear chat</button>
      <form method="post" action="/app/logout"><button class="hbtn">Sign out</button></form>
    </div></aside>
</div>
<script src="/assets/chat.js" defer></script>
</body></html>`;
}

export function callPage(task: Task, calls: Array<{ call: Conversation; lines: Message[] }>): string {
  const who = task.target_name || formatPhone(task.target_phone);
  const sections = calls
    .map(({ call, lines }) => {
      const transcript = lines
        .filter((l) => l.role !== "event")
        .map((l) => {
          const speaker = l.role === "assistant" ? name : who;
          return `<div class="line ${l.role === "assistant" ? "me" : "them"}"><b>${esc(speaker)}</b> ${esc(l.body)}</div>`;
        })
        .join("");
      return `<section class="card">
        <div class="muted">${call.direction === "outbound" ? "Call placed" : "They called back"} ${esc(fmtDate(call.started_at))}${call.call_status ? ` · ${esc(call.call_status)}` : ""}</div>
        ${call.recording_sid ? `<audio controls preload="none" src="/app/recordings/${call.id}.mp3"></audio>` : ""}
        ${call.summary ? `<p><b>Summary:</b> ${esc(call.summary)}</p>` : ""}
        ${transcript || `<p class="muted">No transcript.</p>`}
      </section>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Call with ${esc(who)} · ${esc(name)}</title>
<style>${BASE_CSS}
main{max-width:760px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
.line{padding:6px 0;border-bottom:1px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere}.line:last-child{border:0}
.line.me b{color:var(--accent)}.muted{color:var(--muted);font-size:14px}audio{width:100%;margin:10px 0}
</style></head><body>
<header><a href="/app">← Back to chat</a></header>
<main>
  <section class="card">
    <h2 style="margin:0 0 6px">Call with ${esc(who)} <span class="pill ${task.status}">${esc(task.status.replace("_", " "))}</span></h2>
    <div class="muted">${esc(formatPhone(task.target_phone))} · task #${task.id} · ${esc(fmtDate(task.created_at))}</div>
    <p><b>Goal:</b> ${esc(task.objective)}</p>
    ${task.result ? `<p><b>Result:</b> ${esc(task.result)}</p>` : ""}
  </section>
  ${sections || `<p class="muted">The call hasn't started yet.</p>`}
</main></body></html>`;
}

// ---- Login, invite setup, account ------------------------------------------

const FORM_CSS = `
main{display:grid;place-items:center;min-height:100vh;padding:16px}
.panel{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
.panel h1{font-size:22px;margin:0 0 4px}.panel .sub{color:var(--muted);font-size:14px;margin:0 0 18px}
label{display:block;font-size:14px;color:var(--muted);margin:12px 0 4px}
input{width:100%;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button.go{width:100%;margin-top:18px;padding:11px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-ink);font-weight:600}
.err{color:var(--bad);font-size:14px;margin:10px 0 0}.ok{color:var(--ok);font-size:14px;margin:10px 0 0}
.foot{color:var(--muted);font-size:13px;margin-top:16px;text-align:center}`;

function formPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(name)}</title><style>${BASE_CSS}${FORM_CSS}</style></head>
<body><main><div class="panel">${body}</div></main></body></html>`;
}

const passwordFields = (label: string) => `
  <label for="password">${esc(label)}</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="10" maxlength="200" required>
  <label for="confirm">Confirm password</label>
  <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" maxlength="200" required>
  <div class="foot" style="text-align:left;margin-top:6px">At least 10 characters.</div>`;

export function loginPage(opts: { error?: string; email?: string; next?: string; notice?: string } = {}): string {
  return formPage(
    "Sign in",
    `<h1>${esc(name)}</h1><p class="sub">Sign in to your account.</p>
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${esc(opts.next ?? "/app")}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" value="${esc(opts.email ?? "")}" required ${opts.email ? "" : "autofocus"}>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required ${opts.email ? "autofocus" : ""}>
      ${opts.error ? `<p class="err" role="alert">${esc(opts.error)}</p>` : ""}${opts.notice ? `<p class="ok">${esc(opts.notice)}</p>` : ""}
      <button class="go">Sign in</button>
    </form>
    <p class="foot">${esc(name)} is invite-only. Forgot your password? Ask the person who invited you for a reset link.</p>`,
  );
}

/** Shown when someone opens an invite link (first login) or a reset link (has a login already). */
export function invitePage(user: User, token: string, opts: { error?: string; email?: string } = {}): string {
  const reset = !!user.password_hash;
  return formPage(
    reset ? "Reset password" : "Create your login",
    `<h1>${reset ? "Set a new password" : `Welcome, ${esc(user.name.split(" ")[0])}`}</h1>
    <p class="sub">${reset ? "Choose a new password. You'll be signed out on your other devices." : `You've been invited to ${esc(name)}. Create a login to get started.`}</p>
    <form method="post" action="/join/${esc(token)}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" value="${esc(opts.email ?? user.email ?? "")}" required>
      ${passwordFields(reset ? "New password" : "Password")}
      ${opts.error ? `<p class="err" role="alert">${esc(opts.error)}</p>` : ""}
      <button class="go">${reset ? "Save and sign in" : "Create login"}</button>
    </form>
    <p class="foot">This link works once. Afterwards, sign in at /login.</p>`,
  );
}

export function accountPage(user: User, opts: { error?: string; notice?: string } = {}): string {
  const hasLogin = !!user.password_hash;
  return formPage(
    "Account",
    `<p style="margin:0 0 12px"><a href="/app">← Back to chat</a></p>
    <h1>${esc(user.name)}</h1>
    <p class="sub">${hasLogin ? `Signed in as ${esc(user.email ?? "")}.` : "Create a login so you can sign in from any device."}</p>
    <form method="post" action="/app/account">
      ${
        hasLogin
          ? `<input type="hidden" name="email" value="${esc(user.email ?? "")}">
      <label for="current">Current password</label>
      <input id="current" name="current" type="password" autocomplete="current-password" required>`
          : `<label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required>`
      }
      ${passwordFields(hasLogin ? "New password" : "Password")}
      ${opts.error ? `<p class="err" role="alert">${esc(opts.error)}</p>` : ""}${opts.notice ? `<p class="ok">${esc(opts.notice)}</p>` : ""}
      <button class="go">${hasLogin ? "Change password" : "Create login"}</button>
    </form>
    ${hasLogin ? `<p class="foot">Changing your password signs you out on your other devices.</p>` : ""}`,
  );
}
