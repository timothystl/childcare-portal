async function digest(value: string): Promise<Uint8Array> {
    const bytes = new TextEncoder().encode(value);
    return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
    return difference === 0;
}

/** Authenticate pg_cron without giving the scheduled request a service-role JWT. */
export async function isAuthorizedCronRequest(req: Request): Promise<boolean> {
    const expected = Deno.env.get("CRON_SECRET") ?? "";
    const supplied = req.headers.get("X-Cron-Secret") ?? "";
    if (!expected || !supplied) return false;
    return equalBytes(await digest(expected), await digest(supplied));
}

export function unauthorizedCronResponse(): Response {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
    });
}
