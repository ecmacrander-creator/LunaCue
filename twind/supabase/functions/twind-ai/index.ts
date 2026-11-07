// twind-ai: uses Gemini to write the "talk about this tonight" prompt
// Revisit follow-up questions, and the Sunday weekly recap.
// Secrets it needs (Supabase > Edge Functions > Secrets):
//   GEMINI_API_KEY   (from Google AI Studio)
//   GEMINI_MODEL     (optional, defaults to gemini-3.8-flash)
// Deploy with "Verify JWT" turned OFF (it checks sign-in itself).

import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM = `You help a Christian married couple have one deeper, connecting conversation a day.
Write warmly and plainly, like a wise friend who knows them, never like a therapist.
No cliches, no em dashes, no emojis, no hashtags. Never judge, score or take sides.
Keep anything intimate tasteful. Reply with only the text asked for.`;

// Gemini sometimes answers 503 "high demand" or 429. Retry once, then try backup models,
// all inside ~17 seconds so the app (which waits 20) still gets an answer.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function callModel(model: string, key: string, prompt: string, asJson: boolean, thinking: boolean, ms: number) {
  return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    signal: AbortSignal.timeout(ms),
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.8, maxOutputTokens: 4096,
        ...(thinking ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
        ...(asJson ? { responseMimeType: "application/json" } : {}),
      },
    }),
  });
}

async function gemini(prompt: string, asJson = false): Promise<string | null> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) { console.error("GEMINI_API_KEY is not set"); return null; }
  const main = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.8-flash";
  const plan = [main, main, "gemini-flash-latest", "gemini-flash-lite-latest"]
    .filter((m, i, a) => i < 2 || !a.slice(0, i).includes(m));
  const deadline = Date.now() + 17000;
  for (let i = 0; i < plan.length; i++) {
    const left = deadline - Date.now();
    if (left < 2500) break;
    if (i === 1) await new Promise((r) => setTimeout(r, 800));
    try {
      let res = await callModel(plan[i], key, prompt, asJson, true, Math.min(left, 9000));
      // Older backup models don't take thinkingLevel; try once more without it.
      if (res.status === 400) res = await callModel(plan[i], key, prompt, asJson, false, Math.max(2000, Math.min(deadline - Date.now(), 9000)));
      if (!res.ok) {
        console.error("gemini error", plan[i], res.status, (await res.text()).slice(0, 300));
        if (RETRYABLE.has(res.status) || res.status === 404 || res.status === 400) continue;
        return null;
      }
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .filter((p: { thought?: boolean }) => !p.thought)
        .map((p: { text?: string }) => p.text ?? "").join("").trim();
      if (!text) { console.error("gemini empty", plan[i], data.candidates?.[0]?.finishReason); continue; }
      if (i > 0) console.log("gemini ok on try", i + 1, plan[i]);
      return text.replace(/^["'“]+|["'”]+$/g, "").replace(/\s*—\s*/g, ", ").trim();
    } catch (e) {
      console.error("gemini failed", plan[i], (e as Error).message);
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ error: "not signed in" }, 401);
  const { data: members } = await admin.from("members").select("*")
    .eq("couple_id", (await admin.from("members").select("couple_id").eq("user_id", user.id).maybeSingle()).data?.couple_id ?? "");
  const me = members?.find((m) => m.user_id === user.id);
  if (!me) return json({ error: "not paired" }, 400);
  const nameOf = (id: string) => members?.find((m) => m.user_id === id)?.display_name ?? "Partner";

  if (body.action === "talk") {
    const { data: day } = await admin.from("days").select("*")
      .eq("couple_id", me.couple_id).eq("day", body.day).maybeSingle();
    if (!day) return json({ error: "no such day" }, 404);
    if (day.talk_prompt) return json({ prompt: day.talk_prompt });
    // Intimacy and Spicy answers never go to Gemini.
    if (["intimacy", "spicy"].includes(day.wedge)) return json({ prompt: null });
    const { data: answers } = await admin.from("answers").select("user_id, body")
      .eq("couple_id", me.couple_id).eq("day", body.day);
    if ((answers ?? []).length < 2) return json({ error: "not revealed yet" }, 400);

    const prompt = `Today's question: "${day.question}"
${answers!.map((a) => `${nameOf(a.user_id)} answered: "${a.body}"`).join("\n")}

Write a "talk about this tonight" prompt for the two of them.
One or two sentences, under 45 words. Point to one specific overlap, difference or surprise in what they wrote,
then give them one concrete thing to ask each other tonight. Use their names.`;
    const text = await gemini(prompt);
    if (!text) return json({ prompt: null });
    await admin.from("days").update({ talk_prompt: text })
      .eq("couple_id", me.couple_id).eq("day", body.day).is("talk_prompt", null);
    return json({ prompt: text });
  }

  if (body.action === "revisit") {
    const cutoff = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
    const { data: past } = await admin.from("days").select("day, question")
      .eq("couple_id", me.couple_id).not("talked_at", "is", null).lte("day", cutoff)
      .not("wedge", "in", "(intimacy,spicy)").order("day", { ascending: false }).limit(60);
    if (!past?.length) return json({ question: null });
    const pick = past[Math.floor(Math.random() * past.length)];
    const { data: answers } = await admin.from("answers").select("user_id, body")
      .eq("couple_id", me.couple_id).eq("day", pick.day);
    const when = new Date(pick.day + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" });

    const prompt = `On ${when}, they both answered: "${pick.question}"
${(answers ?? []).map((a) => `${nameOf(a.user_id)} said: "${a.body}"`).join("\n")}
They talked about it afterward.

Write one follow-up question for today that picks that thread back up.
Mention briefly what it is about so they remember, then ask something new that each of them can answer on their own.
Under 40 words. Address them as "you" (the question is shown to both). Reply with only the question.`;
    const text = await gemini(prompt);
    return json({ question: text, sourceDay: pick.day });
  }

  if (body.action === "week") {
    const ws = String(body.week_start ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ws) || new Date(ws + "T12:00:00Z").getUTCDay() !== 1) {
      return json({ error: "week_start must be a Monday" }, 400);
    }
    const end = new Date(new Date(ws + "T12:00:00Z").getTime() + 6 * 864e5).toISOString().slice(0, 10);
    const { data: couple } = await admin.from("couples").select("tz").eq("id", me.couple_id).maybeSingle();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: couple?.tz ?? "America/Chicago" }).format(new Date());
    // The recap opens on Sunday. Before that the week isn't done yet.
    if (today < end) return json({ summary: null, reason: "not-yet" });

    const { data: days } = await admin.from("days").select("*")
      .eq("couple_id", me.couple_id).gte("day", ws).lte("day", end).order("day");
    const { data: answers } = await admin.from("answers").select("day, user_id, body")
      .eq("couple_id", me.couple_id).gte("day", ws).lte("day", end);
    const { data: reactions } = await admin.from("reactions").select("day, from_user, reply")
      .eq("couple_id", me.couple_id).gte("day", ws).lte("day", end);
    // Intimacy answers never go to Gemini.
    const shared = (days ?? []).filter((d) =>
      !["intimacy", "spicy"].includes(d.wedge) && (answers ?? []).filter((a) => a.day === d.day).length >= 2);
    if (!shared.length) return json({ summary: null, reason: "empty" });

    const { data: cached } = await admin.from("weeks").select("*")
      .eq("couple_id", me.couple_id).eq("week_start", ws).maybeSingle();
    if (cached?.summary && cached.revealed_count === shared.length) {
      return json({ summary: cached.summary, prompt: cached.talk_prompt });
    }

    const lines = shared.map((d) => {
      const name = new Date(d.day + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
      const said = (answers ?? []).filter((a) => a.day === d.day)
        .map((a) => `  ${nameOf(a.user_id)}: "${a.body}"`).join("\n");
      const replies = (reactions ?? []).filter((r) => r.day === d.day && r.reply)
        .map((r) => `  ${nameOf(r.from_user)} replied: "${r.reply}"`).join("\n");
      const flags = [(d.saved_by ?? []).length ? "saved to talk about later" : "", d.talked_at ? "they talked about it" : ""]
        .filter(Boolean).join(", ");
      return `${name}: "${d.question}"${flags ? ` (${flags})` : ""}\n${said}${replies ? "\n" + replies : ""}`;
    }).join("\n\n");

    const prompt = `Here is their week of questions and answers:

${lines}

Reply with JSON: {"summary": string, "prompt": string}
- summary: 2 or 3 sentences, under 70 words. Name a theme or two from the week, one place they lined up and one place they saw things differently. Use their names. Warm, specific, never a score or verdict.
- prompt: one "talk about this tonight" question, under 35 words. If anything was saved to talk about later and not yet talked about, build it from that. Otherwise pick the thread most worth pulling on.`;
    const raw = await gemini(prompt, true);
    let out: { summary?: string; prompt?: string } = {};
    try { out = JSON.parse(raw ?? "{}"); } catch { out = {}; }
    const clean = (t?: string) => (t ?? "").replace(/\s*—\s*/g, ", ").trim() || null;
    const summary = clean(out.summary), talk = clean(out.prompt);
    if (!summary) return json({ summary: null, reason: "ai-failed" });
    await admin.from("weeks").upsert({
      couple_id: me.couple_id, week_start: ws, summary, talk_prompt: talk,
      revealed_count: shared.length, created_at: new Date().toISOString(),
    });
    return json({ summary, prompt: talk });
  }

  return json({ error: "unknown action" }, 400);
});
