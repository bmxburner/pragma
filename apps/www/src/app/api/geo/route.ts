import { requiresConsent } from "@/lib/analytics";

/**
 * `GET /api/geo` — tells the client whether its region requires prior consent
 * for analytics, from Vercel's `x-vercel-ip-country` header. An absent header
 * (local development, non-Vercel hosts) reads as "required", so tracking is the
 * exception and asking is the default.
 */
export function GET(request: Request): Response {
  const country = request.headers.get("x-vercel-ip-country");
  return Response.json(
    { required: requiresConsent(country) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
