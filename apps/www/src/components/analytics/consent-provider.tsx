"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { consentStorageKey, geolocationRoute, parseConsent, type Consent } from "@/lib/analytics";

interface ConsentContextValue {
  /** Effective decision; `null` while a consent-required visitor has not chosen. */
  consent: Consent | null;
  /** True once the stored decision and the region have both resolved. */
  ready: boolean;
  /** Whether the consent banner should be shown. */
  bannerOpen: boolean;
  /** Record a decision and persist it. */
  setConsent: (consent: Consent) => void;
  /** Re-open the banner so a visitor can change or withdraw their choice. */
  openSettings: () => void;
}

const ConsentContext = createContext<ConsentContextValue | null>(null);

/** Ask the server whether this visitor's region requires prior consent. */
async function fetchConsentRequired(): Promise<boolean> {
  try {
    const response = await fetch(geolocationRoute, { cache: "no-store" });
    if (!response.ok) return true;
    const data = (await response.json()) as { required?: boolean };
    return data.required !== false;
  } catch {
    // Unknown region -> ask rather than track.
    return true;
  }
}

/** The effective decision: an explicit choice, else granted unless consent is required. */
function effectiveConsent(stored: Consent | null, required: boolean): Consent | null {
  if (stored) return stored;
  return required ? null : "granted";
}

/** The banner shows while a consent-required visitor has not chosen, or when re-opened. */
function bannerVisible(stored: Consent | null, required: boolean, settingsOpen: boolean): boolean {
  return settingsOpen || (required && stored === null);
}

/**
 * Holds the analytics consent decision for the whole site. Analytics are on
 * wherever prior consent is not required; in a consent-required region they
 * wait for an explicit choice. The banner only renders once `ready` is true, so
 * the first paint never flashes a banner or a hydration mismatch.
 */
export function ConsentProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<Consent | null>(null);
  const [required, setRequired] = useState(true);
  const [ready, setReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    setStored(parseConsent(window.localStorage.getItem(consentStorageKey)));
    let live = true;
    void (async () => {
      const regionRequired = await fetchConsentRequired();
      if (!live) return;
      setRequired(regionRequired);
      setReady(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  const setConsent = useCallback((next: Consent) => {
    try {
      window.localStorage.setItem(consentStorageKey, next);
    } catch {
      // Storage can be unavailable (private mode, blocked cookies); the choice
      // still applies for this page load.
    }
    setStored(next);
    setSettingsOpen(false);
  }, []);

  const openSettings = useCallback(() => setSettingsOpen(true), []);

  const value = useMemo<ConsentContextValue>(
    () => ({
      consent: effectiveConsent(stored, required),
      ready,
      bannerOpen: bannerVisible(stored, required, settingsOpen),
      setConsent,
      openSettings,
    }),
    [stored, required, ready, settingsOpen, setConsent, openSettings],
  );

  return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}

/** Read and update the site's analytics consent decision. */
export function useConsent(): ConsentContextValue {
  const value = useContext(ConsentContext);
  if (!value) throw new Error("useConsent must be used within a ConsentProvider");
  return value;
}
