// veil bot webhook. Members get answers; everyone else gets silence (an empty 200).
// Handlers return the reply as a `{ method, ...params }` response; index.ts sends it with an explicit
// Bot API call and logs the outcome (REPLY_MODE=webhook keeps it on the webhook response for local tests).

import type { Env } from "./env.ts";
import { hub, seer } from "./env.ts";
import { helpText, MENU_VERSION, menuFor } from "./help.ts";
import * as M from "./members.ts";
import type { Fmt } from "./protocol.ts";
import { label } from "./words.ts";

interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; is_bot?: boolean };
  text?: string;
}
interface TgCallback {
  id: string;
  from: { id: number };
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

const silence = () => new Response(null, { status: 200 });

const reply = (method: string, body: Record<string, unknown>) =>
  Response.json({ method, ...body }, { headers: { "Content-Type": "application/json" } });

const say = (chatId: number, text: string, extra: Record<string, unknown> = {}) =>
  reply("sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true }, ...extra });

export async function tg(env: Env, method: string, body: unknown): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${env.VEIL_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** An inline "Open veil" button, when the mini app URL is configured. */
const openVeil = (env: Env) =>
  env.APP_URL ? { reply_markup: { inline_keyboard: [[{ text: "Open veil", web_app: { url: env.APP_URL } }]] } } : {};

/** Commands and the mini app button are scoped to member chats only, so strangers see nothing. */
const setMenu = (env: Env, chatId: number, role: M.Role) =>
  Promise.all([
    tg(env, "setMyCommands", { commands: menuFor(role), scope: { type: "chat", chat_id: chatId } }),
    env.APP_URL
      ? tg(env, "setChatMenuButton", { chat_id: chatId, menu_button: { type: "web_app", text: "veil", web_app: { url: env.APP_URL } } })
      : Promise.resolve(),
  ]);

const clearMenu = (env: Env, chatId: number) =>
  Promise.all([
    tg(env, "deleteMyCommands", { scope: { type: "chat", chat_id: chatId } }),
    tg(env, "setChatMenuButton", { chat_id: chatId, menu_button: { type: "default" } }),
  ]);

/** Refresh a member's menu once after the command set changes (no need to /start again). */
async function refreshMenu(env: Env, member: M.Member, chatId: number, waitUntil: (p: Promise<unknown>) => void) {
  const prefs = JSON.parse(member.prefs) as Record<string, unknown>;
  if (prefs.menu_v === MENU_VERSION) return;
  waitUntil(setMenu(env, chatId, member.role));
  await env.DB.prepare("UPDATE members SET prefs = ? WHERE member_key = ?")
    .bind(JSON.stringify({ ...prefs, menu_v: MENU_VERSION }), member.member_key)
    .run();
}

const FORMATS: Fmt[] = ["flac", "mp3", "any"];

async function seek(env: Env, member: M.Member, chatId: number, arg: string): Promise<Response> {
  let words = arg.trim();
  let fmt = (JSON.parse(member.prefs) as { format?: Fmt }).format ?? "flac";
  const first = words.split(/\s+/, 1)[0]?.toLowerCase() as Fmt;
  if (FORMATS.includes(first)) {
    fmt = first;
    words = words.slice(first.length).trim();
  }
  if (!words) {
    const last = await env.DB.prepare("SELECT query, format_filter FROM searches WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(member.member_key)
      .first<{ query: string; format_filter: Fmt }>();
    if (!last) return say(chatId, "Seek what?\n/seek [flac|mp3|any] artist title");
    words = last.query;
    if (!FORMATS.includes(first)) fmt = last.format_filter;
  }
  const { state } = await hub(env).search(member, chatId, words.slice(0, 200), fmt);
  return say(
    chatId,
    state === "ready"
      ? `Listening beyond · “${words}”\nResults in about fifteen seconds.`
      : `${label(state === "offline" ? "booting" : state)}\nI'll seek “${words}” as soon as the veil opens (under a minute).`,
  );
}

async function beyond(env: Env, member: M.Member, chatId: number): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, feed, artist, title, year, reason FROM suggestions
     WHERE user_id = ? AND outcome IS NULL AND feed IN ('weekly', 'like') ORDER BY feed = 'weekly' DESC, rank LIMIT 6`,
  ).bind(member.member_key).all<{ id: string; feed: string; artist: string; title: string; year: number | null; reason: string }>();
  if (!results.length) {
    await seer(env, member.member_key).kick(member.member_key, 0);
    return say(chatId, "Beyond is still veiled. Let a few things cross; I am gathering what lies near them.", openVeil(env));
  }
  const lines = results.map((r, i) => `${i + 1}. ${r.artist} — ${r.title}${r.year ? ` (${r.year})` : ""}\n    ${r.reason}`);
  const buttons = results.map((r, i) => ({ text: `${i + 1}`, callback_data: `b:${r.id}` }));
  return say(chatId, `What lies beyond\n\n${lines.join("\n")}\n\nTap a number to seek it.`, {
    reply_markup: { inline_keyboard: [buttons.slice(0, 3), buttons.slice(3, 6)].filter((r) => r.length) },
  });
}

/** Seek a suggestion: exact artist and title, remembered as a tap. */
export async function seekSuggestion(env: Env, member: M.Member, chatId: number, id: string, origin: "bot" | "app") {
  const s = await env.DB.prepare("SELECT id, artist, title FROM suggestions WHERE id = ? AND user_id = ?").bind(id, member.member_key)
    .first<{ id: string; artist: string; title: string }>();
  if (!s) return null;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE suggestions SET outcome = 'tapped' WHERE id = ? AND outcome IS NULL").bind(id),
    env.DB.prepare("INSERT INTO events (user_id, type, ref, feed, created_at) VALUES (?, 'tap', ?, 'beyond', ?)").bind(member.member_key, id, now),
  ]);
  const fmt = (JSON.parse(member.prefs) as { format?: Fmt }).format ?? "flac";
  const query = `${s.artist} ${s.title}`.replace(/\(.*?\)|\[.*?\]/g, " ").replace(/\s+/g, " ").trim();
  const r = await hub(env).search(member, chatId, query, fmt, origin, id);
  return { ...r, query };
}

async function history(env: Env, member: M.Member, chatId: number): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT j.name, j.format, t.artist, t.title FROM jobs j LEFT JOIN tracks t ON t.id = j.track_id
     WHERE j.user_id = ? AND j.state = 'delivered' ORDER BY j.updated_at DESC LIMIT 10`,
  ).bind(member.member_key).all<{ name: string; format: string; artist: string | null; title: string | null }>();
  if (!results.length) return say(chatId, "Nothing has crossed yet. Try /seek.");
  const lines = results.map((r, i) => `${i + 1}. ${r.artist && r.title ? `${r.artist} – ${r.title}` : r.name} · ${(r.format ?? "").toUpperCase()}`);
  return say(chatId, `Last crossings\n\n${lines.join("\n")}`, openVeil(env));
}

export async function handleUpdate(env: Env, update: TgUpdate, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  const now = Date.now();

  if (update.callback_query) {
    const cq = update.callback_query;
    console.log(JSON.stringify({ at: "update", kind: "callback", op: (cq.data ?? "").split(":")[0] }));
    const me = await M.activeMember(env.DB, await M.memberKey(env.MEMBER_HMAC_KEY, cq.from.id));
    if (!me) return silence();
    if (cq.data?.startsWith("s:") && cq.message) {
      const act = await hub(env).searchCallback(me, cq.message.chat.id, cq.message.message_id, cq.id, cq.data);
      for (const call of act.also ?? []) {
        const { method, ...body } = JSON.parse(call) as { method: string };
        waitUntil(tg(env, method, body));
      }
      if (!act.reply) return silence();
      const { method, ...body } = JSON.parse(act.reply) as { method: string };
      return reply(method, body);
    }
    if (cq.data?.startsWith("b:") && cq.message) {
      const r = await seekSuggestion(env, me, cq.message.chat.id, cq.data.slice(2), "bot");
      if (!r) return reply("answerCallbackQuery", { callback_query_id: cq.id, text: "That suggestion has faded." });
      waitUntil(tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Seeking it." }));
      return say(cq.message.chat.id, r.state === "ready" ? `Listening beyond · “${r.query}”` : `${label("booting")}\nI'll seek “${r.query}” as soon as the veil opens.`);
    }
    if (me.role !== "admin" || !cq.data?.startsWith("rv:")) return silence();
    const ok = await M.revoke(env.DB, cq.data.slice(3));
    return reply("answerCallbackQuery", { callback_query_id: cq.id, text: ok ? "Revoked. The veil forgets them." : "Nothing to revoke." });
  }

  const msg = update.message;
  if (!msg?.text || !msg.from || msg.from.is_bot || msg.chat.type !== "private") return silence();
  const chatId = msg.chat.id;
  const key = await M.memberKey(env.MEMBER_HMAC_KEY, msg.from.id);
  const text = msg.text.trim();
  const cmdRaw = text.split(/\s+/, 1)[0] ?? "";
  const rest = text.slice(cmdRaw.length).trim();
  const arg = rest.split(/\s+/, 1)[0] ?? "";
  const cmd = cmdRaw.replace(/@.*$/, "").toLowerCase();
  console.log(JSON.stringify({ at: "update", kind: "message", cmd: cmd.startsWith("/") ? cmd.slice(0, 16) : "(text)" }));

  const member = await M.activeMember(env.DB, key);

  if (cmd === "/start" && !member) {
    if (await M.claim(env.DB, env.CLAIM_SECRET, arg, key, now)) {
      waitUntil(setMenu(env, chatId, "admin"));
      return say(chatId, `The veil knows you now. You are its keeper.\n\n${helpText("admin", env.COURIER_USERNAME)}`, openVeil(env));
    }
    if (await M.redeemInvite(env.DB, arg, key, now)) {
      waitUntil(setMenu(env, chatId, "member"));
      return say(
        chatId,
        `You were let through. The veil knows you now.\n\nOne thing first: open @${env.COURIER_USERNAME} and press Start, so it may bring files to you.\n\n${helpText("member", env.COURIER_USERNAME)}`,
        openVeil(env),
      );
    }
    return silence();
  }

  if (!member) return silence();
  await refreshMenu(env, member, chatId, waitUntil);

  switch (cmd) {
    case "/start":
      waitUntil(setMenu(env, chatId, member.role));
      return say(chatId, "You are known here. Seek with /seek, or open veil.", openVeil(env));

    case "/help":
      return say(chatId, helpText(member.role, env.COURIER_USERNAME), openVeil(env));

    case "/s":
    case "/seek":
      return seek(env, member, chatId, rest);

    case "/history":
      return history(env, member, chatId);

    case "/beyond":
      return beyond(env, member, chatId);

    case "/status": {
      const s = await hub(env).getSession();
      return say(chatId, label(s.state));
    }

    case "/sleep": {
      if (member.role !== "admin") return silence();
      return say(chatId, (await hub(env).sleep()) ? label("draining") : label("offline"));
    }

    case "/wake": {
      if (member.role !== "admin") return silence();
      const r = await hub(env).wake(chatId);
      if (r.dispatched) return say(chatId, `${label("booting")}\nI'll tell you when the veil is open.`);
      if (r.dispatchStatus) return say(chatId, `The veil would not part · dispatch failed (${r.dispatchStatus})`);
      return say(chatId, label(r.session.state));
    }

    case "/invite": {
      if (member.role !== "admin") return silence();
      const code = await M.createInvite(env.DB, member.member_key, now);
      return say(
        chatId,
        `A single crossing, valid for 24 hours. Send it only to someone you trust:\n\nhttps://t.me/${env.BOT_USERNAME}?start=${code}`,
      );
    }

    case "/members": {
      if (member.role !== "admin") return silence();
      const all = await M.listMembers(env.DB);
      const lines = all.map((m) => `• ${m.role} · ${m.member_key.slice(0, 6)}${m.member_key === key ? " (you)" : ""}`);
      const buttons = all
        .filter((m) => m.role === "member")
        .map((m) => [{ text: `Revoke ${m.member_key.slice(0, 6)}`, callback_data: `rv:${m.member_key.slice(0, 16)}` }]);
      return say(chatId, `Who may cross\n\n${lines.join("\n")}`, buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {});
    }

    case "/leave": {
      if (member.role === "admin") return say(chatId, "The keeper cannot leave.");
      await M.revoke(env.DB, member.member_key.slice(0, 16));
      waitUntil(clearMenu(env, chatId));
      return say(chatId, "The veil falls back into place. You are forgotten.");
    }

    default:
      // Plain words seek; an unknown /command gets a pointer to /help.
      if (!cmd.startsWith("/")) return seek(env, member, chatId, text);
      return say(chatId, "Unknown command. /help lists what veil understands.");
  }
}
