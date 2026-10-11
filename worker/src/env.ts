import type { Hub } from "./hub.ts";

export interface Env {
  DB: D1Database;
  HUB: DurableObjectNamespace<Hub>;
  ASSETS: Fetcher;

  BOT_USERNAME: string;
  GH_REPO: string;
  GH_WORKFLOW: string;
  GH_REF: string;
  /** "api" (default): replies are sent with an explicit Bot API call and the result is logged.
   *  "webhook": replies ride on the webhook response (local tests read them there). */
  REPLY_MODE?: string;

  VEIL_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  RUNNER_SECRET: string;
  MEMBER_HMAC_KEY: string;
  PEER_HMAC_KEY: string;
  CLAIM_SECRET: string;
  GH_DISPATCH_TOKEN: string;
}

export const hub = (env: Env) => env.HUB.get(env.HUB.idFromName("hub"));
