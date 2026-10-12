// API client. Every call carries the signed initData; the Worker answers 404 to anyone else.

import { tg } from "./tg.ts";

export type Fmt = "flac" | "mp3" | "any";
export type View = "t" | "a";
export type SessionState = "offline" | "booting" | "ready" | "draining";

export interface Prefs {
  format: Fmt;
  max_mb: number;
  fallback: boolean;
}
export interface Me {
  role: "admin" | "member";
  prefs: Prefs;
  session: { state: SessionState };
}
export interface Item {
  i: number;
  kind: View;
  name: string;
  detail: string;
  size: number;
  free: boolean;
  direct: boolean;
}
export interface SearchView {
  status: "pending" | "sent" | "done" | "gone";
  query: string;
  fmt: Fmt;
  view: View;
  total: number;
  note: string | null;
  items: Item[];
}
export interface Job {
  id: string;
  state: string;
  pct: number | null;
  place: number | null;
  error: string | null;
}
export interface Crossing {
  gid: string;
  name: string;
  text: string;
  jobs: Job[];
  done?: boolean;
}
export interface HistoryRow {
  name: string;
  format: string | null;
  at: number;
  artist: string | null;
  title: string | null;
  album: string | null;
}
export interface DirectFile {
  job: string;
  name: string;
  size: number;
  url: string;
}

// Outside Telegram (local preview only) initData can come from the hash, which never reaches a server log.
const initData = () => tg?.initData ?? new URLSearchParams(location.hash.slice(1)).get("tma") ?? "";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `tma ${initData()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) throw new Error("unknown");
  if (!res.ok) throw new Error(`http ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  me: () => call<Me>("GET", "/api/me"),
  prefs: (p: Partial<Prefs>) => call<Prefs>("PATCH", "/api/prefs", p),
  search: (query: string, fmt: Fmt) => call<{ sid: string; state: SessionState }>("POST", "/api/search", { query, fmt }),
  view: (sid: string, view?: View, fmt?: Fmt) =>
    call<SearchView>("GET", `/api/search/${sid}?${new URLSearchParams({ ...(view ? { view } : {}), ...(fmt ? { fmt } : {}) })}`),
  cross: (sid: string, index: number) => call<{ ok: boolean; error?: string; gid?: string }>("POST", "/api/cross", { sid, index }),
  crossings: () => call<{ active: Crossing[]; history: HistoryRow[] }>("GET", "/api/crossings"),
  direct: (gid: string) => call<DirectFile[]>("GET", `/api/direct/${gid}`),
  release: (job: string) => call<{ ok: boolean }>("POST", "/api/direct/release", { job }),
  ticket: () => call<{ t: string }>("POST", "/api/ticket"),
};

export type HubEvent =
  | { type: "session.state"; data: { state: SessionState } }
  | { type: "search.done"; data: { sid: string } }
  | { type: "crossing"; data: Crossing };

/** Live events from the Hub, reconnecting with backoff. Returns a stop function. */
export function live(onEvent: (e: HubEvent) => void): () => void {
  let ws: WebSocket | undefined;
  let stopped = false;
  let delay = 1000;
  const retry = () => {
    if (stopped) return;
    setTimeout(open, delay);
    delay = Math.min(delay * 2, 15000);
  };
  const open = async () => {
    // Trade the signed initData (sent in a header) for a single-use ticket; only the ticket goes in the URL.
    let t: string;
    try {
      t = (await api.ticket()).t;
    } catch {
      return retry();
    }
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/hub/app?t=${t}`);
    ws.onopen = () => (delay = 1000);
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data as string) as HubEvent);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = retry;
  };
  open();
  return () => {
    stopped = true;
    ws?.close();
  };
}

export const mb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);
