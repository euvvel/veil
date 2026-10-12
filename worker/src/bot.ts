// veil bot webhook. Members get answers; everyone else gets silence (an empty 200).
// Replies ride on the webhook response (Bot API: "reply directly to a webhook"),
// so a reply costs no extra subrequest.

import type { Env } from "./env.ts";
import { hub } from "./env.ts";
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

const SEEK = { command: "seek", description: "Seek a track: /seek [flac|mp3|any] words (or /s)" };
const HISTORY = { command: "history", description: "Your last crossings" };
const STATUS = { command: "status", description: "Is the veil open?" };

const COMMANDS: Record<M.Role, { command: string; description: string }[]> = {
  admin: [
    SEEK,
    HISTORY,
    STATUS,
    { command: "wake", description: "Part the veil (start the runner)" },
    { command: "sleep", description: "Let the veil fall now" },
    { command: "invite", description: "Let someone through, once" },
    { command: "members", description: "Who may cross" },
  ],
  member: [SEEK, HISTORY, STATUS, { command: "leave", description: "Be forgotten" }],
};

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
    if (!last) return say(chatId, "Seek what? /seek [flac|mp3|any] artist title");
    words = last.query;
    if (!FORMATS.includes(first)) fmt = last.format_filter;
  }
  const { state } = await hub(env).search(member, chatId, words.slice(0, 200), fmt);
  return say(
    chatId,
    state === "ready" ? `Listening beyond · Searching “${words}”…` : `${label(state === "offline" ? "booting" : state)}\nI'll seek “${words}” as soon as the veil opens.`,
  );
}

async function history(env: Env, member: M.Member, chatId: number): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT j.name, j.format, t.artist, t.title FROM jobs j LEFT JOIN tracks t ON t.id = j.track_id
     WHERE j.user_id = ? AND j.state = 'delivered' ORDER BY j.updated_at DESC LIMIT 10`,
  ).bind(member.member_key).all<{ name: string; format: string; artist: string | null; title: string | null }>();
  if (!results.length) return say(chatId, "Nothing has crossed yet.");
  const lines = results.map((r) => `• ${r.artist && r.title ? `${r.artist} – ${r.title}` : r.name} · ${(r.format ?? "").toUpperCase()}`);
  return say(chatId, `Last crossings:\n${lines.join("\n")}`);
}

/** Commands and the mini app button are scoped to member chats only, so strangers see nothing. */
const setCommands = (env: Env, chatId: number, role: M.Role) =>
  Promise.all([
    tg(env, "setMyCommands", { commands: COMMANDS[role], scope: { type: "chat", chat_id: chatId } }),
    env.APP_URL
      ? tg(env, "setChatMenuButton", { chat_id: chatId, menu_button: { type: "web_app", text: "veil", web_app: { url: env.APP_URL } } })
      : Promise.resolve(),
  ]);

const clearCommands = (env: Env, chatId: number) =>
  Promise.all([
    tg(env, "deleteMyCommands", { scope: { type: "chat", chat_id: chatId } }),
    tg(env, "setChatMenuButton", { chat_id: chatId, menu_button: { type: "default" } }),
  ]);

function help(role: M.Role): string {
  return COMMANDS[role].map((c) => `/${c.command} · ${c.description}`).join("\n");
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

  let member = await M.activeMember(env.DB, key);

  if (cmd === "/start" && !member) {
    if (await M.claim(env.DB, env.CLAIM_SECRET, arg, key, now)) {
      waitUntil(setCommands(env, chatId, "admin"));
      return say(chatId, `The veil knows you now. You are its keeper.\n\n${help("admin")}`);
    }
    if (await M.redeemInvite(env.DB, arg, key, now)) {
      waitUntil(setCommands(env, chatId, "member"));
      return say(chatId, `You were let through. The veil knows you now.\n\n${help("member")}`);
    }
    return silence();
  }

  if (!member) return silence();

  switch (cmd) {
    case "/start":
      waitUntil(setCommands(env, chatId, member.role));
      return say(chatId, `You are known here.\n\n${help(member.role)}`);

    case "/status": {
      const s = await hub(env).getSession();
      return say(chatId, label(s.state));
    }

    case "/s":
    case "/seek":
      return seek(env, member, chatId, rest);

    case "/history":
      return history(env, member, chatId);

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
      return say(chatId, `Who may cross:\n${lines.join("\n")}`, buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {});
    }

    case "/leave": {
      if (member.role === "admin") return say(chatId, "The keeper cannot leave.");
      await M.revoke(env.DB, member.member_key.slice(0, 16));
      waitUntil(clearCommands(env, chatId));
      return say(chatId, "The veil falls back into place. You are forgotten.");
    }

    default:
      return silence();
  }
}
