/* twind: one deeper conversation a day.
   Plain JavaScript, no build step. Talks to Supabase for sign-in, data,
   live updates and the two Edge Functions (notifications + Gemini). */
(() => {
  "use strict";

  const CFG = window.TWIND_CONFIG || {};
  const $app = document.getElementById("app");
  const $toast = document.getElementById("toast");

  const S = {
    sb: null, user: null, members: [], me: null, partner: null, couple: null,
    bank: null, view: "today", today: null, todayISO: null, answers: [],
    history: null, used: new Set(), rotation: 0, rotationKey: "", spinning: false,
    busy: false, pushOn: false, talkLoading: false, editing: false,
    authMode: "signin", recovery: false, pairMode: null, notice: null, dirty: false,
  };

  // ---------- small helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };
  let toastTimer;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.remove("show"), 3600);
  }
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

  function localISO(tz, date = new Date()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }
  function prettyDate(iso, opts = { weekday: "long", month: "short", day: "numeric" }) {
    return new Date(iso + "T12:00:00").toLocaleDateString("en-US", opts);
  }
  function fmtTime(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }

  // ---------- icons (inline so they inherit color) ----------
  const ICON = {
    today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 3.5v4M12 12l3.5 2"></path></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"></path></svg>',
    wheel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 3.5v17M4.6 7.8l14.8 8.4M19.4 7.8 4.6 16.2"></path></svg>',
    lock: '<svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="#7A2E3B" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>',
    check: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#E9C58E" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>',
    chat: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"></path></svg>',
  };

  // ---------- wedges ----------
  const WEIGHT = { off: 0, less: 0.5, normal: 1, more: 2 };
  const wedgeById = (id) => S.bank.wedges.find((w) => w.id === id) || { id, label: id, color: "#7A2E3B", questions: [] };
  function intimacyOn() {
    return S.members.length === 2 && S.members.every((m) => m.intimacy_opt_in);
  }
  function activeWedges() {
    const weights = (S.couple && S.couple.wedge_weights) || {};
    return S.bank.wedges.filter((w) => {
      if (w.id === "intimacy" && !intimacyOn()) return false;
      return (WEIGHT[weights[w.id] || "normal"] ?? 1) > 0;
    });
  }
  function weightedPick(list) {
    const weights = (S.couple && S.couple.wedge_weights) || {};
    const total = list.reduce((t, w) => t + (WEIGHT[weights[w.id] || "normal"] ?? 1), 0);
    let r = Math.random() * total;
    for (const w of list) {
      r -= WEIGHT[weights[w.id] || "normal"] ?? 1;
      if (r <= 0) return w;
    }
    return list[list.length - 1];
  }
  function pickQuestion(wedgeId, avoid) {
    const all = wedgeById(wedgeId).questions;
    const fresh = all.filter((q) => !S.used.has(q) && q !== avoid);
    const pool = fresh.length ? fresh : all.filter((q) => q !== avoid);
    return pool[Math.floor(Math.random() * pool.length)] || all[0];
  }

  function wheelSVG(list) {
    const n = list.length, seg = 360 / n, r = 146, c = 150;
    const rad = (d) => ((d - 90) * Math.PI) / 180;
    let out = "";
    list.forEach((w, i) => {
      if (n === 1) {
        out += `<circle cx="150" cy="150" r="${r}" fill="${w.color}"></circle>`;
      } else {
        const a0 = rad(i * seg), a1 = rad((i + 1) * seg);
        const large = seg > 180 ? 1 : 0;
        out += `<path d="M${c} ${c} L${(c + r * Math.cos(a0)).toFixed(1)} ${(c + r * Math.sin(a0)).toFixed(1)} A${r} ${r} 0 ${large} 1 ${(c + r * Math.cos(a1)).toFixed(1)} ${(c + r * Math.sin(a1)).toFixed(1)} Z" fill="${w.color}" stroke="#F7EFEA" stroke-width="3"></path>`;
      }
      const m = (i + 0.5) * seg, lx = c + 96 * Math.cos(rad(m)), ly = c + 96 * Math.sin(rad(m));
      const rot = m > 90 && m < 270 ? m - 180 : m;
      const size = w.label.length > 7 ? 12 : 14;
      out += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" transform="rotate(${rot.toFixed(1)} ${lx.toFixed(1)} ${ly.toFixed(1)})" text-anchor="middle" dominant-baseline="middle" fill="#FFFFFF" font-size="${size}" font-weight="700" font-family="DM Sans, sans-serif">${esc(w.label)}</text>`;
    });
    out += '<circle cx="150" cy="150" r="26" fill="#F7EFEA"></circle><circle cx="150" cy="150" r="8" fill="#B8894A"></circle>';
    return `<svg viewBox="0 0 300 300" role="img" aria-label="Topic wheel: ${esc(list.map((w) => w.label).join(", "))}">${out}</svg>`;
  }
  function rotationFor(list, wedgeId) {
    const i = list.findIndex((w) => w.id === wedgeId);
    if (i < 0) return 0;
    const center = (i + 0.5) * (360 / list.length);
    return (360 - center) % 360;
  }
  function wheelBlock(list) {
    return `
      <div class="wheel-wrap">
        <svg class="wheel-pointer" viewBox="0 0 28 26" aria-hidden="true"><path d="M14 26 L2 4 Q14 -2 26 4 Z" fill="#3A1F24" stroke="#F7EFEA" stroke-width="2"></path></svg>
        <div class="wheel" id="wheel" style="transform: rotate(${S.rotation}deg)">${wheelSVG(list)}</div>
      </div>`;
  }

  // ---------- data ----------
  async function loadPair() {
    const { data: members, error } = await S.sb.from("members").select("*");
    if (error) throw error;
    S.members = members || [];
    S.me = S.members.find((m) => m.user_id === S.user.id) || null;
    S.partner = S.members.find((m) => m.user_id !== S.user.id) || null;
    if (S.me) {
      const { data: couple } = await S.sb.from("couples").select("*").single();
      S.couple = couple;
    }
  }
  async function loadToday() {
    if (!S.couple) return;
    S.todayISO = localISO(S.couple.tz);
    const [{ data: day }, { data: answers }] = await Promise.all([
      S.sb.from("days").select("*").eq("day", S.todayISO).maybeSingle(),
      S.sb.from("answers").select("*").eq("day", S.todayISO),
    ]);
    S.today = day || null;
    S.answers = answers || [];
  }
  async function loadUsed() {
    const { data } = await S.sb.from("days").select("question").order("day", { ascending: false }).limit(400);
    S.used = new Set((data || []).map((d) => d.question));
  }
  async function loadHistory() {
    const { data: days } = await S.sb.from("days").select("*").order("day", { ascending: false }).limit(120);
    const list = days || [];
    let answers = [];
    if (list.length) {
      const res = await S.sb.from("answers").select("*").in("day", list.map((d) => d.day));
      answers = res.data || [];
    }
    S.history = { days: list, answers };
  }
  async function refresh() {
    if (!S.user) return;
    try {
      await loadPair();
      if (S.me && S.members.length === 2) await loadToday();
      if (S.view === "history" && S.me) await loadHistory();
    } catch (e) {
      toast(e.message || "Couldn't reach twind. Check your connection.");
    }
    render();
  }

  // ---------- live updates ----------
  let channel = null, liveTimer = null;
  function subscribeLive() {
    if (!S.couple || channel) return;
    const filter = `couple_id=eq.${S.couple.id}`;
    const onChange = () => {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(async () => {
        if (S.spinning) return;
        await loadPair();
        await loadToday();
        if (S.view === "history") await loadHistory();
        safeRender();
      }, 300);
    };
    channel = S.sb.channel("twind-" + S.couple.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "days", filter }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "answers", filter }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "members", filter }, onChange)
      .subscribe();
  }
  // Don't wipe out something being typed.
  function safeRender() {
    const a = document.activeElement;
    if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT")) { S.dirty = true; return; }
    render();
  }
  document.addEventListener("focusout", () => {
    setTimeout(() => { if (S.dirty && !document.activeElement?.matches?.("textarea, input")) { S.dirty = false; render(); } }, 50);
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });

  // ---------- functions (notifications + AI) ----------
  function notify(event) {
    S.sb.functions.invoke("twind-notify", { body: { event } }).catch(() => {});
  }
  async function ai(body, ms = 12000) {
    try {
      const res = await withTimeout(S.sb.functions.invoke("twind-ai", { body }), ms);
      return res && !res.error ? res.data : null;
    } catch { return null; }
  }

  // ---------- push notifications ----------
  function b64ToBytes(b64) {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  async function checkPush() {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || Notification.permission !== "granted") { S.pushOn = false; return; }
      const reg = await navigator.serviceWorker.ready;
      S.pushOn = !!(await reg.pushManager.getSubscription());
    } catch { S.pushOn = false; }
  }
  async function enablePush() {
    if (isIOS && !isStandalone()) { toast("Add twind to your Home Screen first: tap Share, then Add to Home Screen."); return; }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) { toast("This browser can't show notifications."); return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Notifications are blocked. You can allow them in your phone's Settings."); return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(CFG.VAPID_PUBLIC_KEY) });
      const j = sub.toJSON();
      const { error } = await S.sb.from("push_subs").upsert({ endpoint: j.endpoint, user_id: S.user.id, p256dh: j.keys.p256dh, auth: j.keys.auth });
      if (error) throw error;
      S.pushOn = true;
      toast("Notifications are on.");
      render();
    } catch (e) {
      toast("Couldn't turn on notifications: " + (e.message || e));
    }
  }

  // ---------- rendering ----------
  function header(right = "") {
    return `<header class="top">
      <div class="brand"><img src="mark.svg" alt=""><span class="wordmark">twind</span></div>
      ${right}
    </header>`;
  }
  function tabs() {
    const t = (id, label) => `<button type="button" data-action="tab" data-tab="${id}" ${S.view === id ? 'aria-current="page"' : ""}>${ICON[id]}${label}</button>`;
    return `<div class="tabs"><nav aria-label="Main">${t("today", "Today")}${t("history", "History")}${t("wheel", "Wheel")}</nav></div>`;
  }
  function render() {
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) return renderUnconfigured();
    if (!S.user) return renderAuth();
    if (S.recovery) return renderRecovery();
    if (!S.me) return renderPair();
    if (S.members.length < 2) return renderInvite();
    if (S.view === "history") return renderHistory();
    if (S.view === "wheel") return renderWheelSettings();
    return renderToday();
  }

  function renderUnconfigured() {
    $app.innerHTML = `<main class="shell no-tabs">${header()}
      <div class="grow"><h1>Almost there</h1>
      <p class="sub">twind isn't connected to its database yet. Add the Supabase URL and anon key to config.js.</p></div></main>`;
  }

  function renderAuth() {
    const signup = S.authMode === "signup";
    $app.innerHTML = `<main class="shell no-tabs">${header()}
      <div class="stack lg" style="margin-top: 8vh">
        <h1>${signup ? "Create your account" : "Welcome back"}</h1>
        <p class="sub">One deeper conversation a day, just for the two of you.</p>
        ${S.notice ? `<div class="card paper"><p class="sub" style="color: var(--ink)">${esc(S.notice)}</p></div>` : ""}
        <form class="stack lg" data-form="auth">
          <div class="field"><label for="email">Email</label><input class="input" id="email" name="email" type="email" autocomplete="email" required></div>
          <div class="field"><label for="pw">Password</label><input class="input" id="pw" name="password" type="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="8" required></div>
          <button class="btn" type="submit" ${S.busy ? "disabled" : ""}>${signup ? "Create account" : "Sign in"}</button>
        </form>
        <button class="btn link" type="button" data-action="auth-mode">${signup ? "I already have an account" : "New here? Create an account"}</button>
        ${signup ? "" : '<button class="btn link" type="button" data-action="forgot">Forgot password</button>'}
      </div></main>`;
  }

  function renderRecovery() {
    $app.innerHTML = `<main class="shell no-tabs">${header()}
      <form class="stack lg" data-form="newpw" style="margin-top: 8vh">
        <h1>Set a new password</h1>
        <div class="field"><label for="npw">New password</label><input class="input" id="npw" name="password" type="password" autocomplete="new-password" minlength="8" required></div>
        <button class="btn" type="submit">Save password</button>
      </form></main>`;
  }

  function renderPair() {
    const join = S.pairMode === "join";
    $app.innerHTML = `<main class="shell no-tabs">${header('<button class="btn link" type="button" data-action="signout">Sign out</button>')}
      <div class="stack lg" style="margin-top: 4vh">
        <h1>${join ? "Join your spouse" : "Let's set up twind"}</h1>
        <p class="sub">${join ? "Enter the six-letter code from their phone." : "One of you starts it, then shares a code with the other."}</p>
        <form class="stack lg" data-form="${join ? "join" : "create"}">
          <div class="field"><label for="nm">Your first name</label><input class="input" id="nm" name="name" autocomplete="given-name" maxlength="30" required></div>
          ${join ? '<div class="field"><label for="cd">Code</label><input class="input" id="cd" name="code" autocapitalize="characters" autocomplete="off" maxlength="6" required style="text-transform: uppercase; letter-spacing: 4px"></div>' : ""}
          <button class="btn" type="submit" ${S.busy ? "disabled" : ""}>${join ? "Join" : "Start our twind"}</button>
        </form>
        <button class="btn ghost" type="button" data-action="pair-mode">${join ? "I'm the one starting it" : "I have a code"}</button>
      </div></main>`;
  }

  function renderInvite() {
    $app.innerHTML = `<main class="shell no-tabs">${header('<button class="btn link" type="button" data-action="signout">Sign out</button>')}
      <div class="grow">
        <h1>Invite your spouse</h1>
        <p class="sub">Have them open twind, create an account, tap "I have a code" and enter:</p>
        <div class="code" aria-label="Code ${esc(S.couple?.invite_code.split("").join(" "))}">${esc(S.couple?.invite_code)}</div>
        <button class="btn" type="button" data-action="share-code" style="max-width: 280px">Share the code</button>
        <p class="sub">This screen updates on its own once they join.</p>
      </div></main>`;
  }

  function stageOf() {
    const d = S.today, me = S.user.id, p = S.partner.user_id;
    if (!d) return "spin";
    if (!d.locked) return d.spinner === me ? "landed" : "partner-spinning";
    const answered = d.answered || [];
    const mine = answered.includes(me), theirs = answered.includes(p);
    if (mine && theirs) return "reveal";
    if (!mine || S.editing) return "answer";
    return "waiting";
  }

  function pushNudge() {
    if (S.pushOn) return "";
    return `<div class="card paper stack">
      <p class="sub" style="color: var(--ink)">Turn on notifications so you know when ${esc(S.partner.display_name)} spins or answers.</p>
      <button class="btn ghost" type="button" data-action="push">Turn on notifications</button>
    </div>`;
  }

  function renderToday() {
    const stage = stageOf();
    const d = S.today;
    const list = activeWedges();
    const w = d ? wedgeById(d.wedge) : null;
    const partner = esc(S.partner.display_name);
    const key = d ? d.day + d.wedge + d.spins : "";
    if (d && key !== S.rotationKey && !S.spinning) { S.rotation = rotationFor(list, d.wedge); S.rotationKey = key; }
    const chip = (extra = "") => `<span class="chip" style="background:${w.color}">${esc(w.label)}${extra}</span>`;
    let body = "";

    if (stage === "spin") {
      body = `
        <div class="stack"><h1>You're first today</h1><p class="sub">Spin to pick the topic for both of you.</p></div>
        ${wheelBlock(list)}
        <div class="stack push">
          <button class="btn" type="button" data-action="spin" ${S.spinning ? "disabled" : ""}>${S.spinning ? "Spinning…" : "Spin"}</button>
          <p class="sub" style="text-align:center; font-size: 13px">You get one re-spin if you don't love the question.</p>
        </div>`;
    } else if (stage === "landed") {
      body = `
        <div class="stack"><h1>It landed on ${esc(w.label)}</h1><p class="sub">Lock it in and ${partner} gets a heads-up.</p></div>
        ${wheelBlock(list)}
        <div class="stack lg push">
          <div class="card stack">${chip()}<p class="question">${esc(d.question)}</p></div>
          <button class="btn" type="button" data-action="lock" ${S.busy ? "disabled" : ""}>Lock it in</button>
          ${d.spins < 2
            ? `<button class="btn ghost" type="button" data-action="spin" ${S.spinning ? "disabled" : ""}>Re-spin (1 left)</button>`
            : `<p class="sub" style="text-align:center; font-size: 13px">No re-spins left. This one's yours today.</p>`}
        </div>`;
    } else if (stage === "partner-spinning") {
      body = `<div class="grow">
          <h1>${partner} is spinning</h1>
          <p class="sub">They got here first today. You'll see the question as soon as they lock it in.</p>
        </div>${pushNudge()}`;
    } else if (stage === "answer") {
      const draftKey = "twind-draft-" + d.day;
      const mine = S.answers.find((a) => a.user_id === S.user.id);
      const draft = store.get(draftKey) ?? (mine ? mine.body : "");
      const theirs = (d.answered || []).includes(S.partner.user_id);
      body = `
        <div class="stack">
          ${chip(d.spinner === S.user.id ? " · you spun" : ` · ${partner} spun`)}
          <h1 class="question" style="font-size: 30px">${esc(d.question)}</h1>
          <p class="sub" style="color: var(--plum)">${theirs ? `${partner} already answered. Yours reveals both.` : `${partner} can't see your answer until they answer too.`}</p>
        </div>
        <form class="stack lg" data-form="answer" style="flex: 1">
          <div class="field" style="flex: 1">
            <label for="ans">Your answer</label>
            <textarea class="input" id="ans" name="body" data-draft="${esc(draftKey)}" placeholder="Take your time. Be honest." maxlength="5000" required>${esc(draft)}</textarea>
          </div>
          <button class="btn" type="submit" ${S.busy ? "disabled" : ""}>${mine ? "Save my answer" : "Submit answer"}</button>
          ${S.editing ? '<button class="btn link" type="button" data-action="cancel-edit">Cancel</button>' : ""}
        </form>`;
    } else if (stage === "waiting") {
      body = `<div class="grow">
          ${ICON.lock}
          <h1>Your answer is in</h1>
          <p class="sub">You'll both see each other's answers as soon as ${partner} answers.</p>
          <button class="btn link" type="button" data-action="edit">Edit my answer</button>
        </div>${pushNudge()}`;
    } else if (stage === "reveal") {
      const mine = S.answers.find((a) => a.user_id === S.user.id);
      const theirs = S.answers.find((a) => a.user_id === S.partner.user_id);
      if (!d.talk_prompt && !S.talkLoading && S.talkTried !== d.day) loadTalkPrompt(d.day);
      const prompt = d.talk_prompt || "Pick the one line from each other's answer that surprised you, and start there.";
      body = `
        <div class="stack">${chip()}<p class="question sm">${esc(d.question)}</p></div>
        <div class="stack">
          <div class="card answer-card"><div class="who" style="color: var(--wine)">You</div><p>${esc(mine?.body)}</p></div>
          <div class="card answer-card"><div class="who" style="color: var(--plum)">${partner}</div><p>${esc(theirs?.body)}</p></div>
        </div>
        <div class="card dark stack push">
          <div class="label" style="display:flex; align-items:center; gap:8px">${ICON.chat} Talk about this tonight</div>
          <p style="margin:0; font-size:16px; line-height:1.45">${esc(prompt)}</p>
        </div>
        ${d.talked_at
          ? `<div class="stack center"><div class="done-badge">${ICON.check}</div><p class="sub">You talked about this. It's saved in your history.</p></div>`
          : `<button class="btn" type="button" data-action="talked" ${S.busy ? "disabled" : ""}>We talked about it</button>`}`;
    }

    $app.innerHTML = `<main class="shell">${header(`<span class="date">${esc(prettyDate(S.todayISO))}</span>`)}${body}</main>${tabs()}`;
  }

  function statusFor(d) {
    const a = d.answered || [], me = S.user.id, p = S.partner.user_id;
    const partner = S.partner.display_name;
    if (d.talked_at) return { text: "Talked", cls: "talked" };
    if (a.includes(me) && a.includes(p)) return { text: "Both answered", cls: "" };
    if (!d.locked) return { text: "Never locked in", cls: "" };
    const isToday = d.day === S.todayISO;
    if (a.includes(me)) return { text: isToday ? `Waiting on ${partner}` : "Only you answered", cls: "" };
    if (a.includes(p)) return { text: isToday ? "Waiting on you" : `Only ${partner} answered`, cls: "" };
    return { text: isToday ? "Not answered yet" : "No answers", cls: "" };
  }

  function renderHistory() {
    if (!S.history) {
      $app.innerHTML = `<main class="shell">${header()}<h1>Our conversations</h1><p class="sub">Loading…</p></main>${tabs()}`;
      loadHistory().then(render);
      return;
    }
    const { days, answers } = S.history;
    const month = S.todayISO.slice(0, 7);
    const talks = days.filter((d) => d.talked_at && d.day.startsWith(month)).length;
    const counts = {};
    days.slice(0, 60).filter((d) => d.talked_at).forEach((d) => { counts[d.wedge] = (counts[d.wedge] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const lastYear = new Date(S.todayISO + "T12:00:00"); lastYear.setFullYear(lastYear.getFullYear() - 1);
    const ly = days.find((d) => d.day === lastYear.toISOString().slice(0, 10));

    const item = (d) => {
      const w = wedgeById(d.wedge), st = statusFor(d);
      const mine = answers.find((a) => a.day === d.day && a.user_id === S.user.id);
      const theirs = answers.find((a) => a.day === d.day && a.user_id === S.partner.user_id);
      const hidden = !theirs && (d.answered || []).includes(S.partner.user_id);
      return `<details class="day">
        <summary>
          <span class="row"><span class="chip" style="background:${w.color}; font-size:12px; padding:3px 10px">${esc(w.label)}</span>
          <span class="status ${st.cls}">${esc(st.text)} · ${esc(prettyDate(d.day, { weekday: "short", month: "short", day: "numeric" }))}</span></span>
          <p class="q">${esc(d.question)}</p>
        </summary>
        <div class="body">
          ${mine ? `<div class="card answer-card"><div class="who" style="color: var(--wine)">You</div><p>${esc(mine.body)}</p></div>` : ""}
          ${theirs ? `<div class="card answer-card"><div class="who" style="color: var(--plum)">${esc(S.partner.display_name)}</div><p>${esc(theirs.body)}</p></div>` : ""}
          ${hidden ? `<p class="sub">${esc(S.partner.display_name)}'s answer shows once you answer too.</p>` : ""}
          ${d.talk_prompt ? `<p class="sub"><b>Talk prompt:</b> ${esc(d.talk_prompt)}</p>` : ""}
          ${!mine && !theirs && !hidden ? '<p class="sub">No answers that day.</p>' : ""}
        </div>
      </details>`;
    };

    $app.innerHTML = `<main class="shell">${header()}
      <h1>Our conversations</h1>
      <div class="stats">
        <div class="stat"><b>${talks}</b><span>talk${talks === 1 ? "" : "s"} this month</span></div>
        <div class="stat"><b>${top ? esc(wedgeById(top[0]).label) : "—"}</b><span>${top ? "your deepest topic lately" : "mark a talk to see this"}</span></div>
      </div>
      ${ly ? `<div class="card dark stack"><div class="label">On this day last year</div><p style="margin:0; font-size:16px; line-height:1.4">${esc(ly.question)}</p></div>` : ""}
      <div class="stack">
        ${days.length ? days.map(item).join("") : '<p class="sub">Your first conversation will show up here.</p>'}
      </div>
    </main>${tabs()}`;
  }

  function renderWheelSettings() {
    const weights = S.couple.wedge_weights || {};
    const row = (w) => {
      const level = weights[w.id] || "normal";
      const b = (v, label) => `<button type="button" data-action="weight" data-wedge="${w.id}" data-level="${v}" aria-pressed="${level === v}">${label}</button>`;
      const NOTES = {
        faith: "Prayer, gratitude, growing", us: "How we're doing", future: "Dreams, plans, family",
        reflection: "What's on your mind", fun: "Light and easy", revisit: "Follow-ups on past talks",
      };
      const note = w.id === "intimacy" ? (intimacyOn() ? "On for both of you" : "Needs you both opted in") : NOTES[w.id] || "";
      return `<div class="setting">
        <span class="dot" style="background:${w.color}" aria-hidden="true"></span>
        <span class="text"><b>${esc(w.label)}</b><span>${note}</span></span>
        <span class="seg" role="group" aria-label="${esc(w.label)} frequency">${b("off", "Off")}${b("less", "Less")}${b("normal", "Normal")}${b("more", "More")}</span>
      </div>`;
    };
    const times = ["off"];
    for (let h = 6; h <= 22; h++) for (const m of ["00", "30"]) times.push(`${String(h).padStart(2, "0")}:${m}`);
    const p = S.partner.display_name;

    $app.innerHTML = `<main class="shell">${header()}
      <div class="stack"><h1>Our wheel</h1><p class="sub">Changes apply to both of you.</p></div>
      <div class="settings-list">${S.bank.wedges.map(row).join("")}</div>

      <div class="settings-list">
        <div class="setting">
          <span class="text"><b>Include Intimacy</b><span>${esc(p)} is ${S.partner.intimacy_opt_in ? "in" : "not in yet"}. It only shows up when you're both in.</span></span>
          <label class="switch"><input type="checkbox" data-action="intimacy" ${S.me.intimacy_opt_in ? "checked" : ""} aria-label="Include Intimacy questions"><span></span></label>
        </div>
        <div class="setting">
          <span class="text"><b>Daily nudge</b><span>A reminder if today's question is still waiting</span></span>
          <select class="input" data-action="nudge" aria-label="Daily nudge time">
            ${times.map((t) => `<option value="${t}" ${S.couple.nudge_time === t ? "selected" : ""}>${t === "off" ? "Off" : fmtTime(t)}</option>`).join("")}
          </select>
        </div>
        <div class="setting">
          <span class="text"><b>Notifications on this phone</b><span>${S.pushOn ? "On" : isIOS && !isStandalone() ? "Add twind to your Home Screen first" : "Off"}</span></span>
          ${S.pushOn ? "" : '<button class="btn ghost" type="button" data-action="push" style="width:auto; min-height:44px">Turn on</button>'}
        </div>
        <div class="setting">
          <span class="text"><b>Re-spins</b><span>One per day, for whoever spins first</span></span>
        </div>
      </div>

      <div class="stack center">
        <p class="sub">Signed in as ${esc(S.me.display_name)}, paired with ${esc(p)}.</p>
        <button class="btn link" type="button" data-action="signout">Sign out</button>
      </div>
    </main>${tabs()}`;
  }

  // ---------- actions ----------
  async function loadTalkPrompt(day) {
    S.talkLoading = true;
    S.talkTried = day;
    const res = await ai({ action: "talk", day }, 20000);
    S.talkLoading = false;
    if (res && res.prompt && S.today && S.today.day === day) {
      S.today.talk_prompt = res.prompt;
      safeRender();
    }
  }

  async function doSpin() {
    if (S.spinning) return;
    const list = activeWedges();
    if (!list.length) { toast("Turn at least one topic on in Wheel settings."); return; }
    const w = weightedPick(list);
    const previous = S.today?.question;
    let question = pickQuestion(w.id, previous);

    // Start the wheel right away; fetch a Revisit question while it turns.
    S.spinning = true;
    const cur = S.rotation;
    const target = rotationFor(list, w.id);
    const next = cur + 1800 + ((target - (cur % 360)) + 720) % 360;
    S.rotation = next;
    render();
    const el = document.getElementById("wheel");
    if (el) {
      el.style.transform = `rotate(${cur}deg)`;
      void el.offsetWidth;
      el.classList.add("spinning");
      el.style.transform = `rotate(${next}deg)`;
    }
    if (navigator.vibrate) navigator.vibrate(12);
    const wait = new Promise((r) => setTimeout(r, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 900 : 4300));

    if (w.id === "revisit") {
      const res = await ai({ action: "revisit" }, 9000);
      if (res && res.question) question = res.question;
    }
    const { data, error } = await S.sb.rpc("spin_today", { p_wedge: w.id, p_question: question });
    await wait;
    if (navigator.vibrate) navigator.vibrate([10, 40, 10]);
    S.spinning = false;
    if (error) {
      toast(error.message);
      await loadToday();
    } else {
      S.today = data;
      S.used.add(question);
      S.rotationKey = data.day + data.wedge + data.spins;
    }
    render();
  }

  async function doLock() {
    S.busy = true; render();
    const { data, error } = await S.sb.rpc("lock_today");
    S.busy = false;
    if (error) { toast(error.message); await loadToday(); }
    else { S.today = data; notify("locked"); }
    render();
  }

  async function submitAnswer(form) {
    const body = form.body.value.trim();
    if (!body) return;
    S.busy = true; render();
    const { error } = await S.sb.rpc("submit_answer", { p_body: body });
    S.busy = false;
    if (error) { toast(error.message); }
    else { store.del("twind-draft-" + S.todayISO); S.editing = false; notify("answered"); }
    await loadToday();
    render();
  }

  async function markTalked() {
    S.busy = true; render();
    const { error } = await S.sb.rpc("mark_talked", { p_day: S.today.day });
    S.busy = false;
    if (error) toast(error.message);
    await loadToday();
    S.history = null;
    render();
  }

  async function setWeight(wedge, level) {
    const next = { ...(S.couple.wedge_weights || {}), [wedge]: level };
    const before = S.couple.wedge_weights;
    S.couple.wedge_weights = next; render();
    const { error } = await S.sb.from("couples").update({ wedge_weights: next }).eq("id", S.couple.id);
    if (error) { S.couple.wedge_weights = before; toast(error.message); render(); }
  }

  const handlers = {
    tab: (el) => { S.view = el.dataset.tab; if (S.view === "history") S.history = null; render(); window.scrollTo(0, 0); },
    spin: doSpin,
    lock: doLock,
    talked: markTalked,
    edit: () => { S.editing = true; render(); },
    "cancel-edit": () => { S.editing = false; render(); },
    push: enablePush,
    weight: (el) => setWeight(el.dataset.wedge, el.dataset.level),
    "auth-mode": () => { S.authMode = S.authMode === "signup" ? "signin" : "signup"; S.notice = null; render(); },
    "pair-mode": () => { S.pairMode = S.pairMode === "join" ? null : "join"; render(); },
    forgot: async () => {
      const email = document.getElementById("email")?.value.trim();
      if (!email) { toast("Type your email first, then tap Forgot password."); return; }
      const { error } = await S.sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split("#")[0] });
      toast(error ? error.message : "Check your email for a reset link.");
    },
    "share-code": async () => {
      const code = S.couple.invite_code;
      const text = `Join me on twind. Our code is ${code}.`;
      try {
        if (navigator.share) await navigator.share({ title: "twind", text, url: location.href.split("#")[0] });
        else { await navigator.clipboard.writeText(`${text} ${location.href.split("#")[0]}`); toast("Copied. Paste it in a text to them."); }
      } catch { /* share sheet closed */ }
    },
    signout: async () => {
      if (channel) { S.sb.removeChannel(channel); channel = null; }
      await S.sb.auth.signOut();
    },
  };

  $app.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el || el.tagName === "SELECT" || el.type === "checkbox") return;
    const fn = handlers[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el); }
  });

  $app.addEventListener("change", async (e) => {
    const el = e.target;
    if (el.dataset.action === "intimacy") {
      const { error } = await S.sb.from("members").update({ intimacy_opt_in: el.checked }).eq("user_id", S.user.id);
      if (error) { toast(error.message); el.checked = !el.checked; return; }
      S.me.intimacy_opt_in = el.checked; render();
    } else if (el.dataset.action === "nudge") {
      const { error } = await S.sb.from("couples").update({ nudge_time: el.value }).eq("id", S.couple.id);
      if (error) toast(error.message); else { S.couple.nudge_time = el.value; toast(el.value === "off" ? "Daily nudge is off." : `Daily nudge set for ${fmtTime(el.value)}.`); }
    }
  });

  $app.addEventListener("input", (e) => {
    if (e.target.dataset.draft) store.set(e.target.dataset.draft, e.target.value);
  });

  $app.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target, kind = form.dataset.form;
    if (kind === "answer") return submitAnswer(form);
    S.busy = true; render();
    try {
      if (kind === "auth") {
        const email = form.email.value.trim(), password = form.password.value;
        if (S.authMode === "signup") {
          const { data, error } = await S.sb.auth.signUp({ email, password, options: { emailRedirectTo: location.href.split("#")[0] } });
          if (error) throw error;
          if (!data.session) { S.notice = "Check your email to confirm your account, then come back and sign in."; S.authMode = "signin"; }
        } else {
          const { error } = await S.sb.auth.signInWithPassword({ email, password });
          if (error) throw error;
        }
      } else if (kind === "newpw") {
        const { error } = await S.sb.auth.updateUser({ password: form.password.value });
        if (error) throw error;
        S.recovery = false; toast("Password saved.");
      } else if (kind === "create") {
        const { error } = await S.sb.rpc("create_couple", { p_name: form.name.value.trim() });
        if (error) throw error;
        await loadPair(); subscribeLive();
      } else if (kind === "join") {
        const { error } = await S.sb.rpc("join_couple", { p_code: form.code.value.trim(), p_name: form.name.value.trim() });
        if (error) throw error;
        await loadPair(); subscribeLive(); await loadToday(); await loadUsed();
      }
    } catch (err) {
      toast(err.message || String(err));
    }
    S.busy = false;
    render();
  });

  // ---------- start ----------
  async function onSignedIn(user) {
    if (S.user && S.user.id === user.id) return;
    S.user = user;
    await loadPair();
    if (S.me) {
      subscribeLive();
      if (S.members.length === 2) await Promise.all([loadToday(), loadUsed()]);
    }
    await checkPush();
    render();
  }

  async function start() {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
    try {
      S.bank = await (await fetch("questions.json", { cache: "no-cache" })).json();
    } catch {
      $app.innerHTML = '<main class="shell no-tabs"><div class="grow"><h1>Couldn\'t load twind</h1><p class="sub">Check your connection and reopen the app.</p></div></main>';
      return;
    }
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY || !window.supabase) return render();
    S.sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

    S.sb.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") { S.recovery = true; }
      if (event === "SIGNED_OUT") {
        Object.assign(S, { user: null, me: null, partner: null, members: [], couple: null, today: null, answers: [], history: null, view: "today" });
        render();
      } else if ((event === "SIGNED_IN" || event === "PASSWORD_RECOVERY") && session) {
        setTimeout(() => onSignedIn(session.user).then(render), 0);
      } else if (event === "PASSWORD_RECOVERY") {
        render();
      }
    });

    const { data: { session } } = await S.sb.auth.getSession();
    if (session) await onSignedIn(session.user);
    else render();
  }

  start();
})();
