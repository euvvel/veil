// Phase 3 end-to-end against `wrangler dev` with a fresh local D1 and a fake runner.
// Usage: node --experimental-strip-types test/phase3-smoke.mjs http://127.0.0.1:8787
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const WS = BASE.replace("http", "ws");
const vars = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const ok = (name) => console.log(`  ✓ ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let uid = 1;
const ADMIN = 1001;
async function hook(body) {
  const r = await fetch(`${BASE}/tg/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": vars.WEBHOOK_SECRET }, body: JSON.stringify(body) });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}
const msg = (text) => hook({ update_id: uid++, message: { message_id: uid, chat: { id: ADMIN, type: "private" }, from: { id: ADMIN }, text } });
const tap = (data) => hook({ update_id: uid++, callback_query: { id: `cq${uid}`, from: { id: ADMIN }, data, message: { message_id: 77, chat: { id: ADMIN } } } });

/** A fake runner that records what the Hub sends it. */
async function runner(active = []) {
  const ws = new WebSocket(`${WS}/hub/runner`, { headers: { Authorization: `Bearer ${vars.RUNNER_SECRET}` } });
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    inbox.push(m);
    waiters.splice(0).forEach((w) => w());
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (type, data = {}) => ws.send(JSON.stringify({ v: 1, type, ts: Date.now(), data }));
  const next = async (type, timeout = 5000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return inbox.splice(i, 1)[0];
      if (Date.now() > end) throw new Error(`runner never got ${type}; inbox: ${inbox.map((m) => m.type)}`);
      await new Promise((r) => { waiters.push(r); setTimeout(r, 200); });
    }
  };
  send("runner.hello", { run_id: 1, session_id: "local", agent: "fake", active_jobs: active, max_upload_mb: 50 });
  await next("hub.welcome");
  return { ws, send, next, close: () => ws.close() };
}

const MB = 1024 * 1024;
const folders = [
  { u: "peerA", d: "Music\\NIN\\Ghosts I-IV", f: true, q: 0, s: 900000, files: [
    ["Music\\NIN\\Ghosts I-IV\\01 1 Ghosts I.flac", 30 * MB, "flac", null, 16, 44100, 168],
    ["Music\\NIN\\Ghosts I-IV\\02 2 Ghosts I.flac", 31 * MB, "flac", null, 16, 44100, 196],
  ] },
  { u: "peerB", d: "mp3\\NIN - Ghosts", f: true, q: 0, s: 500000, files: [
    ["mp3\\NIN - Ghosts\\01 Ghosts I.mp3", 7 * MB, "mp3", 320, null, null, 168],
  ] },
];

// --- claim, connect
let r = await msg(`/start c_${vars.CLAIM_SECRET}`);
assert.match(r.text, /keeper/); ok("claimed");
const run1 = await runner();
ok("fake runner connected");

// --- search
r = await msg("/s flac nine inch nails ghosts");
assert.match(r.text, /Listening beyond/); ok("/s while ready → searching");
const ss = await run1.next("search.start");
assert.equal(ss.data.query, "nine inch nails ghosts"); ok("runner got search.start (format word stripped)");
const sid = ss.data.search_id;
run1.send("search.results", { search_id: sid, responses: 2, files: 3, folders });
await sleep(500);

// --- toggles
r = await tap(`s:${sid}:f:mp3`);
assert.equal(r.method, "editMessageText"); assert.match(r.text, /MP3 · tracks · 1 tracks · 0 albums/); ok("format toggle → MP3 view with counts");
r = await tap(`s:${sid}:v:a`);
assert.match(r.text, /albums/); ok("view toggle → albums");
r = await tap(`s:${sid}:v:t`);
r = await tap(`s:${sid}:f:flac`);
assert.match(r.text, /FLAC · tracks · 2 tracks · 1 albums/); assert.match(r.text, /1\. 01 1 Ghosts I\.flac/); ok("back to FLAC tracks");

// --- help and plain words
r = await msg("/help");
assert.match(r.text, /COMMANDS/); assert.match(r.text, /\/seek \[flac\|mp3\|any\] words/); assert.match(r.text, /\/invite/); ok("/help lists the keeper's commands");
r = await msg("/nonsense");
assert.match(r.text, /\/help/); ok("unknown command → pointer to /help");
r = await msg("aphex twin windowlicker");
assert.match(r.text, /Listening beyond/);
const plain = await run1.next("search.start");
assert.equal(plain.data.query, "aphex twin windowlicker"); ok("plain words seek");
run1.send("search.results", { search_id: plain.data.search_id, responses: 0, files: 0, folders: [], partial: false }); // answered, so it is not re-sent later
r = await tap(`s:${sid}:n:0`);
assert.equal(r.method, "answerCallbackQuery"); ok("page counter button is inert");

// --- download and deliver
r = await tap(`s:${sid}:d:0`);
assert.equal(r.method, "answerCallbackQuery"); assert.equal(r.text, "Let it cross."); ok("tap → let it cross");
const js = await run1.next("job.start");
assert.equal(js.data.peer, "peerA"); assert.equal(js.data.chat_id, ADMIN); assert.equal(js.data.size, 30 * MB); ok("runner got job.start with peer/path/chat");
for (const [state, extra] of [["queued", { place: 3 }], ["downloading", { pct: 40, kbps: 900 }], ["uploading", {}]]) run1.send("job.state", { job_id: js.data.job_id, state, ...extra });
run1.send("job.state", { job_id: js.data.job_id, state: "delivered", kbps: 900, track: { artist: "Nine Inch Nails", title: "1 Ghosts I", album: "Ghosts I-IV", year: 2008, format: "flac", message_id: 5 } });
await sleep(500);
r = await msg("/history");
assert.match(r.text, /Nine Inch Nails – 1 Ghosts I · FLAC/); ok("/history shows the crossing");

// --- a job left unfinished is re-sent on the next opening
r = await tap(`s:${sid}:d:1`);
const js2 = await run1.next("job.start");
run1.send("session.state", { state: "draining" });
run1.send("job.state", { job_id: js2.data.job_id, state: "pending" });
run1.send("runner.bye", { reason: "test" });
await sleep(800);
r = await msg("/status");
assert.match(r.text, /closed|Thinning/); ok("bye with unfinished work → Hub re-rings (fails later with the fake GitHub token)");
const run2 = await runner([]);
const again = await run2.next("job.start");
assert.equal(again.data.job_id, js2.data.job_id); ok("unfinished job re-sent on next hello");
const run3 = await runner([js2.data.job_id]);
await assert.rejects(run3.next("job.start", 1200)); ok("job already held by runner is not re-sent");

// --- search while offline is held until the runner comes
run3.send("runner.bye", { reason: "test" });
await sleep(800);
r = await msg("/seek mp3 ghosts");
assert.match(r.text, /as soon as the veil opens/); ok("/seek while offline → held");
const run4 = await runner();
const held = await run4.next("search.start");
assert.equal(held.data.query, "ghosts"); ok("held search sent on hello");

// --- /sleep
r = await msg("/sleep");
await run4.next("session.drain"); ok("/sleep → runner asked to drain");
run4.send("runner.bye", { reason: "asked" });

// --- stale taps
r = await tap("s:ffffffffff:d:0");
assert.match(r.text, /faded/); ok("unknown search → faded");

for (const x of [run1, run2, run3, run4]) x.close();
console.log("\nphase 3 smoke: all checks passed");
