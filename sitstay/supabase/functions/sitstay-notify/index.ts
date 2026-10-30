// sitstay-notify: sends SitStay feeding reminders that have come due.
// Runs every 5 minutes from the cron job in sitstay.sql.
// Uses the same secrets as twind-notify: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET.
// Deploy with "Verify JWT" turned OFF (it checks the cron secret itself).

import webpush from "npm:web-push@3.6.7";
import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:sitstay@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }
  const { data: due } = await admin
    .from("sitstay_pings")
    .select("*")
    .eq("sent", false)
    .lte("due_at", new Date().toISOString())
    .limit(200);

  let sent = 0;
  for (const p of due ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: p.endpoint, keys: { p256dh: p.p256dh, auth: p.auth } },
        JSON.stringify({ title: "SitStay", body: p.body, tag: "sitstay-" + p.kind }),
        { TTL: 60 * 60 * 6 },
      );
      await admin.from("sitstay_pings").update({ sent: true }).eq("endpoint", p.endpoint).eq("kind", p.kind);
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from("sitstay_pings").delete().eq("endpoint", p.endpoint);
      else console.error("push failed", code, (e as Error).message);
    }
  }
  return new Response(JSON.stringify({ sent }), { headers: { "Content-Type": "application/json" } });
});
