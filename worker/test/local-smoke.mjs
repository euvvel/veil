// End-to-end smoke test against `wrangler dev` (local D1, test secrets from .dev.vars).
// Usage: node --experimental-strip-types test/local-smoke.mjs http://127.0.0.1:8787
import assert from "node:assert/strict";
import { signInitData } from "../src/initdata.ts";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const vars = Object.fromEntries(
  (await import("node:fs")).readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

let uid = 1;
const update = (from, text) => ({ update_id: uid++, message: { message_id: uid, chat: { id: from, type: "private" }, from: { id: from }, text } });
async function hook(body, secret = vars.WEBHOOK_SECRET) {
  const r = await fetch(`${BASE}/tg/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text && r.status === 200 ? JSON.parse(text) : text || null };
}
const ADMIN = 1001, FRIEND = 2002, STRANGER = 3003;
const ok = (name) => console.log(`  ✓ ${name}`);

// webhook auth
assert.equal((await hook(update(ADMIN, "/start"), "wrong")).status, 404); ok("wrong webhook secret → 404");

// strangers get silence
let r = await hook(update(STRANGER, "/start"));
assert.equal(r.status, 200); assert.equal(r.body, null); ok("stranger /start → silence");
r = await hook(update(STRANGER, "/start c_wrong"));
assert.equal(r.body, null); ok("wrong claim code → silence");

// claim
r = await hook(update(ADMIN, `/start c_${vars.CLAIM_SECRET}`));
assert.equal(r.body.method, "sendMessage"); assert.match(r.body.text, /keeper/); ok("claim → admin");
r = await hook(update(STRANGER, `/start c_${vars.CLAIM_SECRET}`));
assert.equal(r.body, null); ok("second claim → silence (claim works once)");

// invite
r = await hook(update(FRIEND, "/invite"));
assert.equal(r.body, null); ok("non-member /invite → silence");
r = await hook(update(ADMIN, "/invite"));
const code = r.body.text.match(/start=(i_[0-9a-f]+)/)[1]; ok("admin /invite → single-use link");
r = await hook(update(FRIEND, `/start ${code}`));
assert.match(r.body.text, /let through/); ok("friend redeems invite");
r = await hook(update(STRANGER, `/start ${code}`));
assert.equal(r.body, null); ok("reused invite → silence");
r = await hook(update(FRIEND, "/invite"));
assert.equal(r.body, null); ok("member /invite → silence (admin only)");

// members + revoke
r = await hook(update(ADMIN, "/members"));
assert.match(r.body.text, /admin .*\(you\)/); const rv = r.body.reply_markup.inline_keyboard[0][0].callback_data; ok("/members lists both");
r = await hook({ update_id: uid++, callback_query: { id: "cq1", from: { id: FRIEND }, data: rv } });
assert.equal(r.body, null); ok("member cannot revoke");

// status + wake (dispatch fails with the fake GitHub token → offline again)
r = await hook(update(FRIEND, "/status"));
assert.match(r.body.text, /closed/); ok("/status → closed");
r = await hook(update(ADMIN, "/wake"));
assert.match(r.body.text, /dispatch failed \(40\d\)/); ok("/wake with fake GH token → reported failure");
r = await hook(update(ADMIN, "/status"));
assert.match(r.body.text, /closed/); ok("failed dispatch falls back to offline");

// mini app API
const initData = (id) => signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q", user: JSON.stringify({ id }) }, vars.VEIL_BOT_TOKEN);
let a = await fetch(`${BASE}/api/me`, { headers: { Authorization: `tma ${await initData(FRIEND)}` } });
assert.equal(a.status, 200); assert.deepEqual((await a.json()).role, "member"); ok("/api/me with valid initData");
a = await fetch(`${BASE}/api/me`, { headers: { Authorization: `tma ${await initData(STRANGER)}` } });
assert.equal(a.status, 404); ok("/api/me for stranger → 404");
a = await fetch(`${BASE}/api/me`);
assert.equal(a.status, 404); ok("/api/me without auth → 404");

// runner socket
const bad = new WebSocket(`${BASE.replace("http", "ws")}/hub/runner`, { headers: { Authorization: "Bearer nope" } });
assert.equal(await new Promise((res) => { bad.onopen = () => res("open"); bad.onerror = () => res("refused"); }), "refused");
ok("runner with wrong secret → refused");

const bad2 = new WebSocket(`${BASE.replace("http", "ws")}/hub/app?t=${"0".repeat(32)}`);
assert.equal(await new Promise((res) => { bad2.onopen = () => res("open"); bad2.onerror = () => res("refused"); }), "refused");
ok("app socket with an unknown ticket → refused");
const { t: ticket } = await (await fetch(`${BASE}/api/ticket`, { method: "POST", headers: { Authorization: `tma ${await initData(ADMIN)}` } })).json();
const app = new WebSocket(`${BASE.replace("http", "ws")}/hub/app?t=${ticket}`);
const appStates = [];
app.onmessage = (e) => appStates.push(JSON.parse(e.data).data.state);
await new Promise((res, rej) => { app.onopen = res; app.onerror = rej; });

const ws = new WebSocket(`${BASE.replace("http", "ws")}/hub/runner`, { headers: { Authorization: `Bearer ${vars.RUNNER_SECRET}` } });
const welcome = new Promise((res, rej) => { ws.onmessage = (e) => res(JSON.parse(e.data)); ws.onerror = rej; });
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.send(JSON.stringify({ v: 1, type: "runner.hello", data: { run_id: 1, session_id: "local" } }));
assert.equal((await welcome).type, "hub.welcome"); ok("runner hello → welcome");
r = await hook(update(ADMIN, "/status"));
assert.match(r.body.text, /open/); ok("/status → open while runner connected");
ws.send(JSON.stringify({ v: 1, type: "runner.heartbeat" }));
ws.send(JSON.stringify({ v: 1, type: "runner.bye" }));
await new Promise((res) => (ws.onclose = res));
r = await hook(update(ADMIN, "/status"));
assert.match(r.body.text, /closed/); ok("runner bye → closed");
await new Promise((res) => setTimeout(res, 300));
app.close();
assert.deepEqual(appStates, ["offline", "ready", "offline"]); ok("mini app socket saw offline → ready → offline");

// leave
r = await hook(update(FRIEND, "/leave"));
assert.match(r.body.text, /forgotten/);
r = await hook(update(FRIEND, "/status"));
assert.equal(r.body, null); ok("member /leave → silence afterwards");

console.log("\nlocal smoke: all checks passed");
