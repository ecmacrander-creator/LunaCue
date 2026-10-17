// twind-ai: uses Gemini to write the "talk about this tonight" prompt
// and Revisit follow-up questions.
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

async function gemini(prompt: string): Promise<string | null> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return null;
  const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.8-flash";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: "low" } },
    }),
  });
  if (!res.ok) {
    console.error("gemini error", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p: { text?: string }) => p.text ?? "").join("").trim();
  if (!text) return null;
  return text.replace(/^["'“]+|["'”]+$/g, "").replace(/\s*—\s*/g, ", ").trim();
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
      .neq("wedge", "intimacy").order("day", { ascending: false }).limit(60);
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

  return json({ error: "unknown action" }, 400);
});
