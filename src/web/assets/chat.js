// Chat page behavior. Served as /assets/chat.js so the page needs no inline script (see the CSP in src/security.ts).
(() => {
  const log = document.getElementById("log"), text = document.getElementById("text"), fileInput = document.getElementById("file");
  const chips = document.getElementById("chips"), errorBox = document.getElementById("error"), sendBtn = document.getElementById("send");
  const AGENT = document.body.dataset.agent || "the assistant";
  const FIRST = document.body.dataset.first || "";
  let lastId = 0, busy = false, files = [], timer, first = true;

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  const svg = (d) => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "i"); s.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); s.append(p);
    return s;
  };
  const PHONE = "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2";
  // Avatar: up to two initials, or a phone icon when the name is just a number.
  const avatar = (s) => {
    const a = el("span", "avatar");
    if (/\p{L}/u.test(s)) a.textContent = s.replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).slice(0, 2).map((w) => (w[0] || "").toUpperCase()).join("");
    else a.append(svg(PHONE));
    return a;
  };

  // Starter prompts on an empty chat. Clicking one fills the box so it can be edited before sending.
  const IDEAS = [
    ["Follow up on a quote", "Call (555) 123-4567, that's Mike at Acme Roofing. Ask for the status of the quote I attached and whether they can start before the 20th."],
    ["Book an appointment", "Call my dentist at (555) 987-6543 and book a cleaning for any weekday morning next week."],
    ["Check store hours", "Call the hardware store at (555) 222-0199 and ask if they're open Sunday and whether they have 2x4s in stock."],
  ];

  function showEmpty() {
    if (log.children.length) return;
    const e = el("div", "empty");
    const mark = el("span", "mark"); mark.append(svg(PHONE));
    const ideas = el("div", "ideas");
    for (const [title, prompt] of IDEAS) {
      const b = el("button", "idea"); b.type = "button";
      b.append(el("b", null, title), el("span", null, prompt));
      b.onclick = () => { text.value = prompt; text.dispatchEvent(new Event("input")); text.focus(); };
      ideas.append(b);
    }
    e.append(
      mark,
      el("h2", null, "Hi " + FIRST + ", who should I call?"),
      el("p", null, "I can phone people and businesses for you and report back here. Attach a photo or PDF and I'll use it on the call."),
      ideas,
    );
    e.id = "empty";
    log.append(e);
  }

  function addMessage(m) {
    document.getElementById("empty")?.remove();
    const row = el("div", "row " + m.role);
    const bubble = el("div", "msg " + m.role, m.body);
    if (m.role === "assistant") { const av = el("span", "avatar"); av.append(svg(PHONE)); row.append(av); }
    for (const f of m.files) {
      if (f.type.startsWith("image/")) {
        const a = el("a"); a.href = "/app/files/" + f.id; a.target = "_blank";
        const img = el("img"); img.src = a.href; img.alt = "Attached photo"; a.append(img); bubble.append(a);
      } else {
        const a = el("a", "file", "📄 Attached " + (f.type === "application/pdf" ? "PDF" : "file")); a.href = "/app/files/" + f.id; a.target = "_blank";
        bubble.append(el("br"), a);
      }
    }
    bubble.append(el("span", "time", m.time));
    row.append(bubble);
    log.append(row);
  }

  function renderTasks(tasks) {
    const list = document.getElementById("taskList");
    document.getElementById("tasksHeading").textContent = "Calls & numbers";
    const badge = document.getElementById("menuBadge");
    badge.textContent = tasks.length > 99 ? "99+" : String(tasks.length);
    badge.hidden = !tasks.length;
    list.replaceChildren();
    if (!tasks.length) { list.append(el("p", "muted", "No calls yet.")); return; }
    for (const t of tasks) {
      const a = el("a", "task"); a.href = "/app/tasks/" + t.id;
      const top = el("div", "top"); top.append(el("span", null, t.who), el("span", "pill " + t.status, t.status.replace("_", " ")));
      const body = el("div", "body"); body.append(top, el("div", "obj", t.objective), el("div", "when", t.time));
      a.append(avatar(t.who), body);
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

  const clearChat = async () => {
    if (!confirm("Clear this chat? " + AGENT + " will forget it and your calls, and your number list is cleared too (those numbers can't call back until you call them again).")) return;
    if (!(await post("/app/api/chat/clear"))) return;
    lastId = 0; first = true; numbersKey = "";
    log.replaceChildren();
    closeMenu();
    poll();
  };
  document.querySelectorAll(".js-clear-chat").forEach((b) => { b.onclick = clearChat; });

  // ---- Mobile menu: the calls & numbers sidebar slides in as a drawer. ----
  const drawer = document.getElementById("tasks");
  const backdrop = document.getElementById("backdrop");
  const openBtn = document.getElementById("menuOpen");
  const closeBtn = document.getElementById("menuClose");
  const mobile = matchMedia("(max-width: 760px)");
  function openMenu() {
    drawer.classList.add("open");
    backdrop.classList.add("show");
    document.body.classList.add("menu-open");
    openBtn.setAttribute("aria-expanded", "true");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    closeBtn.focus();
  }
  function closeMenu() {
    if (!drawer.classList.contains("open")) return;
    drawer.classList.remove("open");
    backdrop.classList.remove("show");
    document.body.classList.remove("menu-open");
    openBtn.setAttribute("aria-expanded", "false");
    drawer.removeAttribute("role");
    drawer.removeAttribute("aria-modal");
    if (mobile.matches) openBtn.focus();
  }
  openBtn.onclick = openMenu;
  closeBtn.onclick = closeMenu;
  backdrop.onclick = closeMenu;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  drawer.addEventListener("click", (e) => { if (e.target.closest("a[href]")) closeMenu(); });
  mobile.addEventListener("change", () => { if (!mobile.matches) closeMenu(); });

  function setTyping(on) {
    document.getElementById("typing")?.remove();
    if (on) {
      const t = el("div", "typing"); t.id = "typing";
      const dots = el("span", "dots"); dots.append(el("i"), el("i"), el("i"));
      t.append(dots, AGENT + " is working on it…");
      log.append(t);
    }
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
