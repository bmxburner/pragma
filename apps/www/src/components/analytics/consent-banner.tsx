"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { privacyRoute } from "@/lib/legal";
import { appName } from "@/lib/shared";

import { useConsent } from "./consent-provider";

/**
 * The site's single consent surface: a bottom-centred card that gates all
 * analytics. It renders only until a decision is stored, and the container is
 * click-through so it never blocks the page behind it.
 */
export function ConsentBanner() {
  const { ready, bannerOpen, setConsent } = useConsent();
  if (!ready || !bannerOpen) return null;

  return (
    <aside
      aria-label="Cookie and analytics consent"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex justify-center px-4 pb-4"
    >
      <div className="border-border bg-card shadow-floating pointer-events-auto flex w-full max-w-2xl flex-col gap-4 rounded-xl border p-5 sm:flex-row sm:items-center sm:gap-6">
        <p className="text-muted-foreground text-sm">
          {appName} uses cookies to improve your experience and understand how the site is used.
          Nothing loads until you choose. Read the{" "}
          <Link href={privacyRoute} className="text-foreground underline underline-offset-4">
            privacy policy
          </Link>
          .
        </p>
        <div className="flex shrink-0 gap-2 sm:ml-auto">
          <Button variant="secondary" className="pill-cta" onClick={() => setConsent("denied")}>
            Decline
          </Button>
          <Button className="pill-cta" onClick={() => setConsent("granted")}>
            Accept
          </Button>
        </div>
      </div>
    </aside>
  );
}
