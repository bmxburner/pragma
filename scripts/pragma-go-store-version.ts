#!/usr/bin/env bun
/**
 * Bumps Pragma Go's App Store marketing version, `expo.version` in
 * `apps/pragma-go/app.json`.
 *
 * Release Please deliberately never writes that field (see
 * `scripts/release-config.test.ts`), so a `pragma-go-v*` release can upload a
 * TestFlight build that still carries the previous marketing version — and App
 * Store Connect only lets a version select builds whose version string matches
 * it. This is the one writer: `.github/workflows/pragma-go-store-release.yml`
 * runs it, commits the result, and builds the binary from that commit.
 *
 *   bun scripts/pragma-go-store-version.ts <major.minor.patch>
 *
 * Only the version line is rewritten, so the file stays exactly as oxfmt left it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps",
  "pragma-go",
  "app.json",
);

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(version: string): [number, number, number] {
  const match = VERSION_PATTERN.exec(version);
  if (!match) throw new Error(`"${version}" is not a major.minor.patch version`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative, zero, or positive as `a` is lower than, equal to, or higher than `b`. */
export function compareVersions(a: string, b: string): number {
  const right = parseVersion(b);
  const differences = parseVersion(a).map((part, index) => part - (right[index] ?? 0));
  return differences.find((difference) => difference !== 0) ?? 0;
}

/** The result of a bump: the previous version and the rewritten `app.json` text. */
export interface StoreVersionBump {
  previous: string;
  text: string;
}

function readStoreVersion(appJson: string): string {
  const version = (JSON.parse(appJson) as { expo?: { version?: unknown } }).expo?.version;
  if (typeof version !== "string") throw new Error("app.json has no expo.version string");
  return version;
}

function replaceVersionLine(appJson: string, previous: string, requested: string): string {
  const line = `"version": ${JSON.stringify(previous)}`;
  const occurrences = appJson.split(line).length - 1;
  if (occurrences !== 1) {
    throw new Error(`expected exactly one ${line} in app.json, found ${occurrences}`);
  }
  return appJson.replace(line, `"version": ${JSON.stringify(requested)}`);
}

/**
 * Rewrites `expo.version` in `app.json` text to `requested`. Refuses anything
 * that is not strictly higher: App Store Connect rejects a build under a version
 * that is already approved, and a lower one would sit below builds already in
 * TestFlight.
 */
export function bumpStoreVersion(appJson: string, requested: string): StoreVersionBump {
  const previous = readStoreVersion(appJson);
  if (compareVersions(requested, previous) <= 0) {
    throw new Error(`${requested} is not higher than the current store version ${previous}`);
  }
  return { previous, text: replaceVersionLine(appJson, previous, requested) };
}

function main(): void {
  const requested = process.argv[2];
  if (!requested) throw new Error("usage: bun scripts/pragma-go-store-version.ts <version>");
  const { previous, text } = bumpStoreVersion(readFileSync(APP_JSON, "utf8"), requested);
  writeFileSync(APP_JSON, text);
  console.log(`Pragma Go store version ${previous} → ${requested}`);
}

if (import.meta.main) main();
