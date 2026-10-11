// Telegram Mini App initData validation.
// core.telegram.org/bots/webapps "Validating data received via the Mini App":
//   secret = HMAC_SHA256(key = "WebAppData", msg = bot_token)
//   hash   = hex(HMAC_SHA256(key = secret, msg = data_check_string))
//   data_check_string = all fields except `hash`, sorted by key, "key=value" joined by "\n"
// Excluding `hash` (and keeping `signature`) is our reading of the docs; see LIMITS.md U2.

import { hmac, hmacHex, safeEqual } from "./crypto.ts";

export interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
  language_code?: string;
}

export type InitDataResult =
  | { ok: true; user: TgUser; authDate: number; startParam?: string }
  | { ok: false; reason: "missing" | "bad_hash" | "expired" | "no_user" };

export async function dataCheckString(raw: string): Promise<{ dcs: string; hash: string | null; params: URLSearchParams }> {
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  const dcs = [...params.entries()]
    .filter(([k]) => k !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return { dcs, hash, params };
}

export async function signInitData(fields: Record<string, string>, botToken: string): Promise<string> {
  const params = new URLSearchParams(fields);
  const { dcs } = await dataCheckString(params.toString());
  params.set("hash", await hmacHex(await hmac("WebAppData", botToken), dcs));
  return params.toString();
}

export async function validateInitData(
  raw: string | null | undefined,
  botToken: string,
  maxAgeSec: number,
  nowSec: number,
): Promise<InitDataResult> {
  if (!raw) return { ok: false, reason: "missing" };
  const { dcs, hash, params } = await dataCheckString(raw);
  if (!hash) return { ok: false, reason: "missing" };
  const expected = await hmacHex(await hmac("WebAppData", botToken), dcs);
  if (!safeEqual(expected, hash.toLowerCase())) return { ok: false, reason: "bad_hash" };

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || nowSec - authDate > maxAgeSec) return { ok: false, reason: "expired" };

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "no_user" };
  const user = JSON.parse(userRaw) as TgUser;
  if (typeof user.id !== "number") return { ok: false, reason: "no_user" };
  return { ok: true, user, authDate, startParam: params.get("start_param") ?? undefined };
}
