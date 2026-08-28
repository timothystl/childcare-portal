// Emergency replacement for a temporary live test function that previously
// contained a hardcoded administrator token and could create Stax charges and
// refunds. Deploy this inert version immediately if the function cannot be
// deleted outright, then delete the function from the Supabase dashboard.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(() => new Response("gone", {
    status: 410,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
}));
