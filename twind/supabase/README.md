# twind backend

| File | What it is | Where it goes |
|---|---|---|
| `schema.sql` | Tables, privacy rules and the actions the app calls | Supabase > SQL Editor, run once |
| `functions/twind-notify/index.ts` | Push notifications (locked in, answered, late answers, reactions, daily nudge, Sunday 7 PM recap) | Edge Function named `twind-notify`, Verify JWT off |
| `functions/twind-ai/index.ts` | Gemini: "talk about this tonight" prompts, Revisit questions and the weekly recap | Edge Function named `twind-ai`, Verify JWT off |
| `patch-week.sql` | Midnight unlock, late answers, reactions and replies, save for later, weekly recap | SQL Editor, run once |
| `cron.sql` | Runs the daily nudge every 30 minutes | SQL Editor, run once after the functions are deployed |

## Secrets (Edge Functions > Secrets)

- `VAPID_PUBLIC_KEY`: same value as `VAPID_PUBLIC_KEY` in `../config.js`
- `VAPID_PRIVATE_KEY`: private half of that key pair (never commit it)
- `VAPID_SUBJECT`: `mailto:` plus your email
- `CRON_SECRET`: any long random string; must match `cron.sql`
- `GEMINI_API_KEY`: from Google AI Studio
- `GEMINI_MODEL`: optional, defaults to `gemini-3.8-flash`

## Privacy model

- Each person sees only their own couple's data.
- Your partner's answer is hidden from you until you have both answered, or until midnight that day (enforced by the database, not the app).
- Missed a day? You can still answer it later. It shows as "answered late."
- The invite code can't be changed or read by anyone outside the couple.
- Intimacy-day answers are never sent to Gemini, for Revisit questions or the weekly recap.
