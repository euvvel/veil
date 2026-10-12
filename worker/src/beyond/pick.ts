// Beyond: turn what crossed into candidate suggestions. Pure and unit-tested; no I/O.
// Every candidate is a MusicBrainz release group (from ListenBrainz data); the Seer verifies each one
// with a MusicBrainz lookup before it is shown (docs/DECISIONS.md D11).

export type Feed = "weekly" | "like" | "same" | "deep" | "hole";

/** A release group as ListenBrainz's popularity API describes it. */
export interface RG {
  mbid: string;
  title: string;
  year: number | null;
  kind: string; // Album | EP | Single | …
  listens: number;
  artist: string;
  artistMbid: string;
  cover: string | null; // release MBID for Cover Art Archive
}

export interface Seed {
  name: string;
  mbid: string;
  weight: number; // affinity: crossings, taps, minus skips, decayed by age
  crossed: number; // tracks of theirs that crossed
  albums: string[]; // normalised album titles already crossed
}

export interface Similar {
  mbid: string;
  name: string;
  score: number; // aggregated similarity, 0..1
  via: string; // the seed it is most similar to
}

export interface Candidate extends RG {
  feed: Feed;
  facts: string; // plain facts handed to the ranker; never invented
  base: number; // heuristic score, used when the ranker is unavailable
}

/** MusicBrainz secondary types that do not belong in suggestions (live sets, bootleg-ish compilations, …). */
export const UNWANTED = new Set(["Live", "Compilation", "DJ-mix", "Mixtape/Street", "Demo", "Interview", "Spokenword", "Audiobook", "Audio drama", "Field recording"]);
export const wanted = (types: string | null | undefined) => !(types ?? "").split(",").some((t) => UNWANTED.has(t.trim()));

export const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const FULL = new Set(["Album", "EP"]);
const isFull = (rg: RG) => FULL.has(rg.kind);

export interface Pools {
  seeds: Seed[];
  seedRGs: Map<string, RG[]>; // by artist MBID
  similar: Similar[];
  similarRGs: Map<string, RG[]>; // by artist MBID
  skipped: Set<string>; // release-group MBIDs the member skipped
  shown: Set<string>; // already suggested and tapped or crossed
}

export interface Feeds {
  like: Candidate[];
  same: Candidate[];
  deep: Candidate[];
}

const PER_FEED = 24; // candidates handed to the ranker per feed

/** Aggregate similar artists across seeds, weighting by seed affinity; drop the seeds themselves. */
export function mergeSimilar(lists: { seed: Seed; artists: { mbid: string; name: string; score: number }[] }[], seeds: Seed[]): Similar[] {
  const seedIds = new Set(seeds.map((s) => s.mbid));
  const best = new Map<string, Similar>();
  for (const { seed, artists } of lists) {
    const top = Math.max(1, ...artists.map((a) => a.score));
    for (const a of artists) {
      if (seedIds.has(a.mbid)) continue;
      const score = (a.score / top) * seed.weight;
      const prev = best.get(a.mbid);
      if (!prev) best.set(a.mbid, { mbid: a.mbid, name: a.name, score, via: seed.name });
      else best.set(a.mbid, { ...prev, score: prev.score + score, via: score > prev.score ? seed.name : prev.via });
    }
  }
  const all = [...best.values()];
  const max = Math.max(1e-9, ...all.map((s) => s.score));
  return all.map((s) => ({ ...s, score: s.score / max })).sort((a, b) => b.score - a.score);
}

export function compose(p: Pools): Feeds {
  const taken = new Set<string>([...p.skipped, ...p.shown]);
  const take = (c: Candidate, into: Candidate[]) => {
    if (taken.has(c.mbid)) return;
    taken.add(c.mbid);
    into.push(c);
  };
  const same: Candidate[] = [];
  const like: Candidate[] = [];
  const deep: Candidate[] = [];

  // From the same hand: well-known albums/EPs by artists you have, minus what already crossed.
  for (const s of [...p.seeds].sort((a, b) => b.weight - a.weight)) {
    const rgs = (p.seedRGs.get(s.mbid) ?? []).filter(isFull).filter((rg) => !s.albums.includes(norm(rg.title)));
    for (const rg of rgs.sort((a, b) => b.listens - a.listens).slice(0, 3)) {
      take({ ...rg, feed: "same", base: s.weight * Math.log10(rg.listens + 10),
        facts: `${s.crossed} of ${s.name}'s tracks crossed to the listener; this ${rg.kind.toLowerCase()} has ${rg.listens} listens` }, same);
    }
  }

  // More like this: the best-known record of each similar artist.
  for (const a of p.similar.slice(0, 16)) {
    const rgs = (p.similarRGs.get(a.mbid) ?? []).filter(isFull).sort((x, y) => y.listens - x.listens);
    for (const rg of rgs.slice(0, 1)) {
      take({ ...rg, feed: "like", base: a.score * Math.log10(rg.listens + 10),
        facts: `${a.name} is similar to ${a.via} (similarity ${a.score.toFixed(2)}), whom the listener keeps; their best-known ${rg.kind.toLowerCase()}` }, like);
    }
  }

  // Deep cuts: quieter records (1–15% of the artist's best-known), near what you keep.
  const quiet = (rgs: RG[]) => {
    const full = rgs.filter(isFull);
    const top = Math.max(0, ...full.map((r) => r.listens));
    return full.filter((r) => r.listens >= 30 && r.listens <= top * 0.15 && r.listens >= top * 0.01).map((r) => ({ rg: r, top }));
  };
  for (const a of p.similar.slice(0, 16)) {
    for (const { rg, top } of quiet(p.similarRGs.get(a.mbid) ?? []).slice(0, 2)) {
      take({ ...rg, feed: "deep", base: a.score * (1 - rg.listens / Math.max(1, top)),
        facts: `a quieter record by ${a.name} (${rg.listens} listens, against ${top} for their best-known), near ${a.via}` }, deep);
    }
  }
  for (const s of p.seeds) {
    for (const { rg, top } of quiet(p.seedRGs.get(s.mbid) ?? []).filter(({ rg }) => !s.albums.includes(norm(rg.title))).slice(0, 1)) {
      take({ ...rg, feed: "deep", base: s.weight * 0.5,
        facts: `a quieter record by ${s.name} (${rg.listens} listens, against ${top} for their best-known); ${s.crossed} of their tracks crossed` }, deep);
    }
  }

  const bySeed = (xs: Candidate[]) => xs.sort((a, b) => b.base - a.base).slice(0, PER_FEED);
  return { like: bySeed(like), same: bySeed(same), deep: bySeed(deep) };
}

/** This week's veil: a varied draw from all feeds, at most two per artist. */
export function weeklyPool(f: Feeds, size = 24): Candidate[] {
  const out: Candidate[] = [];
  const perArtist = new Map<string, number>();
  const queues = [f.like, f.same, f.deep].map((q) => [...q]);
  while (out.length < size && queues.some((q) => q.length)) {
    for (const q of queues) {
      const c = q.shift();
      if (!c) continue;
      const n = perArtist.get(c.artistMbid) ?? 0;
      if (n >= 2) continue;
      perArtist.set(c.artistMbid, n + 1);
      out.push({ ...c, feed: "weekly" });
    }
  }
  return out;
}

/** Search words for a suggestion: exact artist and title, without bracketed noise. */
export const seekQuery = (artist: string, title: string) =>
  `${artist} ${title}`.replace(/\(.*?\)|\[.*?\]/g, " ").replace(/\s+/g, " ").trim();
