import { restoreFanoutTab } from "@/lib/tauri";

/** The workspace surface {@link openAgentTab} needs: the loaded tabs and the activate action. */
export interface AgentTabHost {
  /** Every tab currently loaded for the selected project. */
  projectTabs: readonly { id: string; worktreeId: string }[];
  activateTabLocation: (projectId: string, worktreeId: string, tabId: string) => Promise<void>;
}

/**
 * Opens a host-created agent tab, restoring the exact session first when the
 * desktop has not yet adopted the host's tab row.
 *
 * Selecting the worktree alone would expose the generic no-tabs welcome screen
 * while adoption is in flight, so a missing host-created tab is restored under
 * its own id before activation — the same sequence the sidebar's fanout rows
 * use, shared here so card-driven navigation cannot drift from it.
 */
export async function openAgentTab(
  host: AgentTabHost,
  projectId: string,
  worktreeId: string,
  tabId: string,
): Promise<void> {
  const known = host.projectTabs.some((tab) => tab.id === tabId && tab.worktreeId === worktreeId);
  if (!known) {
    await restoreFanoutTab(projectId, worktreeId, tabId);
  }
  await host.activateTabLocation(projectId, worktreeId, tabId);
}
