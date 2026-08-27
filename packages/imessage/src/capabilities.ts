import type { GovernedToolDef } from "@cortland/governed";

/**
 * "What can you do?" answered from the mounted tools themselves. Grouped by
 * the app each tool is scoped to, phrased as verbs a person would use, and
 * kept to one line per app — this is read on a phone. Because it is derived,
 * it cannot claim a capability that is not installed.
 */
const VERBS: Record<string, string> = {
  read: "read",
  search: "search",
  search_fulltext: "search full text",
  fulltext: "search full text",
  list: "list",
  lists: "list",
  thread: "follow threads",
  create: "create",
  create_draft: "draft",
  draft: "draft",
  send: "send (asks first)",
  mark: "flag",
  move: "file",
  append: "add to",
  complete: "tick off",
  delete: "delete",
  window: "look up",
  folders: "list folders",
  accounts: "list accounts",
  list_accounts: "list accounts",
  brief: "brief you",
};

export function capabilitiesText(
  tools: Array<Readonly<GovernedToolDef<Record<string, unknown>>>>
): string {
  const byScope = new Map<string, { verbs: Set<string>; gated: boolean }>();
  for (const tool of tools) {
    const entry = byScope.get(tool.scope) ?? { verbs: new Set(), gated: false };
    const suffix = tool.name.split("_").slice(1).join("_");
    entry.verbs.add(VERBS[suffix] ?? suffix.replace(/_/g, " "));
    if (tool.mode === "write-gated" || tool.mode === "destructive") entry.gated = true;
    byScope.set(tool.scope, entry);
  }
  if (byScope.size === 0) return "Nothing is mounted right now — no tools are installed.";

  const lines = [...byScope.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scope, e]) => `• ${scope}: ${[...e.verbs].join(", ")}`);

  return [
    "Here's what I can do with your Mac:",
    ...lines,
    "",
    "Anything that deletes or changes things asks you first — I text you a code and wait for \"yes <code>\". Reads just happen.",
    "Say \"clear context\" to start a fresh conversation.",
  ].join("\n");
}
