// Chat page behavior. Served as /assets/chat.js so the page needs no inline script (see the CSP in src/security.ts).
(() => {
  const log = document.getElementById("log"), text = document.getElementById("text"), fileInput = document.getElementById("file");
  const chips = document.getElementById("chips"), errorBox = document.getElementById("error"), sendBtn = document.getElementById("send");
  const AGENT = document.body.dataset.agent || "the assistant";
  const FIRST = document.body.dataset.first || "";
  let lastId = 0, busy = false, files = [], timer, first = true;

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  function showEmpty() {
    if (log.children.length) return;
    const e = el("div", "empty");
    const hi = el("p");
    hi.append(el("b", null, "Hi " + FIRST + "!"), " I can phone people and businesses for you and report back here.");
    e.append(
      hi,
      el("p", null, "Try: “Call (555) 123-4567, that's Mike at Acme Roofing. Ask for the status of this quote and whether they can start before the 20th,” and attach a photo of the quote."),
      el("p", null, "Calls start by saying I'm an AI assistant and that the call is recorded."),
    );
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
    document.getElementById("tasksToggle").textContent = tasks.length ? "Calls & numbers (" + tasks.length + ")" : "Calls & numbers";
    list.replaceChildren();
    if (!tasks.length) { list.append(el("p", "muted", "No calls yet.")); return; }
    for (const t of tasks) {
      const a = el("a", "task"); a.href = "/app/tasks/" + t.id;
      const top = el("div", "top"); top.append(el("span", null, t.who), el("span", "pill " + t.status, t.status.replace("_", " ")));
      a.append(top, el("div", "obj", t.objective), el("div", "muted", t.time));
      list.append(a);
    }
  }

  let numbersKey = "";
  function renderNumbers(numbers) {
    const key = JSON.stringify(numbers);
    if (key === numbersKey) return;
    numbersKey = key;
    const list = document.getElementById("numberList");
    document.getElementById("clearNumbers").hidden = !numbers.length;
    list.replaceChildren();
    if (!numbers.length) { list.append(el("p", "muted", "No numbers yet.")); return; }
    for (const n of numbers) {
      const row = el("div", "num");
      const who = el("div", "who");
      who.append(el("div", "nm", n.name || n.phone), el("div", "ph", (n.name ? n.phone + " · " : "") + "last called " + n.lastCalled));
      const label = el("label", "switch");
      const box = el("input");
      box.type = "checkbox"; box.setAttribute("role", "switch"); box.checked = n.callbackAllowed;
      box.setAttribute("aria-label", "Allow " + (n.name || n.phone) + " to call back");
      box.onchange = async () => {
        errorBox.textContent = "";
        const res = await fetch("/app/api/numbers/" + n.id, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allowed: box.checked }),
        }).catch(() => null);
        if (!res || !res.ok) { box.checked = !box.checked; errorBox.textContent = "Couldn't change that. Try again."; return; }
        numbersKey = "";
      };
      label.append(box, el("span", null, "Call back"));
      row.append(who, label);
      list.append(row);
    }
  }

  async function post(url) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
    if (res?.status === 401) { location.reload(); return false; }
    if (!res || !res.ok) { errorBox.textContent = "Something went wrong. Try again."; return false; }
    return true;
  }

  document.getElementById("clearNumbers").onclick = async () => {
    if (!confirm("Clear your number list? These numbers won't be able to call back until you ask " + AGENT + " to call them again.")) return;
    if (await post("/app/api/numbers/clear")) { numbersKey = ""; poll(); }
  };

  document.getElementById("clearChat").onclick = async () => {
    if (!confirm("Clear this chat? " + AGENT + " will forget it and your calls, and your number list is cleared too (those numbers can't call back until you call them again).")) return;
    if (!(await post("/app/api/chat/clear"))) return;
    lastId = 0; first = true; numbersKey = "";
    log.replaceChildren();
    poll();
  };

  function setTyping(on) {
    document.getElementById("typing")?.remove();
    if (on) { const t = el("div", "typing", AGENT + " is working on it…"); t.id = "typing"; log.append(t); }
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
          new Notification(AGENT, { body: m.body.slice(0, 140) });
        }
      }
      busy = state.busy;
      document.getElementById("callsOff").hidden = state.callsEnabled !== false;
      setTyping(busy);
      renderTasks(state.tasks);
      renderNumbers(state.numbers || []);
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
