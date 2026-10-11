// Invite-only membership (docs/DECISIONS.md D7). Members are stored as HMACs of their Telegram id.

import { hmacHex, randomHex, safeEqual, sha256Hex } from "./crypto.ts";

export type Role = "admin" | "member";

export interface Member {
  member_key: string;
  role: Role;
  status: "active" | "revoked";
  alias: string | null;
  prefs: string;
  created_at: number;
}

export const INVITE_TTL_MS = 24 * 3600_000;
export const CLAIM_PREFIX = "c_";
export const INVITE_PREFIX = "i_";

export const memberKey = (hmacKey: string, telegramId: number) => hmacHex(hmacKey, `tg:${telegramId}`);

export async function activeMember(db: D1Database, key: string): Promise<Member | null> {
  return db.prepare("SELECT * FROM members WHERE member_key = ? AND status = 'active'").bind(key).first<Member>();
}

/** The first claim makes the admin. It works only while the members table is empty. */
export async function claim(db: D1Database, claimSecret: string, code: string, key: string, now: number): Promise<boolean> {
  if (!safeEqual(code, CLAIM_PREFIX + claimSecret)) return false;
  const res = await db
    .prepare(
      "INSERT INTO members (member_key, role, created_at) SELECT ?, 'admin', ? WHERE NOT EXISTS (SELECT 1 FROM members)",
    )
    .bind(key, now)
    .run();
  return res.meta.changes === 1;
}

export async function createInvite(db: D1Database, createdBy: string, now: number): Promise<string> {
  const code = INVITE_PREFIX + randomHex(16);
  await db
    .prepare("INSERT INTO invites (code_hash, created_by, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(code), createdBy, now + INVITE_TTL_MS)
    .run();
  return code;
}

/** Spends a single-use invite and (re)activates the member. False if invalid, used or expired. */
export async function redeemInvite(db: D1Database, code: string, key: string, now: number): Promise<boolean> {
  if (!code.startsWith(INVITE_PREFIX)) return false;
  const spent = await db
    .prepare("UPDATE invites SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(now, key, await sha256Hex(code), now)
    .run();
  if (spent.meta.changes !== 1) return false;
  await db
    .prepare(
      `INSERT INTO members (member_key, role, created_at) VALUES (?, 'member', ?)
       ON CONFLICT(member_key) DO UPDATE SET status = 'active'`,
    )
    .bind(key, now)
    .run();
  return true;
}

export async function listMembers(db: D1Database): Promise<Member[]> {
  const { results } = await db.prepare("SELECT * FROM members WHERE status = 'active' ORDER BY created_at").all<Member>();
  return results;
}

/** Revoke by key prefix (callback data is limited to 64 bytes). Never revokes an admin. */
export async function revoke(db: D1Database, keyPrefix: string): Promise<boolean> {
  if (!/^[0-9a-f]{16}$/.test(keyPrefix)) return false;
  const res = await db
    .prepare("UPDATE members SET status = 'revoked' WHERE substr(member_key, 1, 16) = ? AND role = 'member'")
    .bind(keyPrefix)
    .run();
  return res.meta.changes === 1;
}
