/**
 * Site analytics. The Reddit Pixel measures whether an ad click became a
 * download (the `Download` custom event) and Vercel Web Analytics records page
 * views for the site itself. Loaded by default, but gated behind the banner
 * wherever prior consent is required. Every value the provider, the banner, the
 * geo endpoint, and the privacy policy share lives here.
 */

/**
 * Reddit Ads pixel id. Public — it is visible in the page source of every site
 * that installs the pixel — so it is a constant rather than a secret/environment
 * value, kept here so the tracking code and the policy cannot drift apart.
 */
export const redditPixelId = "a2_jtoh66eyb9ft";

/** Default Reddit event; fired on every page view once analytics are active. */
export const redditPageVisitEvent = "PageVisit";

/**
 * Custom Reddit conversion event fired when a visitor starts a download.
 * Create a matching custom conversion named "Download" in Reddit's Events
 * Manager so the campaign can optimize and report on cost per download.
 */
export const redditDownloadEvent = "Download";

/** localStorage key holding the visitor's analytics decision. */
export const consentStorageKey = "pragma.analytics-consent";

/** Route returning whether the caller's region requires prior consent. */
export const geolocationRoute = "/api/geo";

/** A visitor's stored analytics decision. */
export type Consent = "granted" | "denied";

/** EEA member states plus the United Kingdom and Switzerland. */
const consentRequiredCountries: ReadonlySet<string> = new Set([
  // EU member states.
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  // EEA, outside the EU.
  "IS",
  "LI",
  "NO",
  // United Kingdom and Switzerland.
  "GB",
  "CH",
]);

/**
 * Whether a visitor's country requires prior consent. An unknown or missing
 * country is treated as requiring consent, so a failed or absent geo lookup
 * asks rather than tracks.
 */
export function requiresConsent(country: string | null | undefined): boolean {
  if (!country) return true;
  return consentRequiredCountries.has(country.toUpperCase());
}

/**
 * Read back a stored consent value. Anything that is not one of the two
 * decisions (missing, corrupted, or a value from a future format) reads as
 * undecided so the banner is shown again rather than silently tracking.
 */
export function parseConsent(value: string | null | undefined): Consent | null {
  return value === "granted" || value === "denied" ? value : null;
}
