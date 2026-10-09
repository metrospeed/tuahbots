import { esc, fmtDate } from "../admin/views.js";
import { config } from "../config.js";
import type { Conversation, Message, Task, User } from "../db/index.js";
import { formatPhone } from "../phone.js";

const name = config.agent.name;

const BASE_CSS = `
:root{color-scheme:light;--bg:#f6f6f8;--card:#fff;--soft:#f0f1f4;--ink:#111318;--muted:#6b7080;--line:#e6e7ec;
  --accent:#5b5bd6;--accent-2:#8b5cf6;--accent-ink:#fff;--accent-soft:#eeeefc;--me:#5b5bd6;--me-ink:#fff;--bot:#fff;
  --ok:#15803d;--ok-soft:#e8f6ec;--bad:#c42b2b;--bad-soft:#fdecec;--warn:#b45309;--warn-soft:#fdf3e2;
  --shadow:0 1px 2px rgba(16,18,24,.04),0 4px 16px rgba(16,18,24,.05);--ring:0 0 0 3px rgba(91,91,214,.22)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0c0d10;--card:#15171c;--soft:#1c1f26;--ink:#ecedf1;--muted:#9197a6;--line:#262932;
  --accent:#8d8df7;--accent-2:#b28cfa;--accent-ink:#0c0d10;--accent-soft:rgba(141,141,247,.13);--me:#6363dd;--me-ink:#fff;--bot:#1a1d23;
  --ok:#4ade80;--ok-soft:rgba(74,222,128,.12);--bad:#f87171;--bad-soft:rgba(248,113,113,.12);--warn:#fbbf24;--warn-soft:rgba(251,191,36,.12);
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.25);--ring:0 0 0 3px rgba(141,141,247,.3)}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent)}button{font:inherit;cursor:pointer;color:inherit}
:focus-visible{outline:none;box-shadow:var(--ring)}
svg.i{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
header{display:flex;align-items:center;gap:10px;padding:10px 16px;background:color-mix(in srgb,var(--card) 85%,transparent);backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line);position:relative;z-index:5}
.brand{display:flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;min-width:0}
.mark{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;flex:none;color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent-2));box-shadow:0 2px 8px rgba(91,91,214,.35)}
.mark svg.i{width:17px;height:17px;stroke-width:2}
.brand .title{font-weight:650;letter-spacing:-.01em;line-height:1.15}
.brand .tag{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);font-weight:450}
.brand .tag::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--ok)}
.hspace{flex:1}
.ghost{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 12px;border-radius:10px;border:1px solid transparent;background:none;color:var(--muted);font-size:14px;text-decoration:none;white-space:nowrap}
.ghost:hover{background:var(--soft);color:var(--ink)}
.avatar{display:inline-grid;place-items:center;flex:none;width:32px;height:32px;border-radius:50%;font-size:13px;font-weight:600;background:var(--accent-soft);color:var(--accent);text-decoration:none}
.pill{display:inline-flex;align-items:center;gap:5px;flex:none;align-self:flex-start;font-size:12px;line-height:20px;font-weight:550;padding:0 8px;border-radius:99px;background:var(--soft);color:var(--muted);white-space:nowrap;text-transform:capitalize}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.completed{color:var(--ok);background:var(--ok-soft)}.pill.failed{color:var(--bad);background:var(--bad-soft)}
.pill.in_progress,.pill.pending{color:var(--warn);background:var(--warn-soft)}
.pill.in_progress::before{animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{50%{opacity:.25}}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}
.muted{color:var(--muted);font-size:14px}.small{font-size:12.5px}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

const ICONS = {
  phone: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>`,
  clip: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m21 11-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6L15.5 6"/></svg>`,
  send: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
  broom: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>`,
  out: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3"/></svg>`,
  back: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>`,
  close: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
};

/** Up to two initials for an avatar, or a phone icon when the name is just a number. */
const initials = (s: string) =>
  /\p{L}/u.test(s)
    ? s.replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).slice(0, 2).map((w) => esc(w[0]?.toUpperCase() ?? "")).join("")
    : ICONS.phone;

const brand = (href = "/app") =>
  `<a class="brand" href="${href}"><span class="mark">${ICONS.phone}</span><span><span class="title">${esc(name)}</span><span class="tag">AI phone assistant</span></span></a>`;

export function simplePage(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(name)}</title><style>${BASE_CSS}
main{display:grid;place-items:center;min-height:100vh;padding:16px}
.card{max-width:420px;padding:28px;text-align:center}.card .mark{margin:0 auto 14px;width:40px;height:40px;border-radius:12px}
.card h2{margin:0 0 6px;font-size:20px;letter-spacing:-.01em}.card p{margin:0;color:var(--muted)}</style></head>
<body><main><div class="card"><span class="mark">${ICONS.phone}</span><h2>${esc(title)}</h2><p>${esc(text)}</p></div></main></body></html>`;
}

export function chatPage(user: User): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
<title>${esc(name)}</title>
<style>${BASE_CSS}
body{display:flex;flex-direction:column;height:100dvh}
.layout{flex:1;display:flex;min-height:0}
.chat{flex:1;display:flex;flex-direction:column;min-width:0}
#log{flex:1;overflow-y:auto;padding:24px 16px 8px;display:flex;flex-direction:column;gap:10px;scrollbar-gutter:stable}
#log>*{width:100%;max-width:760px;margin-left:auto;margin-right:auto}
.row{display:flex;gap:10px;align-items:flex-end}.row.user{justify-content:flex-end}
.row .avatar{width:28px;height:28px;font-size:12px;color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent-2))}
.row .avatar svg.i{width:14px;height:14px;stroke-width:2.2}
.msg{max-width:min(80%,600px);padding:10px 14px;border-radius:18px;white-space:pre-wrap;overflow-wrap:anywhere;animation:rise .18s ease-out}
.msg.user{background:var(--me);color:var(--me-ink);border-bottom-right-radius:6px}
.msg.assistant{background:var(--bot);border:1px solid var(--line);border-bottom-left-radius:6px;box-shadow:0 1px 2px rgba(16,18,24,.04)}
.msg .time{display:block;font-size:11px;opacity:.6;margin-top:4px}
.msg img{display:block;max-width:240px;max-height:240px;border-radius:12px;margin-top:8px}
.msg .file{display:inline-flex;align-items:center;gap:6px;margin-top:8px;padding:6px 10px;border-radius:10px;background:rgba(127,127,127,.12);text-decoration:none;color:inherit;font-size:14px}
.msg.user a{color:var(--me-ink)}
@keyframes rise{from{opacity:0;transform:translateY(4px)}}
.typing{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:13.5px}
.dots{display:inline-flex;gap:4px;padding:12px 14px;border-radius:18px;border-bottom-left-radius:6px;background:var(--bot);border:1px solid var(--line)}
.dots i{width:6px;height:6px;border-radius:50%;background:var(--muted);animation:blink 1.2s infinite}
.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
@keyframes blink{0%,60%,100%{opacity:.25;transform:none}30%{opacity:1;transform:translateY(-2px)}}
.empty{margin:auto;text-align:center;padding:24px 0}
.empty .mark{width:52px;height:52px;border-radius:16px;margin:0 auto 16px}.empty .mark svg.i{width:24px;height:24px}
.empty h2{margin:0 0 6px;font-size:24px;letter-spacing:-.02em}
.empty>p{margin:0 auto;color:var(--muted);max-width:440px}
.ideas{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:24px 0 14px;text-align:left}
.idea{display:flex;flex-direction:column;justify-content:flex-start;width:100%;text-align:left;padding:14px;border-radius:14px;border:1px solid var(--line);background:var(--card);box-shadow:var(--shadow);transition:border-color .15s,transform .15s}
.idea:hover{border-color:var(--accent);transform:translateY(-1px)}
.idea b{display:block;font-size:14px;font-weight:600;margin-bottom:3px}.idea span{display:block;color:var(--muted);font-size:13px;line-height:1.4}
.empty .fine{font-size:12.5px;color:var(--muted)}
.dock{padding:8px 16px calc(12px + env(safe-area-inset-bottom))}
.dock>*{max-width:760px;margin-left:auto;margin-right:auto}
form.composer{display:flex;gap:6px;align-items:flex-end;padding:6px;border-radius:20px;border:1px solid var(--line);background:var(--card);box-shadow:var(--shadow);transition:border-color .15s,box-shadow .15s}
form.composer:focus-within{border-color:color-mix(in srgb,var(--accent) 55%,var(--line));box-shadow:var(--shadow),var(--ring)}
form.composer textarea{flex:1;resize:none;max-height:160px;padding:9px 4px;border:0;outline:0;background:none;color:var(--ink);font:inherit;box-shadow:none}
.iconbtn{display:inline-grid;place-items:center;flex:none;width:38px;height:38px;border:0;border-radius:14px;background:none;color:var(--muted)}
.iconbtn:hover{background:var(--soft);color:var(--ink)}
.send{background:var(--accent);color:#fff}.send:hover{background:var(--accent);color:#fff;filter:brightness(1.08)}
.send:disabled{opacity:.5;cursor:default}
.hint{text-align:center;font-size:11.5px;color:var(--muted);margin-top:8px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chips span{display:inline-flex;align-items:center;gap:5px;font-size:13px;background:var(--accent-soft);color:var(--accent);border-radius:99px;padding:3px 10px;margin-bottom:8px}
.error{color:var(--bad);font-size:13.5px}.error:not(:empty){margin-bottom:8px}
.notice{background:var(--bad-soft);color:var(--bad);font-size:14px;font-weight:500;padding:8px 16px;text-align:center;border-bottom:1px solid var(--line)}
.setup{background:var(--accent-soft);color:var(--ink);border-bottom:1px solid var(--line);font-size:14px;padding:8px 16px;text-align:center}
aside{width:340px;flex:none;border-left:1px solid var(--line);overflow-y:auto;padding:18px 16px;background:var(--card)}
aside h3{margin:0 0 14px;font-size:15px;letter-spacing:-.01em}
aside h4{margin:0;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.sect{display:flex;justify-content:space-between;align-items:center;margin:0 0 8px}
.sect+div,.list>h4+div{margin-bottom:22px}
.list>h4{margin-bottom:8px}
#taskList,#numberList{display:flex;flex-direction:column;gap:6px}
#taskList>.muted,#numberList>.muted{margin:0;padding:14px;border:1px dashed var(--line);border-radius:12px;text-align:center;font-size:13px}
.task{display:flex;gap:10px;text-decoration:none;color:inherit;padding:10px;border-radius:12px;border:1px solid transparent;transition:background .12s}
.task:hover{background:var(--soft)}
.task .avatar svg.i{width:15px;height:15px}
.task .body{flex:1;min-width:0}
.task .top{display:flex;justify-content:space-between;align-items:center;gap:8px;font-weight:600;font-size:14px}.task .top>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task .obj{color:var(--muted);font-size:13px;margin-top:1px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.task .when{color:var(--muted);font-size:12px;margin-top:3px}
.numnote{margin:0 0 8px;font-size:12.5px;line-height:1.45}
button.link{background:none;border:0;color:var(--accent);padding:0;font-size:13px;font-weight:500}
.num{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;border-radius:12px;background:var(--soft)}
.num .who{min-width:0}.num .nm{font-weight:600;font-size:14px;overflow-wrap:anywhere}.num .ph{color:var(--muted);font-size:12.5px}
.switch{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);flex:none;cursor:pointer}
.switch input{appearance:none;width:36px;height:22px;border-radius:99px;background:var(--line);position:relative;cursor:pointer;margin:0;transition:background .15s}
.switch input::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s}
.switch input:checked{background:var(--ok)}.switch input:checked::after{left:17px}
.menu-btn,.mobile,.backdrop{display:none}
.menu-btn{position:relative;width:38px;height:38px;margin-left:-6px;border:0;background:none;color:var(--ink);border-radius:10px;align-items:center;justify-content:center}
.bars,.bars::before,.bars::after{display:block;width:18px;height:2px;border-radius:2px;background:currentColor;position:relative}
.bars::before,.bars::after{content:"";position:absolute;left:0}.bars::before{top:-6px}.bars::after{top:6px}
.menu-btn .badge{position:absolute;top:2px;right:0;min-width:17px;height:17px;padding:0 4px;border-radius:99px;background:var(--accent);color:#fff;font-size:10.5px;font-weight:700;line-height:17px;text-align:center;box-shadow:0 0 0 2px var(--card)}
.drawer-head{align-items:center;gap:10px;margin:0 0 18px;padding:4px 0 14px;border-bottom:1px solid var(--line)}
.drawer-user{display:flex;flex:1;align-items:center;gap:10px;color:var(--ink);text-decoration:none;font-weight:600;min-width:0;overflow-wrap:anywhere}
.drawer-user .muted{display:block;font-weight:400;font-size:12.5px}
.close-btn{display:grid;place-items:center;flex:none;width:36px;height:36px;border:0;background:var(--soft);color:var(--muted);border-radius:10px}
.drawer-actions{flex-direction:column;gap:2px;margin-top:8px;padding-top:12px;border-top:1px solid var(--line)}
.drawer-actions form{margin:0}.drawer-actions .ghost{width:100%;height:42px;font-size:15px;color:var(--ink)}
header form{margin:0}
@media (max-width:760px){
  .desk{display:none!important}
  .menu-btn{display:inline-flex}
  .mobile{display:flex}
  aside{position:fixed;top:0;bottom:0;left:0;z-index:30;width:min(88vw,360px);border-left:0;border-right:1px solid var(--line);
    padding:calc(14px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom));
    transform:translateX(-102%);visibility:hidden;transition:transform .24s cubic-bezier(.2,.8,.2,1),visibility 0s linear .24s;box-shadow:0 0 50px rgba(0,0,0,.3)}
  aside.open{transform:none;visibility:visible;transition:transform .24s cubic-bezier(.2,.8,.2,1)}
  aside h3{display:none}
  .backdrop{display:block;position:fixed;inset:0;z-index:20;background:rgba(10,10,14,.4);backdrop-filter:blur(2px);opacity:0;pointer-events:none;transition:opacity .22s}
  .backdrop.show{opacity:1;pointer-events:auto}
  body.menu-open{overflow:hidden}
  .msg{max-width:85%}
  .row .avatar{display:none}
}
</style></head>
<body data-agent="${esc(name)}" data-first="${esc(user.name.split(" ")[0])}">
<header>
<button type="button" class="menu-btn" id="menuOpen" aria-label="Open menu: calls, numbers and account" aria-controls="tasks" aria-expanded="false">
  <span class="bars" aria-hidden="true"></span><span class="badge" id="menuBadge" hidden></span>
</button>
${brand()}
<span class="hspace"></span>
<button type="button" class="ghost desk js-clear-chat" title="Start a fresh chat">${ICONS.broom}Clear chat</button>
<form method="post" action="/app/logout" class="desk"><button class="ghost" title="Sign out">${ICONS.out}Sign out</button></form>
<a class="avatar desk" href="/app/account" title="${esc(user.name)} · Account">${initials(user.name)}</a></header>
${user.password_hash ? "" : `<div class="setup">You're signed in on this device only. <a href="/app/account">Create a login</a> to sign in anywhere.</div>`}
<div class="notice" id="callsOff" hidden>Calling is turned off right now. You can still chat, but ${esc(name)} can't place calls.</div>
<div class="layout">
  <section class="chat">
    <div id="log" aria-live="polite"></div>
    <div class="dock">
      <div class="chips" id="chips"></div>
      <div class="error" id="error"></div>
      <form class="composer" id="composer">
        <input type="file" id="file" accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain" multiple hidden>
        <button type="button" class="iconbtn" id="attach" title="Attach a photo or PDF" aria-label="Attach a file">${ICONS.clip}</button>
        <textarea id="text" rows="1" placeholder="Ask ${esc(name)} to call someone…" autocomplete="off"></textarea>
        <button class="iconbtn send" id="send" title="Send" aria-label="Send">${ICONS.send}</button>
      </form>
      <div class="hint">Every call opens by saying it's an AI assistant and that the call is recorded.</div>
    </div>
  </section>
  <div class="backdrop" id="backdrop"></div>
  <aside id="tasks" aria-label="Calls and numbers">
    <div class="drawer-head mobile">
      <a href="/app/account" class="drawer-user"><span class="avatar">${initials(user.name)}</span><span>${esc(user.name)}<span class="muted">Account settings</span></span></a>
      <button type="button" class="close-btn" id="menuClose" aria-label="Close menu">${ICONS.close}</button>
    </div>
    <h3 id="tasksHeading">Calls &amp; numbers</h3>
    <div class="list">
      <h4>Recent calls</h4><div id="taskList"><p class="muted">No calls yet.</p></div>
      <div class="sect"><h4>Numbers</h4><button type="button" id="clearNumbers" class="link" hidden>Clear list</button></div>
      <p class="muted numnote">Turn on <b>Call back</b> to let a number reach ${esc(name)} about your request.</p>
      <div id="numberList"><p class="muted">No numbers yet.</p></div>
    </div>
    <div class="drawer-actions mobile">
      <button type="button" class="ghost js-clear-chat">${ICONS.broom}Clear chat</button>
      <form method="post" action="/app/logout"><button class="ghost">${ICONS.out}Sign out</button></form>
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
          return `<div class="line ${l.role === "assistant" ? "me" : "them"}"><b>${esc(speaker)}</b><span>${esc(l.body)}</span></div>`;
        })
        .join("");
      return `<section class="card call">
        <div class="callhead"><span class="dir">${call.kind === "task_sms" ? (call.direction === "outbound" ? "Texts" : "They texted") : call.direction === "outbound" ? "Call placed" : "They called back"}</span><span class="muted small">${esc(fmtDate(call.started_at))}${call.call_status ? ` · ${esc(call.call_status)}` : ""}</span></div>
        ${call.recording_sid ? `<audio controls preload="none" src="/app/recordings/${call.id}.mp3"></audio>` : ""}
        ${call.summary ? `<div class="summary"><div class="label">Summary</div>${esc(call.summary)}</div>` : ""}
        ${transcript ? `<div class="label">${call.kind === "task_sms" ? "Messages" : "Transcript"}</div><div class="transcript">${transcript}</div>` : `<p class="muted">${call.kind === "task_sms" ? "No messages." : "No transcript."}</p>`}
      </section>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${task.kind === "sms" ? "Texts" : "Call"} with ${esc(who)} · ${esc(name)}</title>
<style>${BASE_CSS}
header{position:sticky;top:0}
main{max-width:760px;margin:0 auto;padding:20px 16px 40px}
.card{padding:20px;margin-bottom:16px}
.hero{display:flex;gap:14px;align-items:flex-start}
.hero .avatar{width:48px;height:48px;font-size:17px}
.hero h1{margin:0;font-size:20px;letter-spacing:-.015em;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.hero .pill{align-self:center}
.facts{display:grid;gap:12px;margin-top:18px}
.label{font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px}
.fact{padding:12px 14px;border-radius:12px;background:var(--soft)}
.fact.result{background:var(--ok-soft)}
.callhead{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.callhead .dir{font-weight:600}
audio{width:100%;margin:0 0 14px;border-radius:99px}
.summary{padding:12px 14px;border-radius:12px;background:var(--accent-soft);margin-bottom:16px;border-left:3px solid var(--accent)}
.summary .label{color:var(--accent)}
.transcript{display:flex;flex-direction:column;gap:8px}
.line{display:flex;flex-direction:column;max-width:85%;padding:8px 12px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--soft)}
.line b{font-size:11.5px;font-weight:600;color:var(--muted)}
.line.me{align-self:flex-end;background:var(--accent-soft);border-bottom-right-radius:4px}.line.me b{color:var(--accent)}
.line.them{border-bottom-left-radius:4px}
</style></head><body>
<header><a class="ghost" href="/app" style="margin-left:-8px">${ICONS.back}Back to chat</a><span class="hspace"></span>${brand()}</header>
<main>
  <section class="card">
    <div class="hero"><span class="avatar">${initials(who)}</span><div>
      <h1>${esc(who)} <span class="pill ${task.status}">${esc(task.status.replace("_", " "))}</span></h1>
      <div class="muted">${esc(formatPhone(task.target_phone))} · task #${task.id} · ${esc(fmtDate(task.created_at))}</div></div></div>
    <div class="facts">
      <div class="fact"><div class="label">Goal</div>${esc(task.objective)}</div>
      ${task.result ? `<div class="fact result"><div class="label">Result</div>${esc(task.result)}</div>` : ""}
    </div>
  </section>
  ${sections || `<p class="muted" style="text-align:center">${task.kind === "sms" ? "Nothing has been sent yet." : "The call hasn't started yet."}</p>`}
</main></body></html>`;
}

// ---- Login, invite setup, account ------------------------------------------

const FORM_CSS = `
main{display:grid;place-items:center;min-height:100vh;padding:16px;background:radial-gradient(800px 400px at 50% -10%,var(--accent-soft),transparent)}
.panel{width:100%;max-width:400px;padding:28px}
.panel>.mark{width:44px;height:44px;border-radius:13px;margin-bottom:18px}.panel>.mark svg.i{width:21px;height:21px}
.panel h1{font-size:22px;letter-spacing:-.02em;margin:0 0 4px}.panel .sub{color:var(--muted);font-size:14px;margin:0 0 20px}
label{display:block;font-size:13px;font-weight:550;color:var(--ink);margin:14px 0 6px}
input{width:100%;font:inherit;padding:10px 12px;border-radius:11px;border:1px solid var(--line);background:var(--bg);color:var(--ink);transition:border-color .15s,box-shadow .15s}
input:focus{outline:none;border-color:var(--accent);box-shadow:var(--ring)}
button.go{width:100%;margin-top:22px;padding:11px;border:0;border-radius:11px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font-weight:600;box-shadow:0 2px 10px rgba(91,91,214,.3)}
button.go:hover{filter:brightness(1.06)}
.err{color:var(--bad);background:var(--bad-soft);border-radius:10px;padding:8px 12px;font-size:14px;margin:14px 0 0}
.ok{color:var(--ok);background:var(--ok-soft);border-radius:10px;padding:8px 12px;font-size:14px;margin:14px 0 0}
.foot{color:var(--muted);font-size:13px;margin-top:18px;text-align:center}
.backlink{display:inline-flex;align-items:center;gap:4px;margin:-6px 0 14px;font-size:14px;text-decoration:none;color:var(--muted)}.backlink:hover{color:var(--ink)}
.backlink svg.i{width:16px;height:16px}`;

function formPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(name)}</title><style>${BASE_CSS}${FORM_CSS}</style></head>
<body><main><div class="panel card">${body}</div></main></body></html>`;
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
    `<span class="mark">${ICONS.phone}</span><h1>Sign in to ${esc(name)}</h1><p class="sub">Welcome back. Sign in to your account.</p>
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
    `<span class="mark">${ICONS.phone}</span><h1>${reset ? "Set a new password" : `Welcome, ${esc(user.name.split(" ")[0])}`}</h1>
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
    `<a class="backlink" href="/app">${ICONS.back}Back to chat</a>
    <span class="avatar" style="width:44px;height:44px;font-size:16px;margin-bottom:12px">${initials(user.name)}</span>
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
