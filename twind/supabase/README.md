# twind backend

| File | What it is | Where it goes |
|---|---|---|
| `schema.sql` | Tables, privacy rules and the actions the app calls | Supabase > SQL Editor, run once |
| `functions/twind-notify/index.ts` | Push notifications (locked in, answered, daily nudge) | Edge Function named `twind-notify`, Verify JWT off |
| `functions/twind-ai/index.ts` | Gemini: "talk about this tonight" prompts and Revisit questions | Edge Function named `twind-ai`, Verify JWT off |
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
- Your partner's answer is hidden from you until you have both answered (enforced by the database, not the app).
- The invite code can't be changed or read by anyone outside the couple.
- Intimacy-day answers are never sent to Gemini for Revisit questions.
