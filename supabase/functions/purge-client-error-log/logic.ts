// ============================================================
// purge-client-error-log logic — separated from index.ts so it is testable
// ============================================================
// index.ts imports Deno's remote `serve()` and `createClient()` (deno.land /
// esm.sh URL specifiers), which the Node test runner cannot resolve. Every
// _shared module in this project (http.ts, cron-auth.ts, timing-safe.ts) is
// kept free of those remote imports for exactly that reason, and is unit
// tested directly (see test/shared/http.test.js). This module follows the
// same rule: it depends only on ../_shared/http.ts and a minimal structural
// type for the admin client, so it can be imported and exercised in Node
// without pulling in Deno-only code.

import { json } from "../_shared/http.ts";

/** The one call this function needs from a Supabase client — kept minimal so
 *  tests can supply a fake without constructing a real supabase-js client. */
export interface PurgeRpcClient {
    rpc(fn: "purge_client_error_log"): Promise<{ data: unknown; error: unknown }>;
}

/**
 * Calls purge_client_error_log() (see
 * supabase/migrations/20260915134514_purge_client_error_log.sql for the
 * 90-day retention window and why) and turns the result into an HTTP
 * Response. No CORS headers: this is a server-to-server cron caller, not a
 * browser (see _shared/http.ts's json() doc comment on that distinction).
 */
export async function purgeClientErrorLog(admin: PurgeRpcClient): Promise<Response> {
    try {
        const { data, error } = await admin.rpc("purge_client_error_log");
        if (error) {
            console.error("purge_client_error_log rpc:", error);
            return json({ error: "purge_failed" }, 500);
        }
        const deleted = typeof data === "number" ? data : Number(data) || 0;
        console.log(`purged ${deleted} client_error_log row(s) past the retention window`);
        return json({ deleted }, 200);
    } catch (err) {
        console.error("purge-client-error-log:", err);
        return json({ error: "server_error" }, 500);
    }
}
