import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// OpenCode v2 loads a path plugin only from a package *directory* ("configured
// plugin path must be a directory"), resolving its `.` export. Give the v2
// bundle its own manifest so `dist/v2` is that directory. The TUI entry is
// found beside it as `tui.mjs` (OpenCode probes `<dir>/tui` for a path plugin).
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const manifest = {
  name: `${packageJson.name}-v2`,
  version: packageJson.version,
  private: true,
  type: "module",
  exports: { ".": "./index.mjs", "./tui": "./tui.mjs" },
};
await writeFile(
  join(packageRoot, "dist", "v2", "package.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
