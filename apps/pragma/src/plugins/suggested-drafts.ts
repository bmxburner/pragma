import { useMemo } from "react";

import type {
  PluginContext,
  PluginIcon,
  SuggestedDraft,
  SuggestedDraftInput,
  SuggestedDraftProviderDefinition,
} from "@pragma-sh/plugin";

import { BUILTIN_SUGGESTED_DRAFT_PROVIDERS } from "@/lib/builtin-suggested-drafts";

import { resolvePluginAssetPath } from "./assets";
import { notifyFromPlugin, usePluginRuntimeState } from "./host-hooks";
import { useActivePlugins, type PluginRecord } from "./registry";

/** A suggested-draft provider bound to its plugin context, ready for the board. */
export interface ActiveSuggestedDraftProvider {
  /** Unique across providers: `builtin:<id>` or `<pluginId>:<id>`. */
  key: string;
  title: string;
  icon: PluginIcon | null;
  /** Browser URL of the provider's image, when it declares `iconPath`. */
  iconUrl: string | null;
  /** Browser URL of one draft's own image, when it declares `iconPath`. */
  draftIconUrl: (draft: SuggestedDraft) => string | null;
  suggest: (input: SuggestedDraftInput) => Promise<SuggestedDraft[]>;
}

/** Binds built-in and plugin providers for the board. Built-ins come first. */
function bindSuggestedDraftProviders(
  records: readonly PluginRecord[],
  runtime: Pick<PluginContext, "sdk" | "project"> | null,
): ActiveSuggestedDraftProvider[] {
  const bound = BUILTIN_SUGGESTED_DRAFT_PROVIDERS.map((provider) =>
    bindProvider(`builtin:${provider.id}`, provider, null, () => null),
  );
  if (!runtime) return bound;
  for (const record of records) bound.push(...bindPluginProviders(record, runtime));
  return bound;
}

/** Bind one loaded plugin's providers with its scoped runtime and asset paths. */
function bindPluginProviders(
  record: PluginRecord,
  runtime: Pick<PluginContext, "sdk" | "project">,
): ActiveSuggestedDraftProvider[] {
  if (record.status !== "loaded" || !record.definition) return [];
  const ctx: PluginContext = {
    pluginId: record.pluginId,
    ...(record.dir === undefined ? {} : { pluginDir: record.dir }),
    config: record.config,
    project: runtime.project,
    sdk: runtime.sdk,
    notify: notifyFromPlugin,
  };
  return (record.definition.suggestedDrafts ?? [])
    .filter((provider) => !provider.when || provider.when(ctx))
    .map((provider) =>
      bindProvider(`${record.pluginId}:${provider.id}`, provider, ctx, (path) =>
        resolvePluginAssetPath(path, record),
      ),
    );
}

function bindProvider(
  key: string,
  provider: SuggestedDraftProviderDefinition,
  ctx: PluginContext | null,
  assetUrl: (path: string | undefined) => string | null,
): ActiveSuggestedDraftProvider {
  // Built-ins ignore their context argument; plugins always receive a real one.
  const context = ctx ?? ({} as PluginContext);
  return {
    key,
    title: provider.title,
    icon: provider.icon ?? null,
    iconUrl: assetUrl(provider.iconPath),
    draftIconUrl: (draft) => assetUrl(draft.iconPath),
    suggest: async (input) => provider.suggest(input, context),
  };
}

/** React hook: the suggested-draft providers visible to the active project. */
export function useSuggestedDraftProviders(
  activeProjectId: string | null,
): ActiveSuggestedDraftProvider[] {
  const records = useActivePlugins(activeProjectId);
  const runtime = usePluginRuntimeState();
  return useMemo(
    () =>
      bindSuggestedDraftProviders(
        records,
        runtime.sdk ? { sdk: runtime.sdk, project: runtime.project } : null,
      ),
    [records, runtime.sdk, runtime.project],
  );
}
