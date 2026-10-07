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
.pill{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
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
aside{width:300px;border-left:1px solid var(--line);overflow-y:auto;padding:16px;background:var(--card)}
aside h3{margin:0 0 10px;font-size:15px}
.task{display:block;text-decoration:none;color:inherit;padding:10px 0;border-bottom:1px solid var(--line)}
.task .top{display:flex;justify-content:space-between;gap:8px;font-weight:500}
.task .obj{color:var(--muted);font-size:13px;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.muted{color:var(--muted);font-size:14px}
@media (max-width:760px){.layout{flex-direction:column}aside{width:auto;border-left:0;border-top:1px solid var(--line);max-height:30vh;order:-1}aside.collapsed .list{display:none}aside h3{cursor:pointer;margin:0}aside h3::after{content:" ▾";color:var(--muted)}aside:not(.collapsed) h3{margin-bottom:6px}aside:not(.collapsed) h3::after{content:" ▴"}}
</style></head>
<body>
<header><span class="title">${esc(name)}</span><span class="who">${esc(user.name)}</span>
<form method="post" action="/app/logout"><button>Sign out</button></form></header>
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
  <aside id="tasks" class="collapsed"><h3 id="tasksToggle">Your calls</h3><div class="list" id="taskList"><p class="muted">No calls yet.</p></div></aside>
</div>
<script>
(() => {
  const log = document.getElementById("log"), text = document.getElementById("text"), fileInput = document.getElementById("file");
  const chips = document.getElementById("chips"), errorBox = document.getElementById("error"), sendBtn = document.getElementById("send");
  let lastId = 0, busy = false, files = [], timer, first = true;

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  function showEmpty() {
    if (log.children.length) return;
    const e = el("div", "empty");
    e.innerHTML = "<p><b>Hi ${esc(user.name.split(" ")[0])}!</b> I can phone people and businesses for you and report back here.</p>" +
      "<p>Try: “Call (555) 123-4567, that's Mike at Acme Roofing. Ask for the status of this quote and whether they can start before the 20th,” and attach a photo of the quote.</p>" +
      "<p>Calls start by saying I'm an AI assistant and that the call is recorded.</p>";
    e.id = "empty";
    log.append(e);
  }

  function addMessage(m) {
    document.getElementById("empty")?.remove();
    const bubble = el("div", "msg " + m.role, m.body);
    for (const f of m.files) {
      if (f.type.startsWith("image/")) {
        const a = el("a"); a.href = "/app/files/" + f.id; a.target = "_blank";
        const img = el("img"); img.src = a.href; img.alt = "Attached photo"; a.append(img); bubble.append(a);
      } else {
        const a = el("a", null, "📄 Attached " + (f.type === "application/pdf" ? "PDF" : "file")); a.href = "/app/files/" + f.id; a.target = "_blank";
        bubble.append(el("br"), a);
      }
    }
    bubble.append(el("span", "time", m.time));
    log.append(bubble);
  }

  function renderTasks(tasks) {
    const list = document.getElementById("taskList");
    document.getElementById("tasksToggle").textContent = tasks.length ? "Your calls (" + tasks.length + ")" : "Your calls";
    list.replaceChildren();
    if (!tasks.length) { list.append(el("p", "muted", "No calls yet.")); return; }
    for (const t of tasks) {
      const a = el("a", "task"); a.href = "/app/tasks/" + t.id;
      const top = el("div", "top"); top.append(el("span", null, t.who), el("span", "pill " + t.status, t.status.replace("_", " ")));
      a.append(top, el("div", "obj", t.objective), el("div", "muted", t.time));
      list.append(a);
    }
  }

  function setTyping(on) {
    document.getElementById("typing")?.remove();
    if (on) { const t = el("div", "typing", "${esc(name)} is working on it…"); t.id = "typing"; log.append(t); }
  }

  async function poll() {
    clearTimeout(timer);
    try {
      const res = await fetch("/app/api/state?after=" + lastId);
      if (res.status === 401) { location.reload(); return; }
      const state = await res.json();
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      document.getElementById("typing")?.remove();
      for (const m of state.messages) {
        addMessage(m);
        lastId = m.id;
        if (!first && m.role === "assistant" && document.hidden && window.Notification?.permission === "granted") {
          new Notification("${esc(name)}", { body: m.body.slice(0, 140) });
        }
      }
      busy = state.busy;
      setTyping(busy);
      renderTasks(state.tasks);
      showEmpty();
      if (first || nearBottom || state.messages.some((m) => m.role === "user")) log.scrollTop = log.scrollHeight;
      first = false;
    } catch (e) { /* network blip; try again */ }
    timer = setTimeout(poll, busy ? 1500 : document.hidden ? 15000 : 4000);
  }

  function renderChips() {
    chips.replaceChildren(...files.map((f) => el("span", null, "📎 " + f.name)));
  }

  const readFile = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, type: file.type, data: String(r.result).split(",")[1] });
    r.onerror = reject;
    r.readAsDataURL(file);
  });

  document.getElementById("attach").onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    errorBox.textContent = "";
    const picked = [...fileInput.files].slice(0, 3);
    if (picked.some((f) => f.size > 10 * 1024 * 1024)) { errorBox.textContent = "Each file must be under 10 MB."; return; }
    files = await Promise.all(picked.map(readFile));
    fileInput.value = "";
    renderChips();
  };

  text.addEventListener("input", () => { text.style.height = "auto"; text.style.height = Math.min(text.scrollHeight, 160) + "px"; });
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer:fine)").matches) { e.preventDefault(); send(); }
  });
  document.getElementById("composer").onsubmit = (e) => { e.preventDefault(); send(); };
  document.getElementById("tasksToggle").onclick = () => document.getElementById("tasks").classList.toggle("collapsed");
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

  async function send() {
    const body = text.value.trim();
    if (!body && !files.length) return;
    errorBox.textContent = "";
    sendBtn.disabled = true;
    if (window.Notification?.permission === "default") Notification.requestPermission();
    try {
      const res = await fetch("/app/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body, files: files.map(({ type, data }) => ({ type, data })) }),
      });
      if (res.status === 401) { location.reload(); return; }
      const out = await res.json();
      if (!res.ok) { errorBox.textContent = out.error || "Couldn't send that."; return; }
      text.value = ""; text.style.height = "auto"; files = []; renderChips();
      busy = true;
      await poll();
    } catch (e) {
      errorBox.textContent = "Couldn't reach the server. Check your connection and try again.";
    } finally {
      sendBtn.disabled = false;
      text.focus();
    }
  }

  poll();
})();
</script>
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
