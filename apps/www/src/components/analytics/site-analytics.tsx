"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { Analytics } from "@vercel/analytics/next";

import { redditPageVisitEvent, redditPixelId } from "@/lib/analytics";
import { loadRedditPixel, setRedditTracking, trackReddit } from "@/lib/reddit-pixel";

import { useConsent } from "./consent-provider";

/**
 * Loads consented analytics: the Reddit Pixel (once) and Vercel Web Analytics
 * (mounted only while granted). A `PageVisit` is sent on first consent and on
 * every client-side route change. Nothing here runs without consent.
 */
export function SiteAnalytics() {
  const { consent } = useConsent();
  const pathname = usePathname();
  const granted = consent === "granted";

  useEffect(() => {
    setRedditTracking(granted);
    if (granted) loadRedditPixel(redditPixelId);
  }, [granted]);

  useEffect(() => {
    if (granted) trackReddit(redditPageVisitEvent);
  }, [granted, pathname]);

  return granted ? <Analytics /> : null;
}
