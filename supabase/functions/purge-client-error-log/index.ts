// ============================================================
// purge-client-error-log — enforce the 90-day client_error_log retention
// ============================================================
// client_error_log.sql's own header promised the table would stay lean via
// entries auto-deleted after 90 days, then left the actual delete commented
// out ("Run this as a Supabase scheduled function or manually as needed").
// Nobody did either, so nothing has ever purged a row. See
// supabase/migrations/20260913160000_purge_client_error_log.sql for the
// purge_client_error_log() RPC and the full reasoning behind the 90-day
// window.
//
// This is client-side JS error/stack/page/user-agent debugging data, not a
// record with a legal or financial retention floor (contrast
// sweep-child-photos, which carves out incident photos that must NEVER be
// swept by cron) — every row past the window is safe to delete
// unconditionally, so there is no such carve-out here.
//
// ⚠️ NOT YET SCHEDULED IN PRODUCTION. This function and its migration are
// deployed code with no pg_cron job pointing at them — see the PR description
// for the exact `cron.schedule(...)` statement (mirroring
// 20260909030842_scope_scheduled_job_credentials.sql's X-Cron-Secret /
// vault.decrypted_secrets pattern) that would activate it. Andrew's explicit
// approval is required before that statement is applied, per AGENTS.md's
// "scheduled jobs" rule.
//
// Same request-auth convention as every other scheduled job in this project:
// isAuthorizedCronRequest() checks X-Cron-Secret against CRON_SECRET (never a
// broad service-role JWT in the cron command text), and the database side is
// SECURITY DEFINER, revoked from PUBLIC/anon, granted to authenticated only.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isAuthorizedCronRequest, unauthorizedCronResponse } from "../_shared/cron-auth.ts";
import { purgeClientErrorLog } from "./logic.ts";

serve(async (req) => {
    if (!await isAuthorizedCronRequest(req)) return unauthorizedCronResponse();

    const admin = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
        { auth: { autoRefreshToken: false, persistSession: false } },
    );

    return purgeClientErrorLog(admin);
});
