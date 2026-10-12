// Phase 5 end-to-end against `wrangler dev`: a few crossings, then the Seer gathers Beyond from the REAL
// ListenBrainz and MusicBrainz APIs (verification included). AI may be unavailable locally; the plain order is
// then used, which this test accepts. Usage: node --experimental-strip-types test/beyond-smoke.mjs http://127.0.0.1:8787
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { signInitData } from "../src/initdata.ts";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const vars = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const ok = (name) => console.log(`  ✓ ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN = 1001, MB = 1024 * 1024;
let uid = 1;
const hook = async (body) => { const r = await fetch(`${BASE}/tg/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": vars.WEBHOOK_SECRET }, body: JSON.stringify(body) }); const t = await r.text(); return t ? JSON.parse(t) : null; };
const msg = (text) => hook({ update_id: uid++, message: { message_id: uid, chat: { id: ADMIN, type: "private" }, from: { id: ADMIN }, text } });
const tma = await signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q", user: JSON.stringify({ id: ADMIN }) }, vars.VEIL_BOT_TOKEN);
const api = async (method, path, body) => { const r = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `tma ${tma}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); return r.status === 200 ? r.json() : { status: r.status }; };

await msg(`/start c_${vars.CLAIM_SECRET}`);
let r = await api("GET", "/api/beyond");
assert.equal(r.feeds.weekly.length, 0); ok("Beyond is empty before anything crossed");

// fake runner: three artists cross
const ws = new WebSocket(`${BASE.replace("http", "ws")}/hub/runner`, { headers: { Authorization: `Bearer ${vars.RUNNER_SECRET}` } });
const inbox = []; ws.onmessage = (e) => inbox.push(JSON.parse(e.data)); await new Promise((r) => (ws.onopen = r));
const send = (type, data) => ws.send(JSON.stringify({ v: 1, type, ts: Date.now(), data }));
const next = async (type) => { for (let i = 0; i < 100; i++) { const k = inbox.findIndex((m) => m.type === type); if (k >= 0) return inbox.splice(k, 1)[0]; await sleep(100); } throw new Error(`no ${type}`); };
send("runner.hello", { run_id: 1, agent: "fake", active_jobs: [], max_upload_mb: 50 });
await next("hub.welcome");
const beat = setInterval(() => send("runner.heartbeat", { active_jobs: 0, idle_s: 0 }), 20_000);
const crossed = [["Nine Inch Nails", "Hurt", "The Downward Spiral"], ["Madvillain", "Accordion", "Madvillainy"], ["Boards of Canada", "Roygbiv", "Music Has the Right to Children"]];
for (const [artist, title, album] of crossed) {
  await msg(`/s ${artist} ${title}`);
  const ss = await next("search.start");
  send("search.results", { search_id: ss.data.search_id, responses: 1, files: 1, partial: false, folders: [{ u: "p", d: `x\\${album}`, f: true, q: 0, s: 1, files: [[`x\\${album}\\01 ${title}.flac`, 30 * MB, "flac", null, 16, 44100, 200]] }] });
  await sleep(300);
  await hook({ update_id: uid++, callback_query: { id: "cq", from: { id: ADMIN }, data: `s:${ss.data.search_id}:d:0`, message: { message_id: 9, chat: { id: ADMIN } } } });
  const js = await next("job.start");
  send("job.state", { job_id: js.data.job_id, state: "delivered", track: { artist, title, album, format: "flac" } });
  await sleep(300);
}
ok("three artists crossed");

// first visit kicks the Seer; it gathers from ListenBrainz and verifies with MusicBrainz (≤ 1 request/s)
r = await api("GET", "/api/beyond");
const t0 = Date.now();
while (Date.now() - t0 < 240_000) {
  await sleep(5000);
  r = await api("GET", "/api/beyond");
  if (r.status.phase === "idle" && r.status.builtAt) break;
}
assert.ok(r.status.builtAt, `Seer finished (phase ${r.status.phase})`);
ok(`Seer gathered in ${Math.round((Date.now() - t0) / 1000)} s (ranked by ${r.status.by})`);
for (const f of ["like", "same", "deep", "weekly"]) console.log(`    ${f}: ${r.feeds[f].length} · e.g. ${r.feeds[f].slice(0, 2).map((s) => `${s.artist} — ${s.title}`).join(" | ")}`);
assert.ok(r.feeds.like.length >= 3 && r.feeds.same.length >= 1 && r.feeds.weekly.length >= 3);
ok("feeds filled: like, same, weekly");
const all = Object.values(r.feeds).flat();
assert.ok(all.every((s) => /^[0-9a-f-]{36}$/.test(s.mbid) && s.reason.length > 8));
assert.ok(!all.some((s) => /downward spiral|madvillainy$|music has the right to children/i.test(s.title)), "albums already crossed are not suggested");
ok("every suggestion has a MusicBrainz id and a reason; crossed albums excluded");

// skip, seek
const victim = r.feeds.like[0];
await api("POST", "/api/beyond/skip", { id: victim.id });
r = await api("GET", "/api/beyond");
assert.ok(!Object.values(r.feeds).flat().some((s) => s.id === victim.id)); ok("✕ skip removes it");
const pick = r.feeds.weekly[0];
const s = await api("POST", "/api/beyond/seek", { id: pick.id });
assert.equal(s.ok, true); const ss = await next("search.start");
assert.equal(ss.data.query, s.query); ok(`tap seeks the exact release (“${s.query}”)`);
send("search.results", { search_id: ss.data.search_id, responses: 1, files: 1, partial: false, folders: [{ u: "p", d: "y\\z", f: true, q: 0, s: 1, files: [["y\\z\\01 a.flac", 30 * MB, "flac", null, 16, 44100, 200]] }] });
await sleep(300);
await api("POST", "/api/cross", { sid: s.sid, index: 0 });
const js = await next("job.start");
send("job.state", { job_id: js.data.job_id, state: "delivered", track: { artist: pick.artist, title: "a", album: pick.title, format: "flac" } });
await sleep(500);
r = await api("GET", "/api/beyond");
assert.ok(!Object.values(r.feeds).flat().some((x) => x.id === pick.id)); ok("crossing from a suggestion marks it crossed");

// bot /beyond and the rabbit hole
const b = await msg("/beyond");
assert.match(b.text, /What lies beyond/); assert.ok(b.reply_markup.inline_keyboard[0][0].callback_data.startsWith("b:")); ok("/beyond lists suggestions with seek buttons");
const h = await api("POST", "/api/beyond/hole", { artist: "Boards of Canada" });
console.log(`    hole: ${h.items.map((x) => `${x.artist} — ${x.title}`).join(" → ")}`);
assert.ok(h.items.length >= 2); ok("rabbit hole walks outward with verified records");

assert.ok(!Object.values(r.feeds).flat().some((x) => /\blive\b/i.test(x.title)), "no live records");
ok("live records and compilations are filtered out");
clearInterval(beat);
ws.close();
console.log("\nbeyond smoke: all checks passed");
