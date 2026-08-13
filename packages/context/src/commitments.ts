import { createHash } from "node:crypto";
import { z } from "zod";
import { fence, runJxa } from "@cortland/governed";
import { extractJsonArray, type ModelProvider } from "./model.js";
import type { ContextStore } from "./store.js";

/**
 * Commitment extraction (M3, Layer 1). Pointers-not-copies holds: candidate
 * SENT message bodies are fetched transiently from Mail, fed to the model
 * fenced, and discarded — only the extracted commitment text and its pointer
 * are stored (immutable AI layer).
 */

const CANDIDATE_DAYS = 14;
const MAX_CANDIDATES = 10;
const BODY_CAP = 2000;

export function buildSentBodyScript(messageId: string): string {
  return `
const Mail = Application("Mail");
if (!Mail.running()) { Mail.launch(); }
const hits = Mail.sentMailbox.messages.whose({ messageId: ${JSON.stringify(messageId)} })();
if (hits.length === 0) { "" } else { (hits[0].content() || "").toString().slice(0, ${BODY_CAP}) }
`;
}

const ExtractedSchema = z.array(
  z.object({
    messageId: z.string().min(1),
    text: z.string().min(3),
    due: z.string().nullable().optional(),
  })
);

export interface CommitmentDeps {
  provider: ModelProvider;
  log: (message: string) => void;
  fetchBody?: (messageId: string) => Promise<string | null>;
  now?: Date;
}

export interface CommitmentSummary {
  candidates: number;
  bodiesFetched: number;
  extracted: number;
}

export async function extractCommitments(
  store: ContextStore,
  deps: CommitmentDeps
): Promise<CommitmentSummary> {
  const now = deps.now ?? new Date();
  const fetchBody =
    deps.fetchBody ??
    (async (id: string) => {
      const body = await runJxa(buildSentBodyScript(id), 60_000);
      return body || null;
    });
  const sinceIso = new Date(now.getTime() - CANDIDATE_DAYS * 86_400_000).toISOString();
  const candidates = store
    .sentMessagesSince(sinceIso, MAX_CANDIDATES * 2)
    .filter((m) => !store.hasCommitmentsFor(m.messageId))
    .slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) {
    return { candidates: 0, bodiesFetched: 0, extracted: 0 };
  }

  const bodies: Array<{ messageId: string; subject: string | null; body: string }> = [];
  for (const c of candidates) {
    try {
      const body = await fetchBody(c.messageId);
      if (body) bodies.push({ messageId: c.messageId, subject: c.subject, body });
    } catch {
      // A message that can't be fetched is skipped, not guessed about.
    }
  }
  if (bodies.length === 0) {
    return { candidates: candidates.length, bodiesFetched: 0, extracted: 0 };
  }

  const prompt = [
    `The fenced data below contains emails the user SENT. Extract concrete`,
    `commitments the user made ("I'll send X by Friday", "I will review Y").`,
    `Reply with ONLY a JSON array: [{"messageId": "...", "text": "...", "due":`,
    `"ISO date or null"}]. Use messageId values from the data verbatim. If there`,
    `are no commitments, reply [].`,
    ``,
    fence("sent-mail-bodies", JSON.stringify(bodies, null, 1)),
  ].join("\n");

  const reply = await deps.provider.complete(prompt);
  const parsed = ExtractedSchema.safeParse(extractJsonArray(reply));
  if (!parsed.success) {
    throw new Error(`model reply did not validate: ${parsed.error.issues[0]?.message}`);
  }
  const validIds = new Set(bodies.map((b) => b.messageId));
  let extracted = 0;
  for (const c of parsed.data) {
    if (!validIds.has(c.messageId)) continue; // the model may not invent pointers
    const id = createHash("sha256")
      .update(`${c.messageId}:${c.text}`)
      .digest("hex")
      .slice(0, 16);
    if (
      store.addCommitment({
        id,
        messageId: c.messageId,
        text: c.text,
        due: c.due ?? null,
        provider: deps.provider.name,
      })
    ) {
      extracted += 1;
    }
  }
  deps.log(`commitments: ${extracted} extracted from ${bodies.length} sent message(s)`);
  return { candidates: candidates.length, bodiesFetched: bodies.length, extracted };
}
