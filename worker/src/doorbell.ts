// Starts the runner with workflow_dispatch.
// Live-checked 2026-10-11: with `return_run_details: true` GitHub answers 200 + workflow_run_id.
// Inputs appear on the public run page, so only non-secret values go there.

import type { Env } from "./env.ts";

export interface DispatchResult {
  ok: boolean;
  status: number;
  runId?: number;
}

export async function dispatchRunner(env: Env, sessionId: string): Promise<DispatchResult> {
  const url = `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "veil-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: env.GH_REF, inputs: { session_id: sessionId }, return_run_details: true }),
  });
  if (!res.ok) return { ok: false, status: res.status };
  const body = res.status === 200 ? ((await res.json()) as { workflow_run_id?: number }) : {};
  return { ok: true, status: res.status, runId: body.workflow_run_id };
}
