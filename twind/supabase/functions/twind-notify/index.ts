// twind-notify: sends push notifications to your phones.
//   - Called by the app when a question is locked in or an answer is submitted.
//   - Called every 30 minutes by a scheduled job for the daily nudge.
// Secrets it needs (Supabase > Edge Functions > Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET
// Deploy with "Verify JWT" turned OFF (it checks sign-in itself).

import webpush from "npm:web-push@3.6.7";
import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:twind@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const NUDGE_GAP_MIN = 120; // at most one nudge every 2 hours

const LABELS: Record<string, string> = {
  faith: "Faith", us: "Us", future: "Future", reflection: "Reflection",
  fun: "Fun", intimacy: "Intimacy", revisit: "Revisit",
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Payload = { title: string; body: string; tag?: string };

async function sendTo(userIds: string[], payload: Payload) {
  if (!userIds.length) return 0;
  const { data: subs } = await admin.from("push_subs").select("*").in("user_id", userIds);
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 12 },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from("push_subs").delete().eq("endpoint", s.endpoint);
      else console.error("push failed", code, (e as Error).message);
    }
  }
  return sent;
}

function localParts(tz: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const minute = Number(get("minute")) < 30 ? "00" : "30";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${minute}` };
}

async function daily() {
  const { data: couples } = await admin.from("couples").select("id, tz, nudge_time");
  let sent = 0;
  for (const c of couples ?? []) {
    const now = localParts(c.tz);
    if (now.time !== c.nudge_time) continue;
    const { data: members } = await admin.from("members").select("user_id, display_name").eq("couple_id", c.id);
    const ids = (members ?? []).map((m) => m.user_id);
    if (ids.length < 2) continue;
    const { data: day } = await admin.from("days").select("*").eq("couple_id", c.id).eq("day", now.date).maybeSingle();
    if (!day) {
      sent += await sendTo(ids, { title: "Today's wheel is waiting", body: "Whoever opens twind first gets to spin.", tag: "daily" });
    } else if (!day.locked) {
      sent += await sendTo([day.spinner], { title: "Lock in today's question", body: "You spun but haven't locked it in yet.", tag: "daily" });
    } else {
      const waiting = ids.filter((id) => !(day.answered ?? []).includes(id));
      sent += await sendTo(waiting, { title: "Today's question is waiting", body: day.question, tag: "daily" });
    }
  }
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));

  if (body.event === "daily") {
    if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return json({ error: "forbidden" }, 403);
    return json({ sent: await daily() });
  }

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ error: "not signed in" }, 401);

  const { data: me } = await admin.from("members").select("*").eq("user_id", user.id).maybeSingle();
  if (!me) return json({ error: "not paired" }, 400);
  const { data: partner } = await admin.from("members").select("*")
    .eq("couple_id", me.couple_id).neq("user_id", user.id).maybeSingle();
  if (!partner) return json({ sent: 0 });

  const { data: day } = await admin.from("days").select("*")
    .eq("couple_id", me.couple_id).order("day", { ascending: false }).limit(1).maybeSingle();
  if (!day) return json({ sent: 0 });

  let sent = 0;
  if (body.event === "locked" && day.locked && day.spinner === user.id) {
    sent = await sendTo([partner.user_id], {
      title: `${me.display_name} spun ${LABELS[day.wedge] ?? "today's question"}`,
      body: day.question,
      tag: "today",
    });
  } else if (body.event === "answered" && (day.answered ?? []).includes(user.id)) {
    const both = (day.answered ?? []).includes(partner.user_id);
    sent = await sendTo([partner.user_id], both
      ? { title: "Your answers are revealed", body: "You both answered. Time to talk.", tag: "today" }
      : { title: `${me.display_name} answered today's question`, body: "Your turn. You'll see each other's answers once you both answer.", tag: "today" });
  } else if (body.event === "nudge") {
    const { data: couple } = await admin.from("couples").select("tz").eq("id", me.couple_id).maybeSingle();
    const answered = day.answered ?? [];
    const isToday = !!couple && day.day === localParts(couple.tz).date;
    if (!isToday || !day.locked || !answered.includes(user.id) || answered.includes(partner.user_id)) {
      return json({ sent: 0, reason: "not-needed" });
    }
    const last = day.last_nudge_at ? new Date(day.last_nudge_at).getTime() : 0;
    const wait = NUDGE_GAP_MIN - Math.floor((Date.now() - last) / 60000);
    if (wait > 0) return json({ sent: 0, reason: "too-soon", wait_minutes: wait });
    sent = await sendTo([partner.user_id], {
      title: `${me.display_name} is waiting on your answer`,
      body: day.question,
      tag: "nudge",
    });
    if (sent === 0) return json({ sent: 0, reason: "no-push" });
    await admin.from("days").update({ last_nudge_at: new Date().toISOString() })
      .eq("couple_id", me.couple_id).eq("day", day.day);
  }
  return json({ sent });
});
