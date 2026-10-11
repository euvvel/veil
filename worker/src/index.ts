// veil front door. Routes: /tg/webhook (bot), /hub/runner (runner WS), /hub/app + /api/* (mini app).
// Anything unauthenticated gets a 404, so the Worker looks like nothing is there.

import { Hono } from "hono";
import { handleUpdate, type TgUpdate } from "./bot.ts";
import { safeEqual } from "./crypto.ts";
import { hub, type Env } from "./env.ts";
import { validateInitData } from "./initdata.ts";
import { activeMember, memberKey, type Member } from "./members.ts";
import { tgCall } from "./telegram.ts";

export { Hub } from "./hub.ts";

const INIT_DATA_MAX_AGE_S = 24 * 3600;

type Ctx = { Bindings: Env; Variables: { member: Member } };
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

/** Mini app auth: `Authorization: tma <initData>`, or `?tma=` for WebSockets (browsers cannot set WS headers). */
async function memberFrom(env: Env, initData: string | undefined): Promise<Member | null> {
  const r = await validateInitData(initData, env.VEIL_BOT_TOKEN, INIT_DATA_MAX_AGE_S, Math.floor(Date.now() / 1000));
  if (!r.ok) return null;
  return activeMember(env.DB, await memberKey(env.MEMBER_HMAC_KEY, r.user.id));
}

app.get("/hub/app", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return notFound();
  const member = await memberFrom(c.env, c.req.query("tma"));
  if (!member) return notFound();
  return hub(c.env).fetch(new Request("https://hub/app", c.req.raw));
});

app.use("/api/*", async (c, next) => {
  const auth = c.req.header("Authorization") ?? "";
  const member = await memberFrom(c.env, auth.startsWith("tma ") ? auth.slice(4) : undefined);
  if (!member) return notFound();
  c.set("member", member);
  await next();
});

app.get("/api/me", async (c) => {
  const m = c.get("member");
  const s = await hub(c.env).getSession();
  return c.json({ role: m.role, prefs: JSON.parse(m.prefs), session: { state: s.state } });
});

app.all("/api/*", notFound);
app.all("/tg/*", notFound);
app.all("/hub/*", notFound);

export default app satisfies ExportedHandler<Env>;
