/**
 * Reddit Pixel loader. This mirrors the snippet Reddit provides — the `rdt`
 * queue is defined synchronously so events fired before `pixel.js` finishes
 * loading are queued and replayed — but it runs only after the visitor has
 * accepted the consent banner. `trackReddit` is a no-op until then, so no
 * request leaves the browser before consent.
 */

/** Events the Reddit Pixel accepts; `Custom` carries a `customEventName`. */
type RedditEvent =
  | "PageVisit"
  | "ViewContent"
  | "Search"
  | "AddToCart"
  | "AddToWishlist"
  | "Purchase"
  | "Lead"
  | "SignUp"
  | "Custom";

interface RedditPixel {
  (...args: unknown[]): void;
  sendEvent?: (...args: unknown[]) => void;
  callQueue: unknown[][];
}

declare global {
  interface Window {
    rdt?: RedditPixel;
  }
}

/**
 * Whether events may be dispatched. Mirrors the consent state so that a
 * visitor who turns analytics off after they loaded by default stops sending,
 * and a re-enable resumes, without reloading the page.
 */
let trackingEnabled = false;

/** Enable or disable event dispatch. Called whenever the consent decision changes. */
export function setRedditTracking(enabled: boolean): void {
  trackingEnabled = enabled;
}

/**
 * The queue stub Reddit's snippet installs before its script loads: calls made
 * before `pixel.js` attaches `sendEvent` are buffered and replayed.
 */
function createPixelStub(): RedditPixel {
  const pixel = function (...args: unknown[]) {
    if (pixel.sendEvent) pixel.sendEvent(...args);
    else pixel.callQueue.push(args);
  } as RedditPixel;
  pixel.callQueue = [];
  return pixel;
}

/** Inject Reddit's `pixel.js`, before the first existing script to preserve order. */
function injectPixelScript(pixelId: string): void {
  const script = document.createElement("script");
  script.src = `https://www.redditstatic.com/ads/pixel.js?pixel_id=${pixelId}`;
  script.async = true;
  const first = document.getElementsByTagName("script")[0];
  if (first?.parentNode) first.parentNode.insertBefore(script, first);
  else document.head.appendChild(script);
}

/**
 * Inject Reddit's `pixel.js` and initialize it. Idempotent: a second call after
 * the stub exists (a re-render, a fast refresh) is a no-op.
 */
export function loadRedditPixel(pixelId: string): void {
  if (typeof window === "undefined" || window.rdt) return;
  const pixel = createPixelStub();
  window.rdt = pixel;
  injectPixelScript(pixelId);
  pixel("init", pixelId);
}

/** The active pixel stub, or `undefined` when tracking is off or not yet loaded. */
function activePixel(): RedditPixel | undefined {
  if (!trackingEnabled || typeof window === "undefined") return undefined;
  return window.rdt;
}

/** Fire a Reddit event. No-op unless tracking is enabled and the stub exists. */
export function trackReddit(event: RedditEvent, metadata?: Record<string, unknown>): void {
  const pixel = activePixel();
  if (!pixel) return;
  if (metadata) pixel("track", event, metadata);
  else pixel("track", event);
}

/** Fire the `Download` custom conversion event Reddit Ads reports on. */
export function trackRedditDownload(eventName: string): void {
  trackReddit("Custom", { customEventName: eventName });
}
