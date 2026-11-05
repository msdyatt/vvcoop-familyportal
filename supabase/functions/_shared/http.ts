/**
 * Response helpers every edge function used to copy-paste. Browser-called
 * functions answer their own CORS preflight, so they all need the same
 * headers; keeping one copy means a change (a new allowed header, say)
 * cannot be applied to seven functions and missed in an eighth.
 */
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
