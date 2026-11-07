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
    rx: {}, catchup: [], dayView: null, back: "today", week: null, weekStart: null,
    replyEdit: null, talkTried: new Set(), pendingDay: null,
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
  function addDays(iso, n) {
    const d = new Date(iso + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  // Weeks run Monday to Sunday.
  function weekStartOf(iso) {
    const dow = new Date(iso + "T12:00:00Z").getUTCDay();
    return addDays(iso, -((dow + 6) % 7));
  }
  function isLate(ans) {
    return !!ans && !!S.couple && localISO(S.couple.tz, new Date(ans.created_at)) > ans.day;
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
    week: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"></rect><path d="M3.5 10h17M8 3v4M16 3v4M7.5 14h2M11 14h2M14.5 14h2"></path></svg>',
    heart: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7.5 3c0 5.4-7.5 10-7.5 10z"></path></svg>',
    more: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="12" r="1.2"></circle><circle cx="12" cy="12" r="1.2"></circle><circle cx="18" cy="12" r="1.2"></circle></svg>',
    bookmark: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"></path></svg>',
    back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg>',
    next: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"></path></svg>',
    chat: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"></path></svg>',
  };

  // ---------- wedges ----------
  const WEIGHT = { off: 0, less: 0.5, normal: 1, more: 2 };
  // Private topics: only on the wheel when you've both opted in, and never sent to Gemini.
  const PRIVATE = new Set(["intimacy", "spicy"]);
  const wedgeById = (id) => S.bank.wedges.find((w) => w.id === id) || { id, label: id, color: "#7A2E3B", questions: [] };
  function intimacyOn() {
    return S.members.length === 2 && S.members.every((m) => m.intimacy_opt_in);
  }
  function activeWedges() {
    const weights = (S.couple && S.couple.wedge_weights) || {};
    return S.bank.wedges.filter((w) => {
      if (PRIVATE.has(w.id) && !intimacyOn()) return false;
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
    await Promise.all([loadReactions([S.todayISO]), loadCatchup()]);
  }
  function keepReactions(list) {
    (list || []).forEach((r) => { S.rx[r.day + "|" + r.from_user] = r; });
  }
  const rxFrom = (day, uid) => S.rx[day + "|" + uid] || null;
  async function loadReactions(days) {
    if (!days.length) return;
    const { data } = await S.sb.from("reactions").select("*").in("day", days);
    keepReactions(data);
  }
  // Past days (last week) where your partner answered and you didn't.
  async function loadCatchup() {
    if (!S.couple || !S.partner) return;
    const { data } = await S.sb.from("days").select("*")
      .gte("day", addDays(S.todayISO, -7)).lt("day", S.todayISO).eq("locked", true).order("day", { ascending: false });
    S.catchup = (data || []).filter((d) => (d.answered || []).includes(S.partner.user_id) && !(d.answered || []).includes(S.user.id));
  }
  async function loadDay(iso) {
    const [{ data: day }, { data: answers }] = await Promise.all([
      S.sb.from("days").select("*").eq("day", iso).maybeSingle(),
      S.sb.from("answers").select("*").eq("day", iso),
    ]);
    await loadReactions([iso]);
    S.dayView = { iso, day: day || null, answers: answers || [] };
  }
  async function loadWeek(ws) {
    const end = addDays(ws, 6);
    const [{ data: days }, { data: answers }, { data: cached }] = await Promise.all([
      S.sb.from("days").select("*").gte("day", ws).lte("day", end).order("day"),
      S.sb.from("answers").select("*").gte("day", ws).lte("day", end),
      S.sb.from("weeks").select("*").eq("week_start", ws).maybeSingle(),
    ]);
    await loadReactions((days || []).map((d) => d.day));
    const prev = S.week && S.week.ws === ws ? S.week : null;
    S.week = {
      ws, days: days || [], answers: answers || [],
      recap: cached && cached.summary ? { summary: cached.summary, prompt: cached.talk_prompt, count: cached.revealed_count } : prev?.recap || null,
      recapTried: prev?.recapTried || false, recapLoading: false,
    };
  }
  // Keep one change (talk prompt, saved, talked) in sync across every screen that shows that day.
  function patchDay(iso, fields) {
    const lists = [S.today ? [S.today] : [], S.dayView?.day ? [S.dayView.day] : [], S.week?.days || [], S.history?.days || [], S.catchup];
    lists.forEach((l) => l.forEach((d) => { if (d.day === iso) Object.assign(d, fields); }));
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
      await loadReactions(list.map((d) => d.day));
    }
    S.history = { days: list, answers };
  }
  async function refresh() {
    if (!S.user) return;
    try {
      await loadPair();
      if (S.me && S.members.length === 2) await loadToday();
      if (S.me && S.members.length === 2) await reloadView();
    } catch (e) {
      toast(e.message || "Couldn't reach twind. Check your connection.");
    }
    render();
  }

  async function reloadView() {
    if (S.view === "history") await loadHistory();
    else if (S.view === "week" && S.weekStart) await loadWeek(S.weekStart);
    else if (S.view === "day" && S.dayView) await loadDay(S.dayView.iso);
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
        await reloadView();
        safeRender();
      }, 300);
    };
    channel = S.sb.channel("twind-" + S.couple.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "days", filter }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "answers", filter }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "members", filter }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "reactions", filter }, onChange)
      .subscribe();
  }
  // Don't wipe out something being typed.
  function safeRender() {
    const a = document.activeElement;
    if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT")) { S.dirty = true; return; }
    render();
  }
  document.addEventListener("focusout", () => {
    setTimeout(() => { if (!document.activeElement?.matches?.("textarea, input")) window.scrollTo(0, 0); }, 100);
    setTimeout(() => { if (S.dirty && !document.activeElement?.matches?.("textarea, input")) { S.dirty = false; render(); } }, 50);
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });

  // ---------- functions (notifications + AI) ----------
  function notify(event, extra = {}) {
    S.sb.functions.invoke("twind-notify", { body: { event, ...extra } }).catch(() => {});
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
    return `<div class="tabs"><nav aria-label="Main">${t("today", "Today")}${t("week", "Week")}${t("history", "History")}${t("wheel", "Wheel")}</nav></div>`;
  }
  function render() {
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) return renderUnconfigured();
    if (!S.user) return renderAuth();
    if (S.recovery) return renderRecovery();
    if (!S.me) return renderPair();
    if (S.members.length < 2) return renderInvite();
    if (S.view === "history") return renderHistory();
    if (S.view === "week") return renderWeek();
    if (S.view === "day") return renderDay();
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
        <button class="btn link" type="button" data-action="leave">Have a code from your spouse instead?</button>
      </div></main>`;
  }

  // ---------- shared pieces: answers, reactions, save ----------
  function reactionTags(r, who) {
    if (!r || (!r.heart && !r.more && !r.reply)) return "";
    const tags = [
      r.heart ? `<span class="rx-tag">${ICON.heart} ${who} loved this</span>` : "",
      r.more ? `<span class="rx-tag">${ICON.more} ${who} ${who === "You" ? "want" : "wants"} to hear more</span>` : "",
    ].join("");
    return `<div class="rx-foot">${tags ? `<div class="rx-row">${tags}</div>` : ""}${r.reply ? `<div class="rx-reply"><b>${who}:</b> ${esc(r.reply)}</div>` : ""}</div>`;
  }
  function reactControls(day, r) {
    const p = esc(S.partner.display_name);
    const btn = (kind, label) => `<button class="rx-btn" type="button" data-action="react" data-day="${day}" data-kind="${kind}" aria-pressed="${!!(r && r[kind])}">${ICON[kind]}<span>${label}</span></button>`;
    const reply = r && r.reply && S.replyEdit !== day
      ? `<div class="rx-reply"><b>You:</b> ${esc(r.reply)} <button class="btn link sm" type="button" data-action="reply-edit" data-day="${day}">Edit</button></div>`
      : `<form class="rx-form" data-form="reply" data-day="${day}">
          <input class="input" name="reply" maxlength="280" autocomplete="off" placeholder="Reply to ${p}" aria-label="Reply to ${p}" value="${esc(r?.reply || "")}">
          <button class="btn sm" type="submit">Send</button>
        </form>`;
    return `<div class="rx-foot"><div class="rx-row">${btn("heart", "Love it")}${btn("more", "Tell me more")}</div>${reply}</div>`;
  }
  // interactive: show heart / tell me more / reply on your partner's answer.
  function answerBlock(ans, mine, interactive = true) {
    if (!ans) return "";
    const p = esc(S.partner.display_name);
    const late = isLate(ans) ? '<span class="late">Answered late</span>' : "";
    const foot = mine
      ? reactionTags(rxFrom(ans.day, S.partner.user_id), p)
      : interactive ? reactControls(ans.day, rxFrom(ans.day, S.user.id)) : reactionTags(rxFrom(ans.day, S.user.id), "You");
    return `<div class="card answer-card">
      <div class="who" style="color: ${mine ? "var(--wine)" : "var(--plum)"}">${mine ? "You" : p}${late}</div>
      <p>${esc(ans.body)}</p>${foot}
    </div>`;
  }
  function saveBtn(d) {
    const by = d.saved_by || [];
    const mine = by.includes(S.user.id), theirs = by.includes(S.partner.user_id);
    const label = mine ? "Saved for later" : theirs ? `${esc(S.partner.display_name)} saved this for later` : "Save for later";
    return `<button class="btn ghost save" type="button" data-action="save" data-day="${d.day}" aria-pressed="${mine}">${ICON.bookmark}${label}</button>`;
  }
  function talkBlock(d) {
    if (!d.talk_prompt && !S.talkLoading && !S.talkTried.has(d.day) && !PRIVATE.has(d.wedge)) loadTalkPrompt(d.day);
    const prompt = d.talk_prompt || "Pick the one line from each other's answer that surprised you, and start there.";
    return `<div class="card dark stack">
        <div class="label" style="display:flex; align-items:center; gap:8px">${ICON.chat} Talk about this tonight</div>
        <p style="margin:0; font-size:16px; line-height:1.45">${esc(prompt)}</p>
      </div>
      ${d.talked_at
        ? `<div class="stack center"><div class="done-badge">${ICON.check}</div><p class="sub">You talked about this. It's saved in your history.</p></div>`
        : `<button class="btn" type="button" data-action="talked" data-day="${d.day}" ${S.busy ? "disabled" : ""}>We talked about it</button>`}`;
  }
  function catchupCards() {
    return S.catchup.slice(0, 2).map((d) => `
      <button class="card paper catchup" type="button" data-action="open-day" data-day="${d.day}">
        <span class="text"><b>${esc(S.partner.display_name)} answered ${esc(prettyDate(d.day, { weekday: "long" }))}'s question</b>
        <span>Add yours to see theirs</span></span>${ICON.next}
      </button>`).join("");
  }

  // The spinner gets 30 minutes to lock it in before the other person can.
  const LOCK_GRACE_MS = 30 * 60 * 1000;
  let lockTimer = null;
  function lockWaitMs(d) {
    const since = new Date(d.spun_at || d.created_at).getTime();
    return Math.max(0, since + LOCK_GRACE_MS - Date.now());
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
      const left = lockWaitMs(d);
      if (left > 0) {
        clearTimeout(lockTimer);
        lockTimer = setTimeout(() => { if (S.view === "today") safeRender(); }, left + 1000);
        body = `<div class="grow">
            <h1>${partner} is spinning</h1>
            <p class="sub">They got here first today. You'll see the question as soon as they lock it in. If they haven't locked it in within ${Math.ceil(left / 60000)} minutes, you can.</p>
          </div>${pushNudge()}`;
      } else {
        body = `
          <div class="stack"><h1>${partner} spun but didn't lock it in</h1><p class="sub">You can lock it in for both of you.</p></div>
          <div class="stack lg push">
            <div class="card stack">${chip()}<p class="question">${esc(d.question)}</p></div>
            <button class="btn" type="button" data-action="lock" ${S.busy ? "disabled" : ""}>Lock it in</button>
          </div>`;
      }
    } else if (stage === "answer") {
      const draftKey = "twind-draft-" + d.day;
      const mine = S.answers.find((a) => a.user_id === S.user.id);
      const draft = store.get(draftKey) ?? (mine ? mine.body : "");
      const theirs = (d.answered || []).includes(S.partner.user_id);
      body = `
        <div class="stack">
          ${chip(d.spinner === S.user.id ? " · you spun" : ` · ${partner} spun`)}
          <h1 class="question" style="font-size: 30px">${esc(d.question)}</h1>
          <p class="sub" style="color: var(--plum)">${theirs ? `${partner} already answered. Yours reveals both.` : `${partner} sees your answer once they answer too.`}</p>
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
      const recently = !!d.last_nudge_at && Date.now() - new Date(d.last_nudge_at).getTime() < 2 * 3600e3;
      body = `<div class="grow">
          ${ICON.lock}
          <h1>Your answer is in</h1>
          <p class="sub">You'll both see each other's answers as soon as ${partner} answers.</p>
          <button class="btn ghost" type="button" data-action="nudge" style="max-width: 280px" ${recently || S.busy ? "disabled" : ""}>${recently ? `Nudged ${partner}` : `Nudge ${partner}`}</button>
          <button class="btn link" type="button" data-action="edit">Edit my answer</button>
        </div>${pushNudge()}`;
    } else if (stage === "reveal") {
      const mine = S.answers.find((a) => a.user_id === S.user.id);
      const theirs = S.answers.find((a) => a.user_id === S.partner.user_id);
      body = `
        <div class="stack">${chip()}<p class="question sm">${esc(d.question)}</p></div>
        <div class="stack">${answerBlock(mine, true)}${answerBlock(theirs, false)}</div>
        ${saveBtn(d)}
        <div class="stack lg push">${talkBlock(d)}</div>`;
    }

    $app.innerHTML = `<main class="shell">${header(`<span class="date">${esc(prettyDate(S.todayISO))}</span>`)}${catchupCards()}${body}</main>${tabs()}`;
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
      const isToday = d.day === S.todayISO;
      const hidden = !theirs && (d.answered || []).includes(S.partner.user_id);
      const canLate = !isToday && !mine;
      return `<details class="day">
        <summary>
          <span class="row"><span class="chip" style="background:${w.color}; font-size:12px; padding:3px 10px">${esc(w.label)}</span>
          <span class="status ${st.cls}">${esc(st.text)} · ${esc(prettyDate(d.day, { weekday: "short", month: "short", day: "numeric" }))}</span></span>
          <p class="q">${esc(d.question)}</p>
        </summary>
        <div class="body">
          ${answerBlock(mine, true, false)}
          ${answerBlock(theirs, false, false)}
          ${hidden ? `<p class="sub">${esc(S.partner.display_name)}'s answer shows once you answer.</p>` : ""}
          ${d.talk_prompt ? `<p class="sub"><b>Talk prompt:</b> ${esc(d.talk_prompt)}</p>` : ""}
          ${!mine && !theirs && !hidden ? '<p class="sub">No answers that day.</p>' : ""}
          ${!isToday && (canLate || theirs) ? `<button class="btn link" type="button" data-action="open-day" data-day="${d.day}" style="align-self:flex-start">${canLate ? "Answer it now" : "React or reply"}</button>` : ""}
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

  function backBar(right = "") {
    return `<header class="top"><button class="btn link back" type="button" data-action="back">${ICON.back}Back</button>${right}</header>`;
  }

  function renderDay() {
    const v = S.dayView;
    if (!v || !v.answers) {
      $app.innerHTML = `<main class="shell">${backBar()}<p class="sub">Loading…</p></main>${tabs()}`;
      return;
    }
    const d = v.day, p = esc(S.partner.display_name);
    if (!d) {
      $app.innerHTML = `<main class="shell">${backBar()}<div class="grow"><h1>No question that day</h1></div></main>${tabs()}`;
      return;
    }
    const w = wedgeById(d.wedge);
    const mine = v.answers.find((a) => a.user_id === S.user.id);
    const theirs = v.answers.find((a) => a.user_id === S.partner.user_id);
    const draftKey = "twind-draft-" + d.day;
    let body = `<div class="stack">${theirs ? answerBlock(theirs, false) : ""}${mine ? answerBlock(mine, true) : ""}</div>`;
    if (!mine) {
      if ((d.answered || []).includes(S.partner.user_id)) {
        body += `<div class="card paper"><p class="sub" style="color: var(--ink); margin:0">${p} answered this one. Add yours to see theirs.</p></div>`;
      }
      body += `<form class="stack lg" data-form="late" data-day="${d.day}">
        <div class="field">
          <label for="late-ans">Your answer</label>
          <textarea class="input" id="late-ans" name="body" data-draft="${esc(draftKey)}" placeholder="It's not too late. Be honest." maxlength="5000" required>${esc(store.get(draftKey) || "")}</textarea>
        </div>
        <button class="btn" type="submit" ${S.busy ? "disabled" : ""}>Add my answer</button>
        <p class="sub" style="text-align:center; font-size: 13px">${p} gets a heads-up. It shows as answered late.</p>
      </form>`;
    } else if (!theirs) {
      body += `<p class="sub">${p} didn't answer this one.</p>`;
    }
    if (mine || theirs) body += saveBtn(d);
    if (mine && theirs) body += `<div class="stack lg">${talkBlock(d)}</div>`;
    $app.innerHTML = `<main class="shell">${backBar(`<span class="date">${esc(prettyDate(d.day))}</span>`)}
      <div class="stack"><span class="chip" style="background:${w.color}">${esc(w.label)}</span>
      <h1 class="question" style="font-size: 28px">${esc(d.question)}</h1></div>
      ${body}
    </main>${tabs()}`;
  }

  function renderWeek() {
    if (!S.weekStart) S.weekStart = weekStartOf(S.todayISO);
    const ws = S.weekStart, end = addDays(ws, 6);
    const range = `${prettyDate(ws, { month: "short", day: "numeric" })} to ${prettyDate(end, { month: "short", day: "numeric" })}`;
    const isCurrent = S.todayISO >= ws && S.todayISO <= end;
    const nav = `<div class="week-nav">
        <button class="icon-btn" type="button" data-action="week-prev" aria-label="Previous week">${ICON.back}</button>
        <span>${isCurrent ? "This week" : esc(range)}</span>
        <button class="icon-btn" type="button" data-action="week-next" aria-label="Next week" ${isCurrent ? "disabled" : ""}>${ICON.next}</button>
      </div>`;
    if (!S.week || S.week.ws !== ws) {
      $app.innerHTML = `<main class="shell">${header()}<h1>Our week</h1>${nav}<p class="sub">Loading…</p></main>${tabs()}`;
      loadWeek(ws).then(render);
      return;
    }
    const { days, answers } = S.week;
    const both = (d) => answers.filter((a) => a.day === d.day).length >= 2;
    const bothCount = days.filter(both).length;
    const talks = days.filter((d) => d.talked_at).length;
    const done = S.todayISO >= end;
    const shared = days.filter((d) => both(d) && !PRIVATE.has(d.wedge)).length;

    const row = (d) => {
      const w = wedgeById(d.wedge), st = statusFor(d);
      const saved = (d.saved_by || []).length ? ` · ${ICON.bookmark}` : "";
      return `<button class="week-row" type="button" data-action="open-day" data-day="${d.day}">
        <span class="wk-day"><b>${esc(prettyDate(d.day, { weekday: "short" }))}</b>${esc(prettyDate(d.day, { day: "numeric" }))}</span>
        <span class="dot" style="background:${w.color}" aria-hidden="true"></span>
        <span class="text"><span class="q">${esc(d.question)}</span><span class="status ${st.cls}">${esc(st.text)}${saved}</span></span>
      </button>`;
    };
    const list = [];
    for (let i = 0; i < 7; i++) {
      const iso = addDays(ws, i);
      if (iso > S.todayISO) break;
      const d = days.find((x) => x.day === iso);
      list.push(d ? row(d) : `<div class="week-row empty"><span class="wk-day"><b>${esc(prettyDate(iso, { weekday: "short" }))}</b>${esc(prettyDate(iso, { day: "numeric" }))}</span><span class="text"><span class="status">No question this day</span></span></div>`);
    }

    let recap = "";
    if (!done) {
      recap = `<div class="card paper"><p class="sub" style="color: var(--ink)">Your recap fills in Sunday evening. Here's the week so far.</p></div>`;
    } else if (shared) {
      const r = S.week.recap;
      if ((!r || r.count !== shared) && !S.week.recapLoading && S.week.recapTried !== shared) loadRecap(ws, shared);
      recap = r
        ? `<div class="card dark stack">
            <div class="label">Your week</div>
            <p style="margin:0; font-size:16px; line-height:1.45">${esc(r.summary)}</p>
            ${r.prompt ? `<div class="label" style="display:flex; align-items:center; gap:8px; margin-top:6px">${ICON.chat} Talk about this tonight</div>
            <p style="margin:0; font-size:16px; line-height:1.45">${esc(r.prompt)}</p>` : ""}
          </div>`
        : `<div class="card dark"><p style="margin:0" class="sub">${S.week.recapLoading ? "Writing your recap…" : "Your recap couldn't load. Pull it up again in a bit."}</p></div>`;
    }

    const saved = days.filter((d) => (d.saved_by || []).length);
    $app.innerHTML = `<main class="shell">${header()}
      <h1>Our week</h1>
      ${nav}
      <div class="stats">
        <div class="stat"><b>${bothCount} of ${list.length}</b><span>days you both answered</span></div>
        <div class="stat"><b>${talks}</b><span>talk${talks === 1 ? "" : "s"} this week</span></div>
      </div>
      ${recap}
      ${saved.length ? `<div class="stack"><div class="label">Saved for later</div>${saved.map(row).join("")}</div>` : ""}
      <div class="stack"><div class="label">Day by day</div>${list.reverse().join("")}</div>
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
        spicy: "Just for the two of you",
      };
      const note = PRIVATE.has(w.id) ? (intimacyOn() ? "On for both of you" : "Needs you both opted in") : NOTES[w.id] || "";
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
          <span class="text"><b>Include Intimacy and Spicy</b><span>${esc(p)} is ${S.partner.intimacy_opt_in ? "in" : "not in yet"}. They only show up when you're both in.</span></span>
          <label class="switch"><input type="checkbox" data-action="intimacy" ${S.me.intimacy_opt_in ? "checked" : ""} aria-label="Include Intimacy and Spicy questions"><span></span></label>
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
    S.talkTried.add(day);
    const res = await ai({ action: "talk", day }, 20000);
    S.talkLoading = false;
    if (res && res.prompt) {
      patchDay(day, { talk_prompt: res.prompt });
      safeRender();
    }
  }

  async function loadRecap(ws, shared) {
    S.week.recapLoading = true;
    S.week.recapTried = shared;
    const res = await ai({ action: "week", week_start: ws }, 30000);
    if (!S.week || S.week.ws !== ws) return;
    S.week.recapLoading = false;
    if (res && res.summary) S.week.recap = { summary: res.summary, prompt: res.prompt, count: shared };
    safeRender();
  }

  async function openDay(iso) {
    if (!iso) return;
    if (iso === S.todayISO) { S.view = "today"; render(); return; }
    if (S.view !== "day") S.back = S.view;
    S.view = "day";
    S.replyEdit = null;
    S.dayView = { iso, day: null, answers: null };
    render();
    document.querySelector(".shell")?.scrollTo(0, 0);
    try { await loadDay(iso); } catch (e) { toast(e.message || "Couldn't load that day."); }
    render();
  }

  async function doReact(day, kind) {
    const before = rxFrom(day, S.user.id);
    const next = { heart: !!before?.heart, more: !!before?.more, reply: before?.reply || null };
    next[kind] = !next[kind];
    keepReactions([{ ...(before || {}), day, from_user: S.user.id, ...next }]);
    render();
    const { data, error } = await S.sb.rpc("react", { p_day: day, p_heart: next.heart, p_more: next.more, p_reply: next.reply });
    if (error) {
      if (before) keepReactions([before]); else delete S.rx[day + "|" + S.user.id];
      toast(error.message); render(); return;
    }
    keepReactions([data]);
    if (next[kind]) notify("reacted", { day, kind });
  }

  async function sendReply(form) {
    const day = form.dataset.day;
    const text = form.reply.value.trim();
    const before = rxFrom(day, S.user.id);
    if ((before?.reply || "") === text) { S.replyEdit = null; render(); return; }
    const { data, error } = await S.sb.rpc("react", { p_day: day, p_heart: !!before?.heart, p_more: !!before?.more, p_reply: text || null });
    if (error) { toast(error.message); return; }
    keepReactions([data]);
    S.replyEdit = null;
    form.reply.blur();
    if (text) { notify("reacted", { day, kind: "reply" }); toast(`Reply sent to ${S.partner.display_name}.`); }
    render();
  }

  async function toggleSave(day) {
    const { data, error } = await S.sb.rpc("toggle_save", { p_day: day });
    if (error) { toast(error.message); return; }
    patchDay(day, { saved_by: data || [] });
    if ((data || []).includes(S.user.id)) toast("Saved. It'll show up in your weekly review.");
    render();
  }

  async function submitLate(form) {
    const day = form.dataset.day;
    const body = form.body.value.trim();
    if (!body) return;
    S.busy = true; render();
    const { error } = await S.sb.rpc("submit_late_answer", { p_day: day, p_body: body });
    S.busy = false;
    if (error) { toast(error.message); render(); return; }
    store.del("twind-draft-" + day);
    notify("answered", { day });
    await Promise.all([loadDay(day), loadCatchup()]);
    S.history = null;
    if (S.week) S.week.ws = null;
    render();
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

  async function markTalked(el) {
    const day = el?.dataset?.day || S.today.day;
    S.busy = true; render();
    const { error } = await S.sb.rpc("mark_talked", { p_day: day });
    S.busy = false;
    if (error) toast(error.message);
    else patchDay(day, { talked_at: new Date().toISOString() });
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
    tab: (el) => {
      S.view = el.dataset.tab;
      if (S.view === "history") S.history = null;
      if (S.view === "week") { S.week = null; S.weekStart = weekStartOf(S.todayISO); }
      render(); window.scrollTo(0, 0);
    },
    "open-day": (el) => openDay(el.dataset.day),
    back: () => { S.view = S.back || "today"; render(); },
    "week-prev": () => { S.weekStart = addDays(S.weekStart, -7); render(); },
    "week-next": () => { S.weekStart = addDays(S.weekStart, 7); render(); },
    react: (el) => doReact(el.dataset.day, el.dataset.kind),
    "reply-edit": (el) => { S.replyEdit = el.dataset.day; render(); document.querySelector(`form[data-day="${el.dataset.day}"] input`)?.focus(); },
    save: (el) => toggleSave(el.dataset.day),
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
    nudge: async () => {
      if (S.busy) return;
      S.busy = true; render();
      let res = null;
      try {
        const r = await S.sb.functions.invoke("twind-notify", { body: { event: "nudge" } });
        if (!r.error) res = r.data;
      } catch { /* handled below */ }
      S.busy = false;
      const p = S.partner.display_name;
      if (!res) toast("Couldn't send the nudge. Notifications may not be set up yet.");
      else if (res.sent > 0) { S.today.last_nudge_at = new Date().toISOString(); toast(`Nudge sent to ${p}.`); }
      else if (res.reason === "too-soon") toast(`You nudged ${p} recently. Try again in about ${res.wait_minutes} minutes.`);
      else if (res.reason === "no-push") toast(`${p} hasn't turned on notifications yet, so it couldn't reach their phone.`);
      else { toast(`${p} doesn't need a nudge right now.`); await loadToday(); }
      render();
    },
    leave: async () => {
      if (!confirm("Drop this code and enter your spouse's code instead?")) return;
      const { error } = await S.sb.rpc("leave_couple");
      if (error) { toast(error.message); return; }
      if (channel) { S.sb.removeChannel(channel); channel = null; }
      Object.assign(S, { me: null, partner: null, members: [], couple: null, today: null, answers: [], pairMode: "join" });
      render();
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
    if (kind === "late") return submitLate(form);
    if (kind === "reply") return sendReply(form);
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
    if (S.pendingDay && S.members.length === 2) { const d = S.pendingDay; S.pendingDay = null; openDay(d); }
  }

  // Links from notifications: ?view=week or ?day=YYYY-MM-DD
  function readLink(url) {
    let q;
    try { q = new URL(url, location.href).searchParams; } catch { return false; }
    const day = q.get("day");
    if (q.get("view") === "week") { S.view = "week"; S.week = null; S.weekStart = null; return true; }
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) { S.pendingDay = day; return true; }
    return false;
  }

  async function start() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
      navigator.serviceWorker.addEventListener("message", (e) => {
        if (!e.data || e.data.type !== "open" || !readLink(e.data.url) || !S.me) return;
        if (S.pendingDay) { const d = S.pendingDay; S.pendingDay = null; openDay(d); } else render();
      });
    }
    if (readLink(location.href)) history.replaceState(null, "", location.pathname);
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
