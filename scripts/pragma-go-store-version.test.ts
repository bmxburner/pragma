import { describe, expect, test } from "bun:test";

import { bumpStoreVersion, compareVersions } from "./pragma-go-store-version";

const APP_JSON = `{
  "expo": {
    "name": "Pragma Go",
    "version": "1.3.0",
    "runtimeVersion": {
      "policy": "fingerprint"
    }
  }
}
`;

describe("compareVersions", () => {
  test("orders by major, then minor, then patch", () => {
    expect(compareVersions("1.4.0", "1.3.9")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("1.3.0", "1.3.1")).toBeLessThan(0);
  });

  test("rejects anything but major.minor.patch", () => {
    expect(() => compareVersions("1.4", "1.3.0")).toThrow("major.minor.patch");
    expect(() => compareVersions("v1.4.0", "1.3.0")).toThrow("major.minor.patch");
  });
});

describe("bumpStoreVersion", () => {
  test("rewrites only the version line", () => {
    const { previous, text } = bumpStoreVersion(APP_JSON, "1.4.0");
    expect(previous).toBe("1.3.0");
    expect(text).toBe(APP_JSON.replace('"version": "1.3.0"', '"version": "1.4.0"'));
  });

  test("refuses a version that is not higher", () => {
    expect(() => bumpStoreVersion(APP_JSON, "1.3.0")).toThrow("not higher");
    expect(() => bumpStoreVersion(APP_JSON, "1.2.9")).toThrow("not higher");
  });

  test("refuses an app.json whose version line is ambiguous", () => {
    const nested = APP_JSON.replace(
      '"policy": "fingerprint"',
      '"policy": "fingerprint",\n      "version": "1.3.0"',
    );
    expect(() => bumpStoreVersion(nested, "1.4.0")).toThrow("exactly one");
  });
});
