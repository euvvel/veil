import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptPicks, cleanReason, fallback } from "../src/beyond/ai.ts";
import { compose, mergeSimilar, norm, seekQuery, weeklyPool, type Candidate, type RG, type Seed } from "../src/beyond/pick.ts";
import { nextWeekly } from "../src/beyond/schedule.ts";

const rg = (artistMbid: string, artist: string, title: string, listens: number, kind = "Album"): RG =>
  ({ mbid: `${artistMbid}-${title}`, title, year: 2000, kind, listens, artist, artistMbid, cover: null });

const seed: Seed = { name: "Madvillain", mbid: "mv", weight: 3, crossed: 5, albums: [norm("Madvillainy")] };
const pools = () => ({
  seeds: [seed],
  seedRGs: new Map([["mv", [rg("mv", "Madvillain", "Madvillainy", 900000), rg("mv", "Madvillain", "Madvillainy 2: The Madlib Remix", 40000), rg("mv", "Madvillain", "Money Folder", 900, "Single")]]]),
  similar: mergeSimilar([{ seed, artists: [{ mbid: "doom", name: "MF DOOM", score: 900 }, { mbid: "mv", name: "Madvillain", score: 999 }, { mbid: "quas", name: "Quasimoto", score: 600 }] }], [seed]),
  similarRGs: new Map([
    ["doom", [rg("doom", "MF DOOM", "Mm..Food", 800000), rg("doom", "MF DOOM", "Born Like This", 300000), rg("doom", "MF DOOM", "Special Herbs", 30000)]],
    ["quas", [rg("quas", "Quasimoto", "The Unseen", 200000), rg("quas", "Quasimoto", "Yessir Whatever", 9000)]],
  ]),
  skipped: new Set<string>(),
  shown: new Set<string>(),
});

test("mergeSimilar drops the seeds themselves and normalises scores", () => {
  const s = pools().similar;
  assert.deepEqual(s.map((x) => x.name), ["MF DOOM", "Quasimoto"]);
  assert.equal(s[0]!.score, 1);
  assert.equal(s[0]!.via, "Madvillain");
});

test("same: what you lack by artists you have (not albums already crossed, not singles)", () => {
  const f = compose(pools());
  assert.deepEqual(f.same.map((c) => c.title), ["Madvillainy 2: The Madlib Remix"]);
});

test("like: the best-known record of each similar artist", () => {
  const f = compose(pools());
  assert.deepEqual(f.like.map((c) => c.title), ["Mm..Food", "The Unseen"]);
});

test("deep: quieter records, 1–15% of the artist's best-known", () => {
  const f = compose(pools());
  assert.ok(f.deep.some((c) => c.title === "Special Herbs"));
  assert.ok(f.deep.some((c) => c.title === "Yessir Whatever"));
  assert.ok(!f.deep.some((c) => c.title === "Born Like This"), "37% of the top is not a deep cut");
});

test("skipped and already-shown releases never return; no release appears twice", () => {
  const p = pools();
  p.skipped.add("doom-Mm..Food");
  const f = compose(p);
  const all = [...f.like, ...f.same, ...f.deep].map((c) => c.mbid);
  assert.ok(!all.includes("doom-Mm..Food"));
  assert.equal(new Set(all).size, all.length);
});

test("weekly pool mixes feeds with at most two per artist", () => {
  const w = weeklyPool(compose(pools()));
  const per = new Map<string, number>();
  for (const c of w) per.set(c.artistMbid, (per.get(c.artistMbid) ?? 0) + 1);
  assert.ok([...per.values()].every((n) => n <= 2));
  assert.ok(w.every((c) => c.feed === "weekly"));
});

const cands = (): Candidate[] => compose(pools()).like;

test("AI answers are accepted only as indices into the given list", () => {
  const c = cands();
  const picks = acceptPicks({ picks: [{ i: 1, reason: "Close kin of what you keep." }, { i: 7, reason: "invented" }, { i: 1, reason: "dup" }, { i: "0" }, { i: 0, reason: "" }] }, c, 5);
  assert.deepEqual(picks.map((p) => p.c.mbid), [c[1]!.mbid, c[0]!.mbid]);
  assert.equal(picks[0]!.reason, "Close kin of what you keep.");
  assert.ok(picks[1]!.reason.length > 8, "an empty reason falls back to a template");
});

test("garbage from the model yields nothing (and the caller falls back)", () => {
  assert.deepEqual(acceptPicks("nope", cands(), 5), []);
  assert.deepEqual(acceptPicks({ picks: "x" }, cands(), 5), []);
  assert.equal(fallback(cands(), 1).length, 1);
});

test("reasons are one line and capped", () => {
  assert.equal(cleanReason("  “Two\nlines”  "), "Two lines");
  assert.ok(cleanReason("x".repeat(400))!.length <= 120);
  assert.equal(cleanReason("short"), null);
});

test("seek query is exact artist and title without bracketed noise", () => {
  assert.equal(seekQuery("MF DOOM", "Mm..Food (2004) [Remastered]"), "MF DOOM Mm..Food");
});

test("weekly runs next Monday 06:00 UTC", () => {
  const sun = Date.UTC(2026, 9, 11, 12); // Sunday
  assert.equal(new Date(nextWeekly(sun)).toISOString(), "2026-10-12T06:00:00.000Z");
  const monLate = Date.UTC(2026, 9, 12, 7);
  assert.equal(new Date(nextWeekly(monLate)).toISOString(), "2026-10-19T06:00:00.000Z");
});

test("secondary types: live sets and compilations are not wanted", async () => {
  const { wanted } = await import("../src/beyond/pick.ts");
  assert.equal(wanted(""), true);
  assert.equal(wanted(null), true);
  assert.equal(wanted("Live"), false);
  assert.equal(wanted("Compilation,Live"), false);
  assert.equal(wanted("Remix"), true);
  assert.equal(wanted("Soundtrack"), true);
});
