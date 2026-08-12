// ============================================================
// upload-child-photo — staff post a photo to the day feed
// ============================================================
// Staff have no Supabase account; their credential is the kiosk PIN. So this
// mirrors log_child_event: the PIN is verified SERVER-SIDE, and the write
// happens with the service role. anon holds no storage grant on this bucket.
//
// ⚠️ SECURITY POSTURE — copy send-invoice, not the older functions.
// The client sends a PIN, the image, and which children are depicted. It does
// NOT send a storage path, an expiry, or a room: those are decided here. A
// caller cannot choose where the object lands, how long it lives, or backdate
// it, which is the class of hole T1/FS6/FS11 describe.
//
// Deploy with JWT verification OFF — staff arrive with a PIN, not a token.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
    "https://mdo.timothystl.org",
    "http://localhost:8000",
]);

// Daily photos are ephemeral by design and parents are told so. Incident
// photos are evidence and never expire here — the director removes those by
// hand, because no cron should decide when injury documentation stops existing.
const DAILY_RETENTION_DAYS = 7;
const MAX_BYTES  = 5 * 1024 * 1024;
const MAX_TAGGED = 12;   // a room, not a school assembly

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
        const pin        = String(body.pin ?? "").trim();
        const studentIds = Array.isArray(body.student_ids) ? body.student_ids.map(String) : [];
        const caption    = String(body.caption ?? "").trim().slice(0, 300);
        const kind       = body.kind === "incident" ? "incident" : "daily";
        const dataUrl    = String(body.image ?? "");

        if (!/^\d{4,8}$/.test(pin))  return json(req, { error: "invalid_credentials" }, 400);
        if (!studentIds.length)      return json(req, { error: "no_children_tagged" }, 400);
        if (studentIds.length > MAX_TAGGED) return json(req, { error: "too_many_children" }, 400);

        // 1. Verify the PIN server-side. staff_id_for_pin is not granted to
        //    anon precisely so this is the only way to reach it.
        const { data: staffId, error: pinErr } =
            await admin.rpc("staff_id_for_pin", { p_pin: parseInt(pin, 10) });
        if (pinErr) {
            console.error("staff_id_for_pin:", pinErr);
            return json(req, { error: "server_error" }, 500);
        }
        if (!staffId) return json(req, { error: "invalid_credentials" }, 401);

        // 2. Decode. Only the two formats the bucket accepts; anything else is
        //    rejected rather than stored and discovered later.
        const m = dataUrl.match(/^data:(image\/(?:jpeg|webp));base64,(.+)$/);
        if (!m) return json(req, { error: "unsupported_image" }, 400);
        const contentType = m[1];
        const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
        if (bytes.byteLength > MAX_BYTES) return json(req, { error: "image_too_large" }, 413);

        // 3. Confirm every tagged id is a real student before anything is
        //    stored, so a typo cannot produce an object nobody can ever see.
        const { data: students, error: stErr } = await admin
            .from("students").select("id").in("id", studentIds);
        if (stErr) {
            console.error("students:", stErr);
            return json(req, { error: "server_error" }, 500);
        }
        if (!students || students.length !== studentIds.length) {
            return json(req, { error: "unknown_child" }, 400);
        }

        // 4. The path is chosen HERE, never by the caller.
        const careDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
        const ext  = contentType === "image/webp" ? "webp" : "jpg";
        const path = `${careDate}/${crypto.randomUUID()}.${ext}`;

        const { error: upErr } = await admin.storage
            .from("child-photos")
            .upload(path, bytes, { contentType, upsert: false });
        if (upErr) {
            console.error("storage upload:", upErr);
            return json(req, { error: "upload_failed" }, 500);
        }

        const expiresAt = kind === "daily"
            ? new Date(Date.now() + DAILY_RETENTION_DAYS * 86400000).toISOString()
            : null;

        const { data: photo, error: insErr } = await admin
            .from("child_photos")
            .insert({
                kind, care_date: careDate, storage_path: path,
                caption: caption || null, posted_by_staff_id: staffId,
                expires_at: expiresAt,
            })
            .select("id")
            .single();

        if (insErr || !photo) {
            // Roll the object back. An object with no row is invisible to every
            // policy — it would sit in the bucket forever, unreachable and
            // uncounted, which is the worst of both worlds for child imagery.
            console.error("child_photos insert:", insErr);
            await admin.storage.from("child-photos").remove([path]);
            return json(req, { error: "upload_failed" }, 500);
        }

        const { error: tagErr } = await admin.from("child_photo_students")
            .insert(studentIds.map(id => ({ photo_id: photo.id, student_id: id })));
        if (tagErr) {
            // Same reasoning: a photo with no tags is releasable to nobody
            // (photo_is_releasable fails closed), so leaving it would be a
            // silent black hole.
            console.error("child_photo_students insert:", tagErr);
            await admin.from("child_photos").delete().eq("id", photo.id);
            await admin.storage.from("child-photos").remove([path]);
            return json(req, { error: "upload_failed" }, 500);
        }

        return json(req, { id: photo.id, care_date: careDate, expires_at: expiresAt });

    } catch (err) {
        console.error("upload-child-photo:", err);
        return json(req, { error: "server_error" }, 500);
    }
});
