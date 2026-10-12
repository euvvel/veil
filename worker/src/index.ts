// veil front door. Routes: /tg/webhook (bot), /hub/runner (runner WS), /hub/app + /api/* (mini app).
// Anything unauthenticated gets a 404, so the Worker looks like nothing is there.

import { Hono } from "hono";
import { handleUpdate, seekSuggestion, type TgUpdate } from "./bot.ts";
import { safeEqual } from "./crypto.ts";
import { norm } from "./beyond/pick.ts";
import { hub, seer, type Env } from "./env.ts";
import { validateInitData } from "./initdata.ts";
import { COMMANDS, GUIDE } from "./help.ts";
import { activeMember, memberKey, type Member } from "./members.ts";
import type { Fmt } from "./protocol.ts";
import type { View } from "./rank.ts";
import { tgCall } from "./telegram.ts";

export { Hub } from "./hub.ts";
export { Seer } from "./seer.ts";

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

/** Mini app auth: `Authorization: tma <initData>` (headers are not logged; URLs are).
 *  In a private chat with the bot, the chat id equals the user id, so it doubles as the delivery chat. */
async function memberFrom(env: Env, initData: string | undefined): Promise<{ member: Member; userId: number } | null> {
  const r = await validateInitData(initData, env.VEIL_BOT_TOKEN, INIT_DATA_MAX_AGE_S, Math.floor(Date.now() / 1000));
  if (!r.ok) return null;
  const member = await activeMember(env.DB, await memberKey(env.MEMBER_HMAC_KEY, r.user.id));
  return member ? { member, userId: r.user.id } : null;
}

/** Mini app socket: `?t=<ticket>` from POST /api/ticket. The Hub checks and spends the ticket. */
app.get("/hub/app", async (c) => {
  const t = c.req.query("t") ?? "";
  if (c.req.header("Upgrade") !== "websocket" || !/^[0-9a-f]{32}$/.test(t)) return notFound();
  return hub(c.env).fetch(new Request(`https://hub/app?t=${t}`, c.req.raw));
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

app.post("/api/ticket", async (c) => c.json({ t: await hub(c.env).ticket(c.get("member").member_key) }));

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
  const offset = Number(c.req.query("offset")) || 0;
  const count = Number(c.req.query("count")) || 30;
  return c.json(await hub(c.env).appView(c.get("member"), c.req.param("sid"), viewOf(c.req.query("view")), fmtOf(c.req.query("fmt")), offset, count));
});

app.post("/api/cross", async (c) => {
  const body = await c.req.json<{ sid?: string; index?: number; key?: string }>();
  if (typeof body.sid !== "string" || typeof body.index !== "number") return c.json({ ok: false, error: "bad request" }, 400);
  const key = typeof body.key === "string" ? body.key.slice(0, 400) : undefined;
  return c.json(await hub(c.env).appCross(c.get("member"), c.get("userId"), body.sid, body.index, key));
});

/** Recent distinct searches, for the Seek screen's chips. */
app.get("/api/recent", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT query, MAX(created_at) AS at FROM searches WHERE user_id = ? GROUP BY lower(query) ORDER BY at DESC LIMIT 8",
  ).bind(c.get("member").member_key).all<{ query: string }>();
  return c.json(results.map((r) => r.query));
});

/** The same help the bot gives (src/help.ts), for the Guide sheet. */
app.get("/api/help", (c) => {
  const role = c.get("member").role;
  return c.json({
    guide: GUIDE.map((s) => ({ ...s, body: s.body.map((b) => b.replaceAll("{courier}", c.env.COURIER_USERNAME)) })),
    commands: COMMANDS.filter((x) => x.roles.includes(role)).map(({ command, usage, help, aliases }) => ({ command, usage, help, aliases })),
  });
});

app.get("/api/session", async (c) => c.json(await hub(c.env).appSession()));

// ---- Beyond (Phase 5)

const FEEDS = ["weekly", "like", "same", "deep", "hole"] as const;

app.get("/api/beyond", async (c) => {
  const m = c.get("member");
  const status = await seer(c.env, m.member_key).status();
  const { results } = await c.env.DB.prepare(
    `SELECT id, feed, mbid, artist, artist_mbid, title, year, kind, cover, reason FROM suggestions
     WHERE user_id = ? AND outcome IS NULL ORDER BY feed, rank LIMIT 120`,
  ).bind(m.member_key).all<Record<string, unknown> & { feed: string }>();
  const feeds = Object.fromEntries(FEEDS.map((f) => [f, results.filter((r) => r.feed === f)]));
  const { results: artists } = await c.env.DB.prepare(
    `SELECT t.artist AS name, MAX(j.updated_at) AS last, COUNT(*) AS n FROM jobs j JOIN tracks t ON t.id = j.track_id
     WHERE j.user_id = ? AND j.state = 'delivered' AND t.artist IS NOT NULL AND t.artist != ''
     GROUP BY lower(t.artist) ORDER BY last DESC LIMIT 10`,
  ).bind(m.member_key).all<{ name: string }>();
  // First visit with history but nothing gathered yet: start now.
  if (!status.builtAt && status.phase === "idle" && artists.length) await seer(c.env, m.member_key).kick(m.member_key, 0);
  return c.json({ status, feeds, artists: artists.map((a) => a.name) });
});

app.post("/api/beyond/refresh", async (c) => {
  const m = c.get("member");
  const s = seer(c.env, m.member_key);
  const st = await s.status();
  if (st.builtAt && Date.now() - st.builtAt < 15 * 60_000) return c.json({ ok: false, error: "Gathered moments ago. Try again in a while." });
  await s.kick(m.member_key, 0);
  return c.json({ ok: true });
});

app.post("/api/beyond/skip", async (c) => {
  const m = c.get("member");
  const { id } = await c.req.json<{ id?: string }>();
  if (typeof id !== "string") return c.json({ ok: false }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE suggestions SET outcome = 'skipped' WHERE id = ? AND user_id = ?").bind(id, m.member_key),
    c.env.DB.prepare("INSERT INTO events (user_id, type, ref, feed, created_at) VALUES (?, 'skip', ?, 'beyond', ?)").bind(m.member_key, id, Date.now()),
  ]);
  return c.json({ ok: true });
});

app.post("/api/beyond/seek", async (c) => {
  const { id } = await c.req.json<{ id?: string }>();
  if (typeof id !== "string") return c.json({ ok: false }, 400);
  const r = await seekSuggestion(c.env, c.get("member"), c.get("userId"), id, "app");
  return r ? c.json({ ok: true, sid: r.sid, state: r.state, query: r.query }) : c.json({ ok: false, error: "That suggestion has faded." });
});

app.post("/api/beyond/hole", async (c) => {
  const m = c.get("member");
  const { artist } = await c.req.json<{ artist?: string }>();
  if (typeof artist !== "string" || !artist.trim()) return c.json({ ok: false }, 400);
  const known = await c.env.DB.prepare("SELECT mbid, name FROM artists WHERE name_norm = ?").bind(norm(artist)).first<{ mbid: string | null; name: string }>();
  const n = await seer(c.env, m.member_key).hole(m.member_key, { mbid: known?.mbid ?? undefined, name: artist.slice(0, 120) });
  const { results } = await c.env.DB.prepare(
    "SELECT id, feed, mbid, artist, artist_mbid, title, year, kind, cover, reason FROM suggestions WHERE user_id = ? AND feed = 'hole' AND outcome IS NULL ORDER BY rank",
  ).bind(m.member_key).all();
  return c.json({ ok: n > 0, items: results });
});

/** Client errors from the mini app (message and a short stack, digits masked), for diagnosis. */
app.post("/api/client-error", async (c) => {
  const b = await c.req.json<{ where?: string; message?: string; stack?: string }>().catch(() => ({}) as Record<string, string>);
  const clean = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\d{6,}/g, "#").slice(0, n) : "");
  console.log(JSON.stringify({ at: "client", where: clean(b.where, 20), message: clean(b.message, 300), stack: clean(b.stack, 800) }));
  return c.json({ ok: true });
});

app.post("/api/session/:op", async (c) => {
  const m = c.get("member");
  if (m.role !== "admin") return notFound();
  const op = c.req.param("op");
  if (op === "wake") {
    const r = await hub(c.env).wake(c.get("userId"));
    return c.json({ ok: r.dispatched || r.session.state !== "offline", state: r.session.state });
  }
  if (op === "sleep") return c.json({ ok: await hub(c.env).sleep() });
  return notFound();
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
