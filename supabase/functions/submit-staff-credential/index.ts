// ============================================================
// submit-staff-credential — staff log CPR/first-aid or a TB test, with
// their own scan/photo attached
// ============================================================
// Staff have no Supabase account; their credential is the kiosk PIN. Same
// posture as upload-child-photo: the PIN is verified SERVER-SIDE and the
// write (row + storage object) happens with the service role. anon holds no
// storage grant on the staff-credentials bucket at all.
//
// ⚠️ The client sends a PIN, the credential's own dates, and an optional
// file. It does NOT send a staff_id to attribute the record to, a storage
// path, or which bucket — those are decided here. A caller cannot log a
// credential for someone else or choose where the object lands.
//
// Deploy with JWT verification OFF — staff arrive with a PIN, not a token.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
    "https://mdo.timothystl.org",
    "http://localhost:8000",
]);

const MAX_BYTES = 8 * 1024 * 1024;
const CREDENTIAL_TYPES = new Set(["cpr_first_aid", "tb_test", "other"]);

function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin") || "";
    return {
        "Access-Control-Allow-Origin":  ALLOWED_ORIGINS.has(origin) ? origin : "",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json",
    };
}

function json(req: Request, body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: corsHeaders(req) });
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
    if (req.method !== "POST")    return json(req, { error: "method_not_allowed" }, 405);

    const origin = req.headers.get("origin") || "";
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json(req, { error: "forbidden" }, 403);

    const admin = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
        { auth: { autoRefreshToken: false, persistSession: false } },
    );

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json(req, { error: "bad_request" }, 400); }

    try {
        const staffId          = String(body.staff_id ?? "").trim();
        const pin               = String(body.pin ?? "").trim();
        const credentialType   = String(body.credential_type ?? "");
        const label             = String(body.label ?? "").trim().slice(0, 200);
        const completedAt      = String(body.completed_at ?? "");
        const expiresAt        = body.expires_at ? String(body.expires_at) : null;
        const dataUrl           = body.document ? String(body.document) : "";

        if (!staffId)                        return json(req, { error: "invalid_credentials" }, 400);
        if (!/^\d{4,8}$/.test(pin))          return json(req, { error: "invalid_credentials" }, 400);
        if (!CREDENTIAL_TYPES.has(credentialType)) return json(req, { error: "invalid_type" }, 400);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(completedAt)) return json(req, { error: "invalid_date" }, 400);
        if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) return json(req, { error: "invalid_date" }, 400);

        // 1. Verify the PIN server-side, against a named staff member. The
        //    caller's OWN id is what the record is attributed to — nothing in
        //    this body can point it at anyone else.
        const { data: verifiedStaffId, error: pinErr } =
            await admin.rpc("staff_id_for_pin", { p_staff_id: staffId, p_pin: parseInt(pin, 10) });
        if (pinErr) {
            console.error("staff_id_for_pin:", pinErr);
            return json(req, { error: "server_error" }, 500);
        }
        if (!verifiedStaffId) return json(req, { error: "invalid_credentials" }, 401);

        // A completion date cannot be in the future — mirrors
        // staff_submit_credential's own guard, checked again here since this
        // path inserts directly rather than calling that RPC.
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
        if (completedAt > today) return json(req, { error: "invalid_date" }, 400);

        // 2. Decode the attached document, if any. Optional — a staff member
        //    can log the dates now and attach the scan later.
        let path: string | null = null;
        let contentType = "";
        let bytes: Uint8Array | null = null;
        if (dataUrl) {
            const m = dataUrl.match(/^data:(application\/pdf|image\/(?:jpeg|png|webp));base64,(.+)$/);
            if (!m) return json(req, { error: "unsupported_file" }, 400);
            contentType = m[1];
            bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
            if (bytes.byteLength > MAX_BYTES) return json(req, { error: "file_too_large" }, 413);

            const ext = contentType === "application/pdf" ? "pdf"
                      : contentType === "image/png" ? "png"
                      : contentType === "image/webp" ? "webp" : "jpg";
            path = `${verifiedStaffId}/${crypto.randomUUID()}.${ext}`;

            const { error: upErr } = await admin.storage
                .from("staff-credentials")
                .upload(path, bytes, { contentType, upsert: false });
            if (upErr) {
                console.error("storage upload:", upErr);
                return json(req, { error: "upload_failed" }, 500);
            }
        }

        // 3. The row. If this fails, roll the object back — an object with no
        //    row is invisible to every policy and would sit in the bucket
        //    forever, unreachable and uncounted.
        const { data: row, error: insErr } = await admin
            .from("staff_credentials")
            .insert({
                staff_id: verifiedStaffId,
                credential_type: credentialType,
                label: label || null,
                completed_at: completedAt,
                expires_at: expiresAt,
                document_path: path,
                uploaded_by_staff_id: verifiedStaffId,
            })
            .select("id")
            .single();

        if (insErr || !row) {
            console.error("staff_credentials insert:", insErr);
            if (path) await admin.storage.from("staff-credentials").remove([path]);
            return json(req, { error: "save_failed" }, 500);
        }

        return json(req, { id: row.id });

    } catch (err) {
        console.error("submit-staff-credential:", err);
        return json(req, { error: "server_error" }, 500);
    }
});
