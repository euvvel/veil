// Status line for a crossing (one tap = one group of jobs). Vocabulary from docs/DESIGN.md.

import type { JobState } from "./protocol.ts";

export interface JobProgress {
  state: JobState;
  pct?: number;
  place?: number;
  error?: string;
}

const ERRORS: Record<string, string> = {
  connect: "the peer could not be reached",
  timeout: "the peer went quiet",
  rejected: "the peer refused",
  queue: "the peer's queue refused",
  not_shared: "the file is no longer shared",
  too_large: "too large for now",
  not_found: "the file vanished on arrival",
  upload: "Telegram refused the file",
  cancelled: "cancelled",
  gave_up: "gave up after three openings",
  unclaimed: "not received in time",
};

export const errorText = (e?: string) => ERRORS[e ?? ""] ?? "unknown";

function single(p: JobProgress): string {
  switch (p.state) {
    case "pending":
      return "Waiting for the veil";
    case "queued":
      return p.place ? `At the threshold · ${p.place} ahead` : "At the threshold";
    case "downloading":
      return `Crossing over · ${Math.round(p.pct ?? 0)}%`;
    case "uploading":
      return "Arriving";
    case "awaiting":
      return "At the veil's edge · open veil to receive";
    case "delivered":
      return "Crossed";
    case "failed":
      return `Lost in the veil · ${errorText(p.error)}`;
  }
}

const ORDER: JobState[] = ["awaiting", "downloading", "uploading", "queued", "pending"];

export function crossingText(name: string, jobs: JobProgress[]): string {
  if (jobs.length === 1) return `${single(jobs[0]!)} · ${name}`;
  const done = jobs.filter((j) => j.state === "delivered").length;
  const lost = jobs.filter((j) => j.state === "failed").length;
  const active = ORDER.map((s) => jobs.find((j) => j.state === s)).find(Boolean);
  const head = active ? single(active) : done ? "Crossed" : "Lost in the veil";
  return `${head} · ${done}/${jobs.length} crossed${lost ? ` · ${lost} lost` : ""} · ${name}`;
}

export const isTerminal = (s: JobState) => s === "delivered" || s === "failed";
