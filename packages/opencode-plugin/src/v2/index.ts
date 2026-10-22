// The `promise/plugin` subpath is the bare `define` helper; the package root
// re-exports every schema (and Effect with it), which this bundle never needs.
import { type Plugin, define } from "@opencode/plugin/promise/plugin";

import { PRAGMA_OPENCODE_V2_PLUGIN_ID } from "./id";

export { PRAGMA_OPENCODE_V2_PLUGIN_ID };

/**
 * Pragma's OpenCode v2 server entry. OpenCode requires one before it will load
 * a plugin directory, and it is what marks the sibling `tui` entry
 * (`./tui.ts`) for the TUI to load — but it deliberately reports nothing.
 *
 * v2 server plugins run inside the shared `opencode serve --service` daemon,
 * which serves every tab and inherits the env of whatever started it, so a
 * report from here would be dropped or, worse, land on the wrong tab. Status
 * reporting lives in the TUI entry, which runs in the tab's own process.
 */
export const PragmaOpencodeV2Plugin: Plugin = define({
  id: PRAGMA_OPENCODE_V2_PLUGIN_ID,
  setup() {},
});

export default PragmaOpencodeV2Plugin;
