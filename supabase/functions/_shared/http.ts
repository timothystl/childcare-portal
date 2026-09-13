// ============================================================
// http — shared CORS + JSON-response helpers for Edge Functions
// ============================================================
// Before this, corsHeaders()/json() were pasted independently into ~20
// functions, in four slightly different shapes (single-origin string vs. an
// ALLOWED_ORIGINS Set; json(body, status[, headers]) vs. json(req, body,
// status) with CORS baked in). One copy means one place to get the origin
// check right.
//
// corsHeaders() only ever echoes back the caller's own Origin header when it
// is on the allowlist (never a wildcard), matching every prior copy's
// behavior — an unrecognized Origin gets an empty allow-origin value, which
// the browser then blocks itself.
//
// json() takes headers as a plain object rather than baking CORS in, so a
// server-to-server function (a webhook, a cron job) that has no Origin to
// check at all can call json(body, status) with no third argument, and a
// browser-facing function passes corsHeaders(req) explicitly. Neither shape
// is forced to carry headers it doesn't need.
// ============================================================

export const MDO_ORIGIN = "https://mdo.timothystl.org";

export function corsHeaders(
    req: Request,
    allowedOrigin: string | Set<string> = MDO_ORIGIN,
): Record<string, string> {
    const origin = req.headers.get("origin") || "";
    const allowed = typeof allowedOrigin === "string"
        ? origin === allowedOrigin
        : allowedOrigin.has(origin);
    return {
        "Access-Control-Allow-Origin": allowed ? origin : "",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...headers, "Content-Type": "application/json" },
    });
}
