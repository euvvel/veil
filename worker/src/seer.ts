// The Seer: one Durable Object per member that gathers Beyond's feeds in small, alarm-driven steps
// (each step stays far below the per-invocation request limits), so opening Beyond never waits.
//
//   seeds → expand → similar → compose (AI ranks) → verify (MusicBrainz, ≤ 1 req/s) → store
//
// Every stored suggestion is a release group confirmed by a MusicBrainz lookup (D11).

import { DurableObject } from "cloudflare:workers";
import { rank, type Pick } from "./beyond/ai.ts";
import { findArtist, lookupReleaseGroup, similarArtists, topReleaseGroups } from "./beyond/apis.ts";
import { nextWeekly } from "./beyond/schedule.ts";
import { compose, mergeSimilar, norm, wanted, weeklyPool, type Candidate, type Feed, type RG, type Seed, type Similar } from "./beyond/pick.ts";
import { randomHex } from "./crypto.ts";
import type { Env } from "./env.ts";

type Phase = "idle" | "seeds" | "expand" | "similar" | "compose" | "verify" | "store";

interface Job {
  member: string;
  phase: Phase;
  weekly: boolean;
  seeds: Seed[];
  seedRGs: Record<string, RG[]>;
  simLists: { seed: string; artists: { mbid: string; name: string; score: number }[] }[];
  similar: Similar[];
  similarRGs: Record<string, RG[]>;
  picks: Partial<Record<Feed, { c: Candidate; reason: string }[]>>;
  by: "ai" | "plain";
}

export interface SeerStatus {
  phase: Phase;
  builtAt: number | null;
  weeklyAt: number | null;
  by: "ai" | "plain" | null;
  empty: boolean;
}

const PER_FEED = 12;
const SEEDS = 5;
const SIMILAR = 12;
const VERIFY_PER_STEP = 20;
const MB_GAP_MS = 1100;
const WEEK_MS = 7 * 24 * 3600_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Seer extends DurableObject<Env> {
  private lastMb = 0;

  private async mbTurn(): Promise<void> {
    const wait = this.lastMb + MB_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastMb = Date.now();
  }

  private async job(): Promise<Job | undefined> {
    return this.ctx.storage.get<Job>("job");
  }

  async status(): Promise<SeerStatus> {
    const j = await this.job();
    return {
      phase: j?.phase ?? "idle",
      builtAt: (await this.ctx.storage.get<number>("builtAt")) ?? null,
      weeklyAt: (await this.ctx.storage.get<number>("weeklyAt")) ?? null,
      by: (await this.ctx.storage.get<"ai" | "plain">("by")) ?? null,
      empty: Boolean(await this.ctx.storage.get<boolean>("empty")),
    };
  }

  /** Ask for a rebuild in `delayMs` (debounced: an earlier pending build wins). */
  async kick(member: string, delayMs: number, weekly = false): Promise<void> {
    await this.ctx.storage.put("member", member);
    const j = await this.job();
    if (j && j.phase !== "idle") {
      if (weekly && !j.weekly) await this.ctx.storage.put("job", { ...j, weekly: true });
      return; // already building
    }
    const at = Date.now() + delayMs;
    const pending = await this.ctx.storage.get<number>("pendingAt");
    if (pending && pending <= at && !weekly) return;
    await this.ctx.storage.put("pendingAt", at);
    if (weekly) await this.ctx.storage.put("pendingWeekly", true);
    await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    let j = await this.job();
    const member = await this.ctx.storage.get<string>("member");
    if (!member) return;
    if (!j || j.phase === "idle") {
      const weeklyAt = (await this.ctx.storage.get<number>("weeklyAt")) ?? 0;
      const weekly = Boolean(await this.ctx.storage.get<boolean>("pendingWeekly")) || Date.now() - weeklyAt > WEEK_MS - 3600_000;
      j = { member, phase: "seeds", weekly, seeds: [], seedRGs: {}, simLists: [], similar: [], similarRGs: {}, picks: {}, by: "plain" };
      await this.ctx.storage.delete(["pendingAt", "pendingWeekly"]);
    }
    try {
      const next = await this.step(j);
      await this.ctx.storage.put("job", next);
      if (next.phase !== "idle") await this.ctx.storage.setAlarm(Date.now() + 500);
      else await this.ctx.storage.setAlarm(nextWeekly(Date.now()));
    } catch (e) {
      // A failed step is retried a little later; the job keeps its place.
      console.log(JSON.stringify({ at: "seer", phase: j.phase, error: String(e).slice(0, 200) }));
      await this.ctx.storage.put("job", j);
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  private async step(j: Job): Promise<Job> {
    switch (j.phase) {
      case "seeds":
        return this.seeds(j);
      case "expand":
        return this.expand(j);
      case "similar":
        return this.similarStep(j);
      case "compose":
        return this.composeStep(j);
      case "verify":
        return this.verify(j);
      case "store":
        return this.store(j);
      default:
        return j;
    }
  }

  /** Seeds: the artists you keep, weighted by how much and how recently, minus what you skipped. */
  private async seeds(j: Job): Promise<Job> {
    const db = this.env.DB;
    const { results } = await db.prepare(
      `SELECT t.artist AS artist, COUNT(*) AS n, MAX(j.updated_at) AS last, group_concat(t.album, '\u001f') AS albums
       FROM jobs j JOIN tracks t ON t.id = j.track_id
       WHERE j.user_id = ? AND j.state = 'delivered' AND t.artist IS NOT NULL AND t.artist != ''
       GROUP BY lower(t.artist) ORDER BY last DESC LIMIT 40`,
    ).bind(j.member).all<{ artist: string; n: number; last: number; albums: string | null }>();
    const skips = await db.prepare(
      "SELECT lower(artist) AS a, COUNT(*) AS n FROM suggestions WHERE user_id = ? AND outcome = 'skipped' GROUP BY lower(artist)",
    ).bind(j.member).all<{ a: string; n: number }>();
    const skipBy = new Map(skips.results.map((r) => [r.a, r.n]));
    const now = Date.now();
    const ranked = results
      .map((r) => ({ ...r, weight: r.n * 0.5 ** ((now - r.last) / (30 * 24 * 3600_000)) - 0.7 * (skipBy.get(r.artist.toLowerCase()) ?? 0) }))
      .filter((r) => r.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, SEEDS);
    if (!ranked.length) {
      await this.ctx.storage.put("empty", true);
      return { ...j, phase: "idle" };
    }
    await this.ctx.storage.put("empty", false);

    const seeds: Seed[] = [];
    for (const r of ranked) {
      const key = norm(r.artist);
      let known = await db.prepare("SELECT mbid, name FROM artists WHERE name_norm = ?").bind(key).first<{ mbid: string | null; name: string | null }>();
      if (!known) {
        await this.mbTurn();
        const hit = await findArtist(r.artist, (a, b) => norm(a) === norm(b));
        known = { mbid: hit?.mbid ?? null, name: hit?.name ?? r.artist };
        await db.prepare("INSERT OR REPLACE INTO artists (name_norm, mbid, name, checked_at) VALUES (?, ?, ?, ?)").bind(key, known.mbid, known.name, now).run();
      }
      if (!known.mbid) continue;
      const albums = (r.albums ?? "").split("\u001f").filter(Boolean).map(norm);
      seeds.push({ name: known.name ?? r.artist, mbid: known.mbid, weight: r.weight, crossed: r.n, albums: [...new Set(albums)] });
    }
    if (!seeds.length) {
      await this.ctx.storage.put("empty", true);
      return { ...j, phase: "idle" };
    }
    return { ...j, seeds, phase: "expand" };
  }

  /** Expand: each seed's release groups and similar artists (ListenBrainz). */
  private async expand(j: Job): Promise<Job> {
    const seedRGs: Record<string, RG[]> = {};
    const simLists: Job["simLists"] = [];
    for (const s of j.seeds) {
      const [rgs, sims] = await Promise.all([topReleaseGroups(s.mbid, s.name), similarArtists(s.mbid)]);
      seedRGs[s.mbid] = (rgs ?? []).slice(0, 40);
      if (sims) simLists.push({ seed: s.mbid, artists: sims });
    }
    return { ...j, seedRGs, simLists, phase: "similar" };
  }

  /** Similar: merge across seeds, then each similar artist's release groups. */
  private async similarStep(j: Job): Promise<Job> {
    const bySeed = new Map(j.seeds.map((s) => [s.mbid, s]));
    const lists = j.simLists.flatMap((l) => (bySeed.get(l.seed) ? [{ seed: bySeed.get(l.seed)!, artists: l.artists }] : []));
    const similar = mergeSimilar(lists, j.seeds).slice(0, SIMILAR);
    const similarRGs: Record<string, RG[]> = {};
    for (const a of similar) similarRGs[a.mbid] = ((await topReleaseGroups(a.mbid, a.name)) ?? []).slice(0, 40);
    return { ...j, similar, similarRGs, phase: "compose" };
  }

  /** Compose candidates, then let the AI rank and explain (or fall back to the plain order). */
  private async composeStep(j: Job): Promise<Job> {
    const db = this.env.DB;
    const { results } = await db.prepare("SELECT mbid, outcome FROM suggestions WHERE user_id = ? AND outcome IS NOT NULL").bind(j.member).all<{ mbid: string; outcome: string }>();
    const feeds = compose({
      seeds: j.seeds,
      seedRGs: new Map(Object.entries(j.seedRGs)),
      similar: j.similar,
      similarRGs: new Map(Object.entries(j.similarRGs)),
      skipped: new Set(results.filter((r) => r.outcome === "skipped").map((r) => r.mbid)),
      shown: new Set(results.filter((r) => r.outcome !== "skipped").map((r) => r.mbid)),
    });
    const picks: Job["picks"] = {};
    let ai = false;
    for (const feed of ["like", "same", "deep"] as const) {
      const r = await rank(this.env.AI, feed, feeds[feed], PER_FEED);
      picks[feed] = r.picks;
      ai ||= r.by === "ai";
    }
    if (j.weekly) {
      const r = await rank(this.env.AI, "weekly", weeklyPool(feeds), PER_FEED);
      picks.weekly = r.picks;
      ai ||= r.by === "ai";
    }
    return { ...j, picks, by: ai ? "ai" : "plain", phase: "verify" };
  }

  private allPicks(j: Job): Pick[] {
    return Object.values(j.picks).flatMap((x) => x ?? []);
  }

  /** Verify: a MusicBrainz lookup for every release group not confirmed before (≤ 1 request/s). */
  private async verify(j: Job): Promise<Job> {
    const db = this.env.DB;
    const ids = [...new Set(this.allPicks(j).map((p) => p.c.mbid))];
    const known = new Set<string>();
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      const { results } = await db.prepare(`SELECT mbid FROM verified WHERE mbid IN (${part.map(() => "?").join(",")})`).bind(...part).all<{ mbid: string }>();
      for (const r of results) known.add(r.mbid);
    }
    const todo = ids.filter((id) => !known.has(id)).slice(0, VERIFY_PER_STEP);
    const rows: { mbid: string; ok: number; title: string | null; types: string }[] = [];
    for (const id of todo) {
      await this.mbTurn();
      const r = await lookupReleaseGroup(id);
      if (r) rows.push({ mbid: id, ok: r.ok ? 1 : 0, title: r.title ?? null, types: (r.types ?? []).join(",") });
    }
    if (rows.length) {
      await db.prepare(
        `INSERT OR REPLACE INTO verified (mbid, ok, title, types, checked_at)
         SELECT json_extract(value, '$.mbid'), json_extract(value, '$.ok'), json_extract(value, '$.title'), json_extract(value, '$.types'), ?
         FROM json_each(?)`,
      ).bind(Date.now(), JSON.stringify(rows)).run();
    }
    const remaining = ids.filter((id) => !known.has(id) && !rows.some((r) => r.mbid === id)).length;
    return { ...j, phase: remaining > 0 && rows.length > 0 ? "verify" : "store" };
  }

  /** Store: keep only verified picks; replace the member's open suggestions in the rebuilt feeds. */
  private async store(j: Job): Promise<Job> {
    const db = this.env.DB;
    const ids = [...new Set(this.allPicks(j).map((p) => p.c.mbid))];
    const ok = new Set<string>();
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      const { results } = await db.prepare(`SELECT mbid, types FROM verified WHERE ok = 1 AND mbid IN (${part.map(() => "?").join(",")})`)
        .bind(...part).all<{ mbid: string; types: string | null }>();
      for (const r of results) if (wanted(r.types)) ok.add(r.mbid);
    }
    const now = Date.now();
    const rows = (Object.entries(j.picks) as [Feed, Pick[]][]).flatMap(([feed, picks]) =>
      picks.filter((p) => ok.has(p.c.mbid)).map((p, rank) => ({
        id: randomHex(6), feed, mbid: p.c.mbid, artist: p.c.artist, artist_mbid: p.c.artistMbid, title: p.c.title, year: p.c.year,
        kind: p.c.kind, cover: p.c.cover, reason: p.reason, score: p.c.base, rank,
      })),
    );
    const feeds = Object.keys(j.picks);
    await db.batch([
      db.prepare(`DELETE FROM suggestions WHERE user_id = ? AND outcome IS NULL AND feed IN (${feeds.map(() => "?").join(",")})`).bind(j.member, ...feeds),
      db.prepare(
        `INSERT INTO suggestions (id, user_id, feed, mbid, artist, artist_mbid, title, year, kind, cover, reason, score, rank, created_at)
         SELECT json_extract(value,'$.id'), ?, json_extract(value,'$.feed'), json_extract(value,'$.mbid'), json_extract(value,'$.artist'),
                json_extract(value,'$.artist_mbid'), json_extract(value,'$.title'), json_extract(value,'$.year'), json_extract(value,'$.kind'),
                json_extract(value,'$.cover'), json_extract(value,'$.reason'), json_extract(value,'$.score'), json_extract(value,'$.rank'), ?
         FROM json_each(?)`,
      ).bind(j.member, now, JSON.stringify(rows)),
    ]);
    await this.ctx.storage.put({ builtAt: now, by: j.by });
    if (j.picks.weekly) await this.ctx.storage.put("weeklyAt", now);
    console.log(JSON.stringify({ at: "seer", built: rows.length, by: j.by, weekly: Boolean(j.picks.weekly) }));
    return { ...j, phase: "idle", seedRGs: {}, similarRGs: {}, simLists: [], picks: {} };
  }

  /** Rabbit hole: walk outward from an artist, one verified record per step. Runs on demand. */
  async hole(member: string, start: { mbid?: string; name: string }, steps = 4): Promise<number> {
    const db = this.env.DB;
    let mbid = start.mbid;
    if (!mbid) {
      await this.mbTurn();
      mbid = (await findArtist(start.name, (a, b) => norm(a) === norm(b)))?.mbid;
    }
    if (!mbid) return 0;
    const { results: kept } = await db.prepare("SELECT mbid FROM suggestions WHERE user_id = ? AND outcome IS NOT NULL").bind(member).all<{ mbid: string }>();
    const avoid = new Set(kept.map((r) => r.mbid));
    const visited = new Set([mbid]);
    let here = { mbid, name: start.name };
    const rows: Record<string, unknown>[] = [];
    for (let step = 1; step <= steps; step++) {
      const sims = (await similarArtists(here.mbid)) ?? [];
      const next = sims.find((a) => !visited.has(a.mbid));
      if (!next) break;
      visited.add(next.mbid);
      const rgs = ((await topReleaseGroups(next.mbid, next.name)) ?? []).filter((r) => (r.kind === "Album" || r.kind === "EP") && !avoid.has(r.mbid));
      const rg = rgs.sort((a, b) => b.listens - a.listens)[0];
      if (rg) {
        await this.mbTurn();
        const v = await lookupReleaseGroup(rg.mbid);
        if (v?.ok && wanted((v.types ?? []).join(","))) {
          rows.push({ id: randomHex(6), feed: "hole", mbid: rg.mbid, artist: rg.artist, artist_mbid: next.mbid, title: rg.title, year: rg.year,
            kind: rg.kind, cover: rg.cover, reason: `Step ${step}: ${next.name}, close to ${here.name}.`, score: 0, rank: step - 1 });
        }
      }
      here = { mbid: next.mbid, name: next.name };
    }
    await db.batch([
      db.prepare("DELETE FROM suggestions WHERE user_id = ? AND feed = 'hole' AND outcome IS NULL").bind(member),
      db.prepare(
        `INSERT INTO suggestions (id, user_id, feed, mbid, artist, artist_mbid, title, year, kind, cover, reason, score, rank, created_at)
         SELECT json_extract(value,'$.id'), ?, 'hole', json_extract(value,'$.mbid'), json_extract(value,'$.artist'), json_extract(value,'$.artist_mbid'),
                json_extract(value,'$.title'), json_extract(value,'$.year'), json_extract(value,'$.kind'), json_extract(value,'$.cover'),
                json_extract(value,'$.reason'), 0, json_extract(value,'$.rank'), ? FROM json_each(?)`,
      ).bind(member, Date.now(), JSON.stringify(rows)),
    ]);
    return rows.length;
  }
}
