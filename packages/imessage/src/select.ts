import type { GovernedToolDef } from "@cortland/governed";

type Tool = Readonly<GovernedToolDef<Record<string, unknown>>>;

/**
 * Send the model as little as possible.
 *
 * Every tool schema costs context on EVERY call — the four default packages
 * are ~2,400 tokens of JSON before the human types a word, against a window
 * that must also hold the conversation and the tool results. Most messages
 * concern one app, so this routes by the words actually used and ships only
 * that app's tools (typically ~400 tokens — an ~80% cut).
 *
 * Failure posture: when nothing matches, or the message mentions several
 * apps, send everything. A wrong guess would silently remove a capability the
 * human asked for, which is worse than spending the tokens — so the router
 * only ever narrows on positive evidence.
 */

// Plurals matter: a person writes "what meetings do I have", never "meeting".
const SCOPE_WORDS: Record<string, RegExp> = {
  Mail: /\b(e-?mails?|mails?|inbox|message from|senders?|unread|repl(y|ies)|drafts?|forward|cc|subjects?|attachments?)\b/i,
  Reminders: /\b(reminders?|remind|to-?dos?|tasks?|checklists?|don'?t forget|shopping list|groceries)\b/i,
  Notes: /\b(notes?|jot|write (this |that |it )?down|memos?|scratch)\b/i,
  Calendar: /\b(calendars?|meetings?|events?|appointments?|schedul(e|es|ed|ing)|busy|free time|agendas?|invites?)\b/i,
};

/** Words that imply a time-bound thing without naming the app; both the
 *  calendar and reminders can serve them, so offer both rather than guess. */
const TEMPORAL = /\b(tomorrow|today|tonight|next (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|at \d|am\b|pm\b)\b/i;

export interface Selection {
  tools: Tool[];
  /** Scopes chosen, or "all" when the router declined to narrow. */
  reason: string;
}

export function selectTools(text: string, tools: Tool[]): Selection {
  const scopes = new Set<string>();
  for (const [scope, pattern] of Object.entries(SCOPE_WORDS)) {
    if (pattern.test(text)) scopes.add(scope);
  }
  // A bare "…tomorrow at 2" could be either; give both rather than misroute.
  if (scopes.size === 0 && TEMPORAL.test(text)) {
    scopes.add("Reminders");
    scopes.add("Calendar");
  }
  if (scopes.size === 0) return { tools, reason: "all" };

  const selected = tools.filter((t) => scopes.has(t.scope));
  // Never hand back an empty set: if the matched app isn't installed, the
  // human still deserves whatever is.
  if (selected.length === 0) return { tools, reason: "all" };
  return { tools: selected, reason: [...scopes].sort().join("+") };
}
