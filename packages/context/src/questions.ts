import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { fence } from "@cortland/governed";
import type { ModelProvider } from "./model.js";
import type { ContextStore } from "./store.js";

/**
 * Standing questions (Q15): the user's own words, applied continuously.
 * standing-questions.yaml lives in the Briefings folder — phone-editable,
 * travels with the output it shapes.
 */

export const StandingQuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_-]+$/),
        ask: z.string().min(3),
        people: z.array(z.string()).default([]),
        keywords: z.array(z.string()).default([]),
      })
    )
    .min(1),
});

export type StandingQuestion = z.infer<typeof StandingQuestionsSchema>["questions"][number];

export function parseStandingQuestions(text: string): StandingQuestion[] {
  const raw: unknown = parseYaml(text);
  const result = StandingQuestionsSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `invalid standing-questions.yaml at "${issue.path.join(".")}": ${issue.message}`
    );
  }
  return result.data.questions;
}

export interface QuestionAnswer {
  id: string;
  ask: string;
  /** Layer 0: pointer candidates found deterministically. Always present. */
  candidates: Array<{ messageId: string; subject: string | null; date: string | null }>;
  /** Layer 1: model-written answer. Absent when no provider is configured. */
  answer?: string;
  provider?: string;
  /** A failing provider degrades to candidates — recorded, never fatal. */
  providerError?: string;
}

const LOOKBACK_DAYS = 7;

/**
 * Layer 0 gathers candidates from hints (people, keywords) via the store;
 * Layer 1 (optional) writes a cited answer over ONLY that fenced candidate
 * data. The model sees headers, never bodies, and its output is data.
 */
export async function answerStandingQuestions(
  store: ContextStore,
  questions: StandingQuestion[],
  provider: ModelProvider | null,
  now: Date = new Date()
): Promise<QuestionAnswer[]> {
  const sinceIso = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const answers: QuestionAnswer[] = [];
  for (const q of questions) {
    const seen = new Set<string>();
    const candidates: QuestionAnswer["candidates"] = [];
    const add = (rows: QuestionAnswer["candidates"]) => {
      for (const row of rows) {
        if (!seen.has(row.messageId) && candidates.length < 10) {
          seen.add(row.messageId);
          candidates.push(row);
        }
      }
    };
    for (const hint of q.people) {
      for (const person of store.findPeople(hint)) {
        add(
          person.recentMessages
            .filter((m) => (m.date ?? "") >= sinceIso)
            .map((m) => ({ messageId: m.messageId, subject: m.subject, date: m.date }))
        );
      }
    }
    for (const keyword of q.keywords) {
      add(store.searchMessages(keyword, sinceIso, 5));
    }
    if (q.people.length === 0 && q.keywords.length === 0) {
      // No hints: recent activity is the candidate pool.
      add(
        store
          .changesSince(sinceIso)
          .topSenders.flatMap((s) =>
            s.citations.map((c) => ({ messageId: c, subject: null, date: null }))
          )
      );
    }

    const entry: QuestionAnswer = { id: q.id, ask: q.ask, candidates };
    if (provider && candidates.length > 0) {
      const prompt = [
        `Answer this standing question from the fenced mail-header data below.`,
        `Rules: use ONLY the fenced data; cite messageIds in backticks for every`,
        `claim; if the data is insufficient, say exactly that. 3 sentences max.`,
        ``,
        `Question: ${q.ask}`,
        ``,
        fence("standing-question-candidates", JSON.stringify(candidates, null, 1)),
      ].join("\n");
      try {
        entry.answer = await provider.complete(prompt);
        entry.provider = provider.name;
      } catch (err) {
        entry.providerError = String(err).slice(0, 200);
      }
    }
    answers.push(entry);
  }
  return answers;
}
