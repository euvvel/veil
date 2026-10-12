// ListenBrainz and MusicBrainz, as probed live on 2026-10-12 (docs/LIMITS.md).
// MusicBrainz: ≤ 1 request/s per IP and a contact User-Agent (musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting).

import type { RG } from "./pick.ts";

export const UA = "veil/0.5 ( https://github.com/euvvel/veil )";
const LB = "https://api.listenbrainz.org/1";
const LB_LABS = "https://labs.api.listenbrainz.org";
const MB = "https://musicbrainz.org/ws/2";
export const SIMILAR_ALGO = "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30";

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Similar artists (ListenBrainz labs): [{ artist_mbid, name, score, … }]. */
export async function similarArtists(mbid: string): Promise<{ mbid: string; name: string; score: number }[] | null> {
  const d = await getJson<{ artist_mbid: string; name: string; score: number }[]>(
    `${LB_LABS}/similar-artists/json?artist_mbids=${mbid}&algorithm=${SIMILAR_ALGO}`,
  );
  return d ? d.slice(0, 30).map((a) => ({ mbid: a.artist_mbid, name: a.name, score: a.score })) : null;
}

interface LbRg {
  release_group_mbid: string;
  total_listen_count: number;
  release_group?: { name?: string; date?: string; type?: string; caa_release_mbid?: string };
  release?: { caa_release_mbid?: string };
  artist?: { name?: string };
}

/** An artist's release groups with listen counts (ListenBrainz popularity). */
export async function topReleaseGroups(mbid: string, fallbackName: string): Promise<RG[] | null> {
  const d = await getJson<LbRg[]>(`${LB}/popularity/top-release-groups-for-artist/${mbid}`);
  if (!d) return null;
  return d.slice(0, 80).map((x) => {
    const year = Number((x.release_group?.date ?? "").slice(0, 4));
    return {
      mbid: x.release_group_mbid,
      title: x.release_group?.name ?? "",
      year: Number.isFinite(year) && year > 0 ? year : null,
      kind: x.release_group?.type ?? "",
      listens: x.total_listen_count ?? 0,
      artist: x.artist?.name ?? fallbackName,
      artistMbid: mbid,
      cover: x.release_group?.caa_release_mbid ?? x.release?.caa_release_mbid ?? null,
    };
  }).filter((r) => r.mbid && r.title);
}

/** MusicBrainz artist search: a confident match only (score ≥ 90 and the same name, normalised). */
export async function findArtist(name: string, same: (a: string, b: string) => boolean): Promise<{ mbid: string; name: string } | null> {
  const q = encodeURIComponent(`artist:"${name.replace(/"/g, "")}"`);
  const d = await getJson<{ artists?: { id: string; name: string; score: number }[] }>(`${MB}/artist?query=${q}&limit=5&fmt=json`);
  const hit = d?.artists?.find((a) => a.score >= 90 && same(a.name, name));
  return hit ? { mbid: hit.id, name: hit.name } : null;
}

/** MusicBrainz release-group lookup: the verification every suggestion must pass. */
export async function lookupReleaseGroup(mbid: string): Promise<{ ok: boolean; title?: string; types?: string[] } | null> {
  try {
    const res = await fetch(`${MB}/release-group/${mbid}?fmt=json`, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (res.status === 404 || res.status === 400) return { ok: false };
    if (!res.ok) return null; // 503 (rate) or outage: try again later
    const d = (await res.json()) as { id?: string; title?: string; "secondary-types"?: string[] };
    return { ok: d.id === mbid, title: d.title, types: d["secondary-types"] ?? [] };
  } catch {
    return null;
  }
}
