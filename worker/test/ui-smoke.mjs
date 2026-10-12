// UI smoke test: the built mini app in Chrome at phone width, inside Telegram's REAL SDK
// (telegram.org/js/telegram-web-app.js, initData passed in the URL hash the way Telegram does),
// against `wrangler dev` with a fresh local D1 and a fake runner.
// Fails on any page error, any SDK error, or a broken seek → results → page → album → cross flow.
// Usage: CHROME_PATH=/usr/bin/google-chrome node --experimental-strip-types test/ui-smoke.mjs http://127.0.0.1:8787 [shots-dir]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { signInitData } from "../src/initdata.ts";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const SHOTS = process.argv[3];
const vars = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const ADMIN = 1001, MB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (name) => console.log(`  ✓ ${name}`);

await fetch(`${BASE}/tg/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": vars.WEBHOOK_SECRET },
  body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: ADMIN, type: "private" }, from: { id: ADMIN }, text: `/start c_${vars.CLAIM_SECRET}` } }) });

const ws = new WebSocket(`${BASE.replace("http", "ws")}/hub/runner`, { headers: { Authorization: `Bearer ${vars.RUNNER_SECRET}` } });
const inbox = [];
ws.onmessage = (e) => inbox.push(JSON.parse(e.data));
await new Promise((r) => (ws.onopen = r));
const send = (type, data) => ws.send(JSON.stringify({ v: 1, type, ts: Date.now(), data }));
const next = async (type) => { for (let i = 0; i < 100; i++) { const k = inbox.findIndex((m) => m.type === type); if (k >= 0) return inbox.splice(k, 1)[0]; await sleep(100); } throw new Error(`runner never got ${type}`); };
send("runner.hello", { run_id: 1, agent: "fake", active_jobs: [], max_upload_mb: 50, direct_base: "https://door.example.test" });
await next("hub.welcome");

const titles = ["Accordion", "Meat Grinder", "Bistro", "Raid", "America's Most Blunted", "Sickfit", "Rainbows", "Curls", "Money Folder", "Figaro", "Hardcore Hustle", "Strange Ways"];
const folders = (n) => Array.from({ length: n }, (_, k) => {
  const flac = k % 3 !== 2, ext = flac ? "flac" : "mp3", dir = `Music\\Artist ${k % 5}\\Album ${k}`;
  return { u: `peer${k}`, d: dir, f: k % 4 !== 3, q: k % 4 === 3 ? 7 : 0, s: 900000 - k,
    files: titles.slice(0, 6 + (k % 7)).map((t, i) => [`${dir}\\${String(i + 1).padStart(2, "0")} - ${t}.${ext}`, (flac ? 18 + ((i * 7 + k) % 40) : 5 + (i % 6)) * MB + k * 1000 + i, ext, flac ? null : 320, flac ? 16 : null, flac ? 44100 : null, 120 + i * 17]) };
});

const initData = await signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "q", user: JSON.stringify({ id: ADMIN }) }, vars.VEIL_BOT_TOKEN);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
const page = await browser.newPage({ viewport: { width: 360, height: 760 }, deviceScaleFactor: 2, colorScheme: "dark" });
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text().slice(0, 200)}`); });
const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

const hash = new URLSearchParams({ tgWebAppData: initData, tgWebAppVersion: "8.0", tgWebAppPlatform: "android", tgWebAppThemeParams: JSON.stringify({ bg_color: "#000000" }) });
await page.goto(`${BASE}/#${hash}`);
await page.waitForSelector(".strip");
assert.equal(await page.evaluate(() => Boolean(window.Telegram?.WebApp?.initData)), true);
ok("app opens inside the real Telegram SDK");
await shot("1-open");

await page.fill(".seekbar input", "madvillain");
await page.click(".seekbar button[type=submit]");
const ss = await next("search.start");
send("search.progress", { search_id: ss.data.search_id, responses: 737, files: 38640 });
await page.waitForFunction(() => /737 answers/.test(document.body.innerText), null, { timeout: 5000 });
ok("live answer count shown while listening");
await shot("2-listening");
send("search.results", { search_id: ss.data.search_id, responses: 60, files: 600, folders: folders(60), partial: false });
await page.waitForSelector(".result", { timeout: 8000 });
assert.match(await page.textContent(".summary"), /\d+ tracks · \d+ albums/);
ok("results and counts shown");
await shot("3-results");

assert.equal(await page.$$eval(".result", (x) => x.length), 30);
await page.click(".btn.more");
await page.waitForFunction(() => document.querySelectorAll(".result").length === 60, null, { timeout: 5000 });
ok("Show more loads the next 30");

await page.click(".result .result-main >> nth=0");
await page.waitForFunction(() => Telegram.WebApp.MainButton.isVisible && /Let it cross/.test(Telegram.WebApp.MainButton.text), null, { timeout: 3000 });
await page.click(".result .result-main >> nth=0");
await page.waitForFunction(() => !Telegram.WebApp.MainButton.isVisible, null, { timeout: 3000 });
ok("main button follows the selection (and is never given an empty text)");

await page.click(".seg[aria-label=View] button:nth-child(2)");
await page.waitForFunction(() => document.querySelector(".result .chip")?.textContent === "ALBUM", null, { timeout: 5000 });
await page.click(".result .result-main >> nth=0");
await page.waitForSelector(".tracks li");
await page.waitForFunction(() => /^Let \d+ files cross$/.test(Telegram.WebApp.MainButton.text), null, { timeout: 3000 });
ok("album expands and offers to cross all its files");
await shot("4-album");

await page.evaluate(() => Telegram.WebView.receiveEvent("main_button_pressed"));
const js = await next("job.start");
send("job.state", { job_id: js.data.job_id, state: "downloading", pct: 61 });
await page.click(".tabs button:nth-child(2)");
await page.waitForSelector(".crossing", { timeout: 5000 });
ok("main button crosses; Crossings shows it live");
await shot("5-crossings");

await page.click(".strip-main");
await page.waitForSelector(".sheet");
await page.click(".scrim");
await page.click(".gear");
await page.click("text=Guide");
await page.waitForSelector(".guide dt");
ok("session, settings and guide sheets open");
await shot("6-guide");

assert.deepEqual(problems, [], `page or SDK errors:\n${problems.join("\n")}`);
ok("no page errors, no SDK errors");
await browser.close();
ws.close();
console.log("\nui smoke: all checks passed");
