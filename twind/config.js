// twind settings. The two Supabase values come from
// Supabase > Project Settings > API. Both are safe to publish:
// your data is protected by the sign-in and database rules, not by hiding these.
window.TWIND_CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  // Public half of the notification key pair (the private half lives in Supabase secrets).
  VAPID_PUBLIC_KEY: "BD1FRV5uzjQKcHYffiU-enW9Br2cXOcxqTm-qjmf46hpfXcqtI8Qege6nMMCZKm0XQ95FYtzMNspeuZ2kjOSuGA",
};
