// veil front door. Routes: /tg/webhook (bot), /hub/runner (runner WS), /hub/app + /api/* (mini app).
// Anything unauthenticated gets a 404, so the Worker looks like nothing is there.

import { Hono } from "hono";
import { handleUpdate, type TgUpdate } from "./bot.ts";
import { safeEqual } from "./crypto.ts";
import { hub, type Env } from "./env.ts";
import { validateInitData } from "./initdata.ts";
import { activeMember, memberKey, type Member } from "./members.ts";
import type { Fmt } from "./protocol.ts";
import type { View } from "./rank.ts";
import { tgCall } from "./telegram.ts";

export { Hub } from "./hub.ts";

const INIT_DATA_MAX_AGE_S = 24 * 3600;

type Ctx = { Bindings: Env; Variables: { member: Member; userId: number } };
const app = new Hono<Ctx>();

const notFound = () => new Response("Not found", { status: 404 });

app.post("/tg/webhook", async (c) => {
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!safeEqual(secret, c.env.WEBHOOK_SECRET)) return notFound();
  const update = await c.req.json<TgUpdate>();
  const res = await handleUpdate(c.env, update, (p) => c.executionCtx.waitUntil(p));
  if (c.env.REPLY_MODE === "webhook") return res;

  // Webhook-response replies give no delivery result, so send explicitly and log the outcome (no ids).
  const text = await res.text();
  if (text) {
    const { method, ...body } = JSON.parse(text) as { method: string };
    const r = await tgCall(c.env.VEIL_BOT_TOKEN, method, body);
    console.log(JSON.stringify({ at: "reply", method, ok: r.ok, error: r.ok ? undefined : r.description }));
  }
  return new Response(null, { status: 200 });
});

app.get("/hub/runner", async (c) => {
  const auth = c.req.header("Authorization") ?? "";
  if (c.req.header("Upgrade") !== "websocket" || !safeEqual(auth, `Bearer ${c.env.RUNNER_SECRET}`)) return notFound();
  return hub(c.env).fetch(new Request("https://hub/runner", c.req.raw));
});

/** Mini app auth: `Authorization: tma <initData>`, or `?tma=` for WebSockets (browsers cannot set WS headers).
 *  In a private chat with the bot, the chat id equals the user id, so it doubles as the delivery chat. */
async function memberFrom(env: Env, initData: string | undefined): Promise<{ member: Member; userId: number } | null> {
  const r = await validateInitData(initData, env.VEIL_BOT_TOKEN, INIT_DATA_MAX_AGE_S, Math.floor(Date.now() / 1000));
  if (!r.ok) return null;
  const member = await activeMember(env.DB, await memberKey(env.MEMBER_HMAC_KEY, r.user.id));
  return member ? { member, userId: r.user.id } : null;
}

app.get("/hub/app", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return notFound();
  const who = await memberFrom(c.env, c.req.query("tma"));
  if (!who) return notFound();
  const req = new Request("https://hub/app", c.req.raw);
  req.headers.set("X-Veil-Member", who.member.member_key);
  return hub(c.env).fetch(req);
});

app.use("/api/*", async (c, next) => {
  const auth = c.req.header("Authorization") ?? "";
  const who = await memberFrom(c.env, auth.startsWith("tma ") ? auth.slice(4) : undefined);
  if (!who) return notFound();
  c.set("member", who.member);
  c.set("userId", who.userId);
  await next();
});

const FORMATS: Fmt[] = ["flac", "mp3", "any"];
const VIEWS: View[] = ["t", "a"];
const fmtOf = (v: unknown) => (FORMATS.includes(v as Fmt) ? (v as Fmt) : undefined);
const viewOf = (v: unknown) => (VIEWS.includes(v as View) ? (v as View) : undefined);

app.get("/api/me", async (c) => {
  const m = c.get("member");
  const s = await hub(c.env).getSession();
  return c.json({ role: m.role, prefs: JSON.parse(m.prefs), session: { state: s.state } });
});

app.patch("/api/prefs", async (c) => {
  const m = c.get("member");
  const body = await c.req.json<{ format?: string; max_mb?: number; fallback?: boolean }>();
  const prefs = JSON.parse(m.prefs) as { format: Fmt; max_mb: number; fallback: boolean };
  if (fmtOf(body.format)) prefs.format = body.format as Fmt;
  if (typeof body.max_mb === "number" && body.max_mb >= 10 && body.max_mb <= 2000) prefs.max_mb = Math.round(body.max_mb);
  if (typeof body.fallback === "boolean") prefs.fallback = body.fallback;
  await c.env.DB.prepare("UPDATE members SET prefs = ? WHERE member_key = ?").bind(JSON.stringify(prefs), m.member_key).run();
  return c.json(prefs);
});

app.post("/api/search", async (c) => {
  const body = await c.req.json<{ query?: string; fmt?: string }>();
  const query = (body.query ?? "").trim().slice(0, 200);
  if (!query) return c.json({ error: "empty" }, 400);
  const m = c.get("member");
  const fmt = fmtOf(body.fmt) ?? (JSON.parse(m.prefs) as { format: Fmt }).format;
  return c.json(await hub(c.env).search(m, c.get("userId"), query, fmt, "app"));
});

app.get("/api/search/:sid", async (c) => {
  const v = await hub(c.env).appView(c.get("member"), c.req.param("sid"), viewOf(c.req.query("view")), fmtOf(c.req.query("fmt")));
  return c.json(v);
});

app.post("/api/cross", async (c) => {
  const body = await c.req.json<{ sid?: string; index?: number }>();
  if (typeof body.sid !== "string" || typeof body.index !== "number") return c.json({ ok: false, error: "bad request" }, 400);
  return c.json(await hub(c.env).appCross(c.get("member"), c.get("userId"), body.sid, body.index));
});

app.get("/api/crossings", async (c) => {
  const m = c.get("member");
  const active = await hub(c.env).appCrossings(m);
  const { results } = await c.env.DB.prepare(
    `SELECT j.name, j.format, j.updated_at AS at, t.artist, t.title, t.album FROM jobs j LEFT JOIN tracks t ON t.id = j.track_id
     WHERE j.user_id = ? AND j.state = 'delivered' ORDER BY j.updated_at DESC LIMIT 30`,
  ).bind(m.member_key).all();
  return c.json({ active, history: results });
});

app.get("/api/direct/:gid", async (c) => c.json(await hub(c.env).appDirect(c.get("member"), c.req.param("gid"))));

app.post("/api/direct/release", async (c) => {
  const body = await c.req.json<{ job?: string }>();
  return c.json({ ok: typeof body.job === "string" && (await hub(c.env).appRelease(c.get("member"), body.job)) });
});

app.all("/api/*", notFound);
app.all("/tg/*", notFound);
app.all("/hub/*", notFound);

export default app satisfies ExportedHandler<Env>;
