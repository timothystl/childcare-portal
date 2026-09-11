import { safeEqual } from "./timing-safe.ts";

/** Authenticate pg_cron without giving the scheduled request a service-role JWT. */
export async function isAuthorizedCronRequest(req: Request): Promise<boolean> {
    const expected = Deno.env.get("CRON_SECRET") ?? "";
    const supplied = req.headers.get("X-Cron-Secret") ?? "";
    if (!expected || !supplied) return false;
    return safeEqual(expected, supplied);
}

export function unauthorizedCronResponse(): Response {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
    });
}
