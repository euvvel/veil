// Workers AI only ranks and explains. It receives a numbered list of verified-ID candidates and must answer
// in JSON (json_schema mode) with indices into that list; anything else is discarded. If the model is
// unavailable or answers badly, a plain heuristic order with template reasons is used instead.

import type { Candidate, Feed } from "./pick.ts";

export const MODEL = "@cf/meta/llama-3.1-8b-instruct"; // supports JSON mode (developers.cloudflare.com/workers-ai/features/json-mode)

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

export async function rank(ai: Ai | undefined, feed: Feed, cands: Candidate[], n: number): Promise<{ picks: Pick[]; by: "ai" | "plain" }> {
  if (!cands.length) return { picks: [], by: "plain" };
  if (!ai) return { picks: fallback(cands, n), by: "plain" };
  const list = cands.map((c, i) => `${i}. ${c.artist} — ${c.title}${c.year ? ` (${c.year})` : ""} [${c.kind}] · ${c.facts}`).join("\n");
  try {
    const res = (await ai.run(MODEL as Parameters<Ai["run"]>[0], {
      messages: [
        {
          role: "system",
          content:
            "You rank music suggestions for one listener. Use ONLY the numbered candidates given; never add others. " +
            "Prefer variety (different artists) and records that fit the facts. For each pick write one short, concrete reason " +
            `(at most ${MAX_REASON} characters) that uses only the facts given. Do not invent facts, dates, genres or names.`,
        },
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
      max_tokens: 900,
    } as never)) as { response?: unknown };
    const body = typeof res.response === "string" ? JSON.parse(res.response) : res.response;
    const picks = acceptPicks(body, cands, n);
    if (picks.length >= Math.min(n, cands.length) / 2) return { picks, by: "ai" };
  } catch {
    // fall through to the plain order
  }
  return { picks: fallback(cands, n), by: "plain" };
}
