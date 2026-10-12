// Phase 4 end-to-end against `wrangler dev` (fresh local D1): mini app API and direct crossing (D8).
// Usage: node --experimental-strip-types test/phase4-smoke.mjs http://127.0.0.1:8787
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { signInitData } from "../src/initdata.ts";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const vars = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const ok = (name) => console.log(`  ✓ ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN = 1001, STRANGER = 3003;
const MB = 1024 * 1024;

await fetch(`${BASE}/tg/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": vars.WEBHOOK_SECRET },
  body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: ADMIN, type: "private" }, from: { id: ADMIN }, text: `/start c_${vars.CLAIM_SECRET}` } }) });

const tma = (id) => signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q", user: JSON.stringify({ id }) }, vars.VEIL_BOT_TOKEN);
const api = async (method, path, body, id = ADMIN) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `tma ${await tma(id)}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
};

// member socket
const appWs = new WebSocket(`${BASE.replace("http", "ws")}/hub/app?tma=${encodeURIComponent(await tma(ADMIN))}`);
const appInbox = [];
appWs.onmessage = (e) => appInbox.push(JSON.parse(e.data));
await new Promise((r) => (appWs.onopen = r));

// fake runner with a tunnel
const ws = new WebSocket(`${BASE.replace("http", "ws")}/hub/runner`, { headers: { Authorization: `Bearer ${vars.RUNNER_SECRET}` } });
const inbox = [];
ws.onmessage = (e) => inbox.push(JSON.parse(e.data));
await new Promise((r) => (ws.onopen = r));
const send = (type, data) => ws.send(JSON.stringify({ v: 1, type, ts: Date.now(), data }));
const next = async (type) => { for (let i = 0; i < 60; i++) { const k = inbox.findIndex((m) => m.type === type); if (k >= 0) return inbox.splice(k, 1)[0]; await sleep(100); } throw new Error(`runner never got ${type}`); };
send("runner.hello", { run_id: 1, agent: "fake", active_jobs: [], max_upload_mb: 50, direct_base: "https://door.example.test" });
await next("hub.welcome");

// prefs
let r = await api("PATCH", "/api/prefs", { format: "mp3", max_mb: 9999, fallback: false });
assert.deepEqual(r.body, { format: "mp3", max_mb: 150, fallback: false }); ok("prefs: valid fields saved, out-of-range max_mb ignored");
await api("PATCH", "/api/prefs", { format: "flac", fallback: true });
assert.equal((await api("GET", "/api/me", null, STRANGER)).status, 404); ok("stranger → 404");

// search from the app: no Telegram message, a socket event instead
r = await api("POST", "/api/search", { query: "ghosts", fmt: "flac" });
const sid = r.body.sid; assert.equal(r.body.state, "ready"); ok("app search sent");
const ss = await next("search.start");
send("search.results", { search_id: ss.data.search_id, responses: 2, files: 2, folders: [
  { u: "a", d: "x\\Ghosts", f: true, q: 0, s: 1, files: [["x\\Ghosts\\01.flac", 30 * MB, "flac", null, 16, 44100, 100]] },
  { u: "b", d: "y\\Hires", f: true, q: 0, s: 1, files: [["y\\Hires\\01 Long.flac", 118 * MB, "flac", null, 24, 96000, 400]] },
] });
await sleep(400);
assert.ok(appInbox.some((m) => m.type === "search.done" && m.data.sid === sid)); ok("search.done pushed to the member socket");
r = await api("GET", `/api/search/${sid}`);
assert.equal(r.body.items.length, 2); assert.equal(r.body.items[1].direct, true); assert.equal(r.body.items[0].direct, false);
assert.ok(!JSON.stringify(r.body).includes('"u"'), "no peer names to the app"); ok("results: direct flag set, no peer names");
r = await api("GET", `/api/search/${sid}?view=a&fmt=mp3`);
assert.equal(r.body.view, "a"); assert.equal(r.body.fmt, "mp3"); ok("view/format switch");
await api("GET", `/api/search/${sid}?view=t&fmt=flac`);

// direct crossing
r = await api("POST", "/api/cross", { sid, index: 1 });
assert.equal(r.body.ok, true); const gid = r.body.gid; ok("cross the 118 MB file");
const js = await next("job.start");
assert.equal(js.data.mode, "direct"); ok("runner got job.start in direct mode");
send("job.state", { job_id: js.data.job_id, state: "downloading", pct: 50 });
send("job.state", { job_id: js.data.job_id, state: "awaiting", token: "TOKEN123" });
await sleep(400);
r = await api("GET", "/api/crossings");
assert.equal(r.body.active[0].jobs[0].state, "awaiting"); ok("crossings show it awaiting");
r = await api("GET", `/api/direct/${gid}`);
assert.equal(r.body[0].url, "https://door.example.test/f/TOKEN123"); ok("direct link handed to the member");
assert.deepEqual((await api("GET", `/api/direct/${gid}`, null, STRANGER)).status, 404); ok("stranger cannot see the link");
r = await api("POST", "/api/direct/release", { job: js.data.job_id });
assert.equal(r.body.ok, true);
const rel = await next("job.release");
assert.equal(rel.data.job_id, js.data.job_id); ok("release forwarded to the runner");
send("job.state", { job_id: js.data.job_id, state: "delivered", track: { artist: "NIN", title: "Long", format: "flac", message_id: null } });
await sleep(400);
const last = appInbox.filter((m) => m.type === "crossing").pop();
assert.equal(last.data.done, true); assert.equal(last.data.jobs[0].state, "delivered"); ok("crossing done pushed to the app");
r = await api("GET", "/api/crossings");
assert.equal(r.body.active.length, 0); assert.match(JSON.stringify(r.body.history), /NIN/); ok("history updated, nothing left active");
assert.equal((await api("GET", `/api/direct/${gid}`)).body.length, 0); ok("link gone after delivery");

// without a tunnel, oversize is refused
send("runner.hello", { run_id: 1, agent: "fake", active_jobs: [], max_upload_mb: 50 });
await next("hub.welcome");
r = await api("POST", "/api/cross", { sid, index: 1 });
assert.equal(r.body.ok, false); assert.match(r.body.error, /Too large/); ok("no tunnel → oversize refused");

ws.close(); appWs.close();
console.log("\nphase 4 smoke: all checks passed");
