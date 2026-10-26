import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";

import { createPragmaOpencodeHooks } from "./hooks";
import { type PragmaReporterOptions, createSdkReporter } from "./reporter";

/** Options accepted by `@pragma-sh/opencode-plugin` in opencode's plugin config tuple. */
export interface PragmaOpencodePluginOptions extends PluginOptions, PragmaReporterOptions {}

/**
 * Pragma opencode plugin (OpenCode v1 plugin API) — reports agent status to
 * Pragma. OpenCode v2 loads `./v2` instead; see `scripts/install.mjs`.
 */
export const PragmaOpencodePlugin: Plugin = async (
  _input: PluginInput,
  options?: PluginOptions,
) => {
  const reporter = createSdkReporter(parseOptions(options));
  // Opening opencode must not inherit a stale indicator from a previous run in
  // this same Pragma tab that exited without cleanup — e.g. killed with SIGINT
  // or crashed, where the `dispose` hook never runs to report `cleared`, so its
  // last `running`/`done`/`attention` status lingers in the long-lived daemon.
  // Clear it up front on load; genuine activity re-raises status via the hooks.
  void reporter.cleared();
  return createPragmaOpencodeHooks(reporter);
};

export default PragmaOpencodePlugin;

function parseOptions(options: PluginOptions | undefined): PragmaOpencodePluginOptions {
  return options ?? {};
}
