import { describe, expect, test } from "bun:test";

import {
  consentStorageKey,
  parseConsent,
  redditDownloadEvent,
  redditPageVisitEvent,
  redditPixelId,
  requiresConsent,
} from "./analytics";

describe("parseConsent", () => {
  test("returns the two stored decisions", () => {
    expect(parseConsent("granted")).toBe("granted");
    expect(parseConsent("denied")).toBe("denied");
  });

  test("treats anything else as undecided", () => {
    for (const value of [null, undefined, "", "yes", "GRANTED", "true", "1"]) {
      expect(parseConsent(value)).toBeNull();
    }
  });
});

describe("requiresConsent", () => {
  test("requires consent across the EEA, the UK, and Switzerland", () => {
    for (const country of ["DE", "FR", "ES", "NO", "IS", "LI", "GB", "CH"]) {
      expect(requiresConsent(country)).toBe(true);
    }
  });

  test("does not require consent outside those regions", () => {
    for (const country of ["US", "CA", "MX", "BR", "AU", "JP", "IN", "ZA"]) {
      expect(requiresConsent(country)).toBe(false);
    }
  });

  test("is case-insensitive", () => {
    expect(requiresConsent("gb")).toBe(true);
    expect(requiresConsent("us")).toBe(false);
  });

  test("asks when the country is unknown", () => {
    for (const value of [null, undefined, ""]) {
      expect(requiresConsent(value)).toBe(true);
    }
  });
});

describe("analytics facts", () => {
  test("pin the pixel id, event names, and storage key", () => {
    expect(redditPixelId).toBe("a2_jtoh66eyb9ft");
    expect(redditPageVisitEvent).toBe("PageVisit");
    expect(redditDownloadEvent).toBe("Download");
    expect(consentStorageKey).toBe("pragma.analytics-consent");
  });
});
