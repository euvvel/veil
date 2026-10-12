// Ranking and rendering of search results (docs/DECISIONS.md D5). Pure, unit-tested.

import type { Fmt, Folder } from "./protocol.ts";

export const AUDIO = new Set(["flac", "mp3", "m4a", "ogg", "opus", "wav", "aac", "alac"]);
export const PAGE = 8; // bot page size
export const MAX_ITEMS = 400; // ranked items kept per view (bounded Hub storage)

export interface Prefs {
  format: Fmt;
  max_mb: number;
  fallback: boolean;
}

export interface TrackItem {
  kind: "t";
  u: string;
  path: string;
  size: number;
  ext: string;
  br: number | null;
  bd: number | null;
  sr: number | null;
  len: number | null;
  free: boolean;
  q: number;
  s: number;
  score: number;
  oversize: boolean;
}

export interface AlbumItem {
  kind: "a";
  u: string;
  d: string;
  files: { path: string; size: number; ext: string }[];
  size: number;
  exts: string[];
  free: boolean;
  q: number;
  s: number;
  score: number;
  oversize: boolean;
}

export type Item = TrackItem | AlbumItem;
export type View = "t" | "a";

export const basename = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;
export const dirname = (p: string) => basename(p.replace(/\\/g, "/").split("/").slice(0, -1).join("/") || p);

const matches = (ext: string, fmt: Fmt) => (fmt === "any" ? AUDIO.has(ext) : ext === fmt);

/** Peer reliability in [0,1]; unknown peers sit at 0.5. */
export const peerScore = (ok: number, fail: number) => (ok + 1) / (ok + fail + 2);

function compare(a: Item, b: Item): number {
  return (
    Number(a.oversize) - Number(b.oversize) ||
    Number(b.free) - Number(a.free) ||
    b.score - a.score ||
    a.q - b.q ||
    b.s - a.s
  );
}

function tracksFor(folders: Folder[], fmt: Fmt, maxBytes: number, scores: Map<string, number>): TrackItem[] {
  const out: TrackItem[] = [];
  for (const f of folders) {
    for (const [path, size, ext, br, bd, sr, len] of f.files) {
      if (!matches(ext, fmt)) continue;
      out.push({
        kind: "t", u: f.u, path, size, ext, br, bd, sr, len,
        free: f.f, q: f.q, s: f.s, score: scores.get(f.u) ?? 0.5, oversize: size > maxBytes,
      });
    }
  }
  return out;
}

/** Keep the best-ranked copy of identical files (same name and size) offered by many peers. */
function dedupe<T extends Item>(items: T[], key: (i: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(key(i)) ? false : (seen.add(key(i)), true)));
}

export interface Ranked {
  items: Item[];
  total: number;
  note?: string;
}

export function rank(folders: Folder[], view: View, fmt: Fmt, prefs: Prefs, scores: Map<string, number>): Ranked {
  const maxBytes = prefs.max_mb * 1024 * 1024;

  if (view === "a") {
    const albums: AlbumItem[] = [];
    for (const f of folders) {
      const files = f.files.filter(([, , ext]) => matches(ext, fmt)).map(([path, size, ext]) => ({ path, size, ext }));
      if (files.length < 2) continue;
      albums.push({
        kind: "a", u: f.u, d: f.d, files, size: files.reduce((n, x) => n + x.size, 0),
        exts: [...new Set(files.map((x) => x.ext))], free: f.f, q: f.q, s: f.s,
        score: scores.get(f.u) ?? 0.5, oversize: files.some((x) => x.size > maxBytes),
      });
    }
    const sorted = dedupe(albums.sort(compare), (a) => `${dirname(a.d + "/x")}|${a.files.length}|${a.size}`);
    return { items: sorted.slice(0, MAX_ITEMS), total: sorted.length };
  }

  let tracks = tracksFor(folders, fmt, maxBytes, scores).sort(compare);
  let note: string | undefined;

  if (fmt === "flac" && prefs.fallback && !tracks.some((t) => !t.oversize)) {
    const mp3 = tracksFor(folders, "mp3", maxBytes, scores).filter((t) => (t.br ?? 0) >= 320 && !t.oversize).sort(compare);
    if (mp3.length) {
      note = `No FLAC under ${prefs.max_mb} MB, so MP3 320 comes first`;
      tracks = [...mp3, ...tracks];
    }
  }

  const unique = dedupe(tracks, (t) => `${basename(t.path).toLowerCase()}|${t.size}`);
  return { items: unique.slice(0, MAX_ITEMS), total: unique.length, note };
}

// ---- rendering (plain text, no parse_mode, so nothing needs escaping) ----

export const mb = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);
const mmss = (s: number | null) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "");
const FMT_LABEL: Record<Fmt, string> = { flac: "FLAC", mp3: "MP3", any: "Any" };

function quality(t: TrackItem): string {
  if (t.ext === "flac") return t.bd && t.sr ? `FLAC ${t.bd}/${+(t.sr / 1000).toFixed(1)}` : "FLAC";
  return `${t.ext.toUpperCase()}${t.br ? ` ${t.br}` : ""}`;
}

/** Name and one-line detail for the mini app (no peer names). */
export function describe(i: Item): { name: string; detail: string } {
  const slot = i.free ? "free" : `queue ${i.q}`;
  if (i.kind === "t") return { name: basename(i.path), detail: [quality(i), mb(i.size), mmss(i.len), slot].filter(Boolean).join(" · ") };
  return {
    name: dirname(i.d + "/x"),
    detail: [`${i.files.length} files`, i.exts.map((e) => e.toUpperCase()).join("/"), mb(i.size), slot].join(" · "),
  };
}

export function line(i: Item, n: number, maxUploadMb: number, direct = false): string {
  const slot = i.free ? "free" : `queue ${i.q}`;
  const big = (size: number) => size > maxUploadMb * 1024 * 1024;
  const over = direct ? "direct" : "too large for now";
  if (i.kind === "t") {
    const bits = [quality(i), mb(i.size), mmss(i.len), slot].filter(Boolean).join(" · ");
    return `${n}. ${basename(i.path)}\n    ${bits}${big(i.size) ? ` · ${over}` : ""}`;
  }
  const many = i.files.filter((f) => big(f.size)).length;
  const bits = [`${i.files.length} files`, i.exts.map((e) => e.toUpperCase()).join("/"), mb(i.size), slot].join(" · ");
  return `${n}. ${dirname(i.d + "/x")}\n    ${bits}${many ? ` · ${many} ${over}` : ""}`;
}

export interface Rendered {
  text: string;
  reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
}

export interface Counts {
  tracks: number;
  albums: number;
}

export const pages = (total: number, size = PAGE) => Math.max(1, Math.ceil(total / size));

export function render(
  sid: string, query: string, view: View, fmt: Fmt, r: Ranked, maxUploadMb: number,
  page = 0, counts?: Counts, direct = false,
): Rendered {
  const shown = r.items.length;
  const last = pages(shown) - 1;
  const p = Math.min(Math.max(0, page), last);
  const slice = r.items.slice(p * PAGE, p * PAGE + PAGE);
  const tally = counts ? `${counts.tracks} tracks · ${counts.albums} albums` : `${r.total} ${view === "t" ? "tracks" : "albums"}`;
  const head = `Seek · ${query}\n${FMT_LABEL[fmt]} · ${view === "t" ? "tracks" : "albums"} · ${tally}`;
  const body = slice.length
    ? slice.map((i, n) => line(i, p * PAGE + n + 1, maxUploadMb, direct)).join("\n")
    : "Nothing answered from beyond.";
  const text = [head, r.note, "", body].filter((x) => x !== undefined).join("\n");

  const nums = slice.map((_, n) => ({ text: `${p * PAGE + n + 1}`, callback_data: `s:${sid}:d:${p * PAGE + n}` }));
  const rows = [nums.slice(0, 4), nums.slice(4, 8)].filter((row) => row.length);
  if (last > 0) {
    rows.push([
      { text: p > 0 ? "◀" : "·", callback_data: p > 0 ? `s:${sid}:p:${p - 1}` : `s:${sid}:n:0` },
      { text: `${p + 1} / ${last + 1}`, callback_data: `s:${sid}:n:0` },
      { text: p < last ? "▶" : "·", callback_data: p < last ? `s:${sid}:p:${p + 1}` : `s:${sid}:n:0` },
    ]);
  }
  const tick = (on: boolean, label: string) => (on ? `· ${label} ·` : label);
  rows.push((["flac", "mp3", "any"] as Fmt[]).map((f) => ({ text: tick(f === fmt, FMT_LABEL[f]), callback_data: `s:${sid}:f:${f}` })));
  rows.push([
    { text: tick(view === "t", "Tracks"), callback_data: `s:${sid}:v:t` },
    { text: tick(view === "a", "Albums"), callback_data: `s:${sid}:v:a` },
  ]);
  return { text, reply_markup: { inline_keyboard: rows } };
}

/** Both views' sizes for a format, for headers like "312 tracks · 41 albums". */
export function counts(folders: Folder[], fmt: Fmt, prefs: Prefs): Counts {
  return { tracks: rank(folders, "t", fmt, prefs, new Map()).total, albums: rank(folders, "a", fmt, prefs, new Map()).total };
}
