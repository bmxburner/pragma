"use client";

import { useConsent } from "./consent-provider";

/**
 * Footer control that re-opens the consent banner, so a visitor in a region
 * where analytics load by default can still turn them off.
 */
export function ConsentSettingsLink({ className }: { className?: string }) {
  const { openSettings } = useConsent();
  return (
    <button type="button" onClick={openSettings} className={className}>
      Cookie settings
    </button>
  );
}
