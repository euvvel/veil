// Workers AI only ranks and explains. It receives a numbered list of verified-ID candidates and must answer
// in JSON (json_schema mode) with indices into that list; anything else is discarded. If the model is
// unavailable or answers badly, a plain heuristic order with template reasons is used instead.

import type { Candidate, Feed } from "./pick.ts";

// Probed live with the exact request below (2026-10-12): llama-3.1-8b-instruct was deprecated on 2026-05-30
// (AiError 5028) although the JSON-mode page still lists it. llama-3.3-70b fp8-fast answered valid JSON in 2.3 s
// for ~24 neurons per 5 candidates; llama-4-scout is the backup. gemma-4, glm-4.7 and mistral-small did not
// return usable JSON within the token limit.
export const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct"] as const;

export interface Pick {
  c: Candidate;
  reason: string;
}

const MAX_REASON = 120;

const FEED_BRIEF: Record<Feed, string> = {
  like: "records by artists similar to what the listener keeps",
  same: "records by artists the listener already has, that they do not have yet",
  deep: "quieter, less-known records near the listener's taste",
  weekly: "a varied weekly selection across all of the above",
  hole: "a walk outward through similar artists",
};

export function fallback(cands: Candidate[], n: number): Pick[] {
  return [...cands]
    .sort((a, b) => b.base - a.base)
    .slice(0, n)
    .map((c) => ({ c, reason: templateReason(c) }));
}

export function templateReason(c: Candidate): string {
  const f = c.facts;
  const near = /similar to ([^(]+?) \(/.exec(f)?.[1] ?? /near (.+)$/.exec(f)?.[1];
  if (c.feed === "same") return `More from ${c.artist}, whose tracks you keep.`;
  if (c.feed === "deep") return `A quieter ${c.kind.toLowerCase()} by ${c.artist}${near ? `, near ${near.trim()}` : ""}.`;
  return `${c.artist} sits close to ${near?.trim() ?? "what you keep"}.`;
}

/** Strip anything that is not a plain one-liner; cap the length. */
export function cleanReason(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (t.length < 8) return null;
  return t.length > MAX_REASON ? `${t.slice(0, MAX_REASON - 1).trimEnd()}…` : t;
}

/** Validate a model answer against the candidate list. Exported for tests. */
export function acceptPicks(answer: unknown, cands: Candidate[], n: number): Pick[] {
  const picks = (answer as { picks?: unknown })?.picks;
  if (!Array.isArray(picks)) return [];
  const out: Pick[] = [];
  const seen = new Set<number>();
  for (const p of picks) {
    const i = (p as { i?: unknown })?.i;
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= cands.length || seen.has(i)) continue;
    seen.add(i);
    out.push({ c: cands[i]!, reason: cleanReason((p as { reason?: unknown }).reason) ?? templateReason(cands[i]!) });
    if (out.length >= n) break;
  }
  return out;
}

/** Models answer as `{ response }` (object or JSON string) or OpenAI-style `choices[0].message.content`. */
export function answerBody(res: unknown): unknown {
  const r = res as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  const body = r?.response ?? r?.choices?.[0]?.message?.content;
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

const SYSTEM =
  "You rank music suggestions for one listener. Use ONLY the numbered candidates given; never add others. " +
  "Prefer variety (different artists) and records that fit the facts. For each pick write one short reason, " +
  `addressed to the listener as "you" (at most ${MAX_REASON} characters), using only the facts given. ` +
  "Do not invent facts, dates, genres, members or names.";

export async function rank(ai: Ai | undefined, feed: Feed, cands: Candidate[], n: number): Promise<{ picks: Pick[]; by: "ai" | "plain" }> {
  if (!cands.length) return { picks: [], by: "plain" };
  if (!ai) return { picks: fallback(cands, n), by: "plain" };
  const list = cands.map((c, i) => `${i}. ${c.artist} — ${c.title}${c.year ? ` (${c.year})` : ""} [${c.kind}] · ${c.facts}`).join("\n");
  for (const model of MODELS) {
    try {
      const res = await ai.run(model as Parameters<Ai["run"]>[0], {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Feed: ${FEED_BRIEF[feed]}. Pick up to ${n}, best first.\n\n${list}` },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            type: "object",
            properties: {
              picks: {
                type: "array",
                items: { type: "object", properties: { i: { type: "integer" }, reason: { type: "string" } }, required: ["i", "reason"] },
              },
            },
            required: ["picks"],
          },
        },
        max_tokens: 1200,
      } as never);
      const picks = acceptPicks(answerBody(res), cands, n);
      console.log(JSON.stringify({ at: "ai", feed, model, candidates: cands.length, picks: picks.length }));
      if (picks.length) {
        // The model's picks lead; the plain order fills the rest (never all-or-nothing).
        const taken = new Set(picks.map((p) => p.c.mbid));
        return { picks: [...picks, ...fallback(cands.filter((c) => !taken.has(c.mbid)), n - picks.length)], by: "ai" };
      }
    } catch (e) {
      console.log(JSON.stringify({ at: "ai", feed, model, candidates: cands.length, error: String(e).slice(0, 300) }));
    }
  }
  return { picks: fallback(cands, n), by: "plain" };
}
