// The Hub: one Durable Object that owns the runner session, routes searches and downloads to the
// runner, and keeps members current (bot status messages and mini app sockets).
// WebSocket Hibernation API (ctx.acceptWebSocket).
//
// Transient storage (peer names, paths, chat ids, tunnel tokens) lives here only while it is needed:
//   s:<sid>  search record      r:<sid>  runner results     v:<sid>  items currently shown
//   g:<gid>  crossing (group)   jg:<job> job → group        dj:<job> direct token (D8)
//   wakers   chats waiting for /wake                          direct   tunnel base URL this session
//   t:<tkt>  single-use socket ticket (60 s), so no login data ever sits in a logged URL
//   alt:<job> peers already tried for a job (automatic fallback to another source)

import { DurableObject } from "cloudflare:workers";
import { hmacHex, randomHex } from "./crypto.ts";
import { crossingText, isTerminal, type JobProgress } from "./crossing.ts";
import { dispatchRunner } from "./doorbell.ts";
import type { Env } from "./env.ts";
import type { Member } from "./members.ts";
import { frame, type Envelope, type Fmt, type Folder, type JobMode, type JobStateMsg, type TrackMeta } from "./protocol.ts";
import { basename, counts, describe, dirname, peerScore, rank, render, type Counts, type Item, type Prefs, type View } from "./rank.ts";
import * as S from "./session.ts";
import { tgCall } from "./telegram.ts";
import { label } from "./words.ts";

const RUNNER = "runner";
const APP = "app";
const DEFAULT_UPLOAD_MB = 50;
const MAX_OPENINGS = 3;
const EDIT_EVERY_MS = 4000;
const SEARCH_TTL_MS = 6 * 3600_000;
const MAX_AUTO_RINGS = 2;
const TICKET_TTL_MS = 60_000;
const MAX_SOURCES = 4; // the first peer plus up to three others with the same file
const PEER_ERRORS = new Set(["connect", "timeout", "rejected", "queue", "not_shared", "unknown"]);

type Origin = "bot" | "app";

interface SearchRec {
  sid: string;
  query: string;
  fmt: Fmt;
  view: View;
  chatId: number;
  member: string;
  prefs: Prefs;
  origin: Origin;
  status: "pending" | "sent" | "done";
  partial?: boolean; // results so far, while Soulseek is still answering
  page?: number; // bot results page
  msgId?: number;
  createdAt: number;
}

interface Results {
  folders: Folder[];
  scores: [string, number][];
}

interface GroupRec {
  gid: string;
  chatId: number;
  member: string;
  origin: Origin;
  msgId?: number;
  name: string;
  jobs: string[];
  createdAt: number;
}

export interface RingResult {
  session: S.Session;
  dispatched: boolean;
  dispatchStatus?: number;
}

/** What the bot should do in answer to a callback: one webhook reply plus optional extra calls.
 *  JSON strings of `{ method, ...params }`, because RPC types cannot carry `unknown`. */
export interface BotAction {
  reply?: string;
  also?: string[];
}

export interface AppItem {
  i: number;
  kind: "t" | "a";
  name: string;
  detail: string;
  ext: string;
  size: number;
  free: boolean;
  /** Above the chat upload limit: crosses directly (D8), or is unavailable if no tunnel this session. */
  direct: boolean;
  /** Album contents (names and sizes only). */
  files: { name: string; size: number }[];
}

export interface AppView {
  status: "pending" | "sent" | "partial" | "done" | "gone";
  query: string;
  fmt: Fmt;
  view: View;
  total: number;
  counts: Counts;
  note: string | null;
  offset: number;
  items: AppItem[];
}

export interface AppJob {
  id: string;
  state: string;
  pct: number | null;
  place: number | null;
  error: string | null;
}

export interface AppCrossing {
  gid: string;
  name: string;
  text: string;
  jobs: AppJob[];
}

export interface DirectFile {
  job: string;
  name: string;
  size: number;
  url: string;
}

export class Hub extends DurableObject<Env> {
  // Ephemeral (lost on hibernation, which is fine for progress).
  private progress = new Map<string, JobProgress>();
  private lastEdit = new Map<string, number>();

  // ---------------------------------------------------------------- session

  private async load(): Promise<S.Session> {
    return (await this.ctx.storage.get<S.Session>("session")) ?? S.initialSession(Date.now());
  }

  private async save(prev: S.Session, next: S.Session): Promise<S.Session> {
    if (prev === next) return next;
    await this.ctx.storage.put("session", next);
    const at = S.nextAlarm(next);
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
    if (prev.state !== next.state) this.broadcast(next);
    return next;
  }

  private broadcast(s: S.Session): void {
    this.sendApps(this.ctx.getWebSockets(APP), "session.state", { state: s.state, label: label(s.state) });
  }

  private sendApps(sockets: WebSocket[], type: string, data: Record<string, unknown>): void {
    const msg = frame(type, data);
    for (const ws of sockets) {
      try {
        ws.send(msg);
      } catch {
        // gone; close handler cleans up
      }
    }
  }

  private toMember(memberKey: string, type: string, data: Record<string, unknown>): void {
    this.sendApps(this.ctx.getWebSockets(`m:${memberKey}`), type, data);
  }

  private runner(): WebSocket | undefined {
    return this.ctx.getWebSockets(RUNNER).find((ws) => ws.readyState === WebSocket.OPEN);
  }

  private toRunner(type: string, data: Record<string, unknown> = {}): boolean {
    const ws = this.runner();
    if (!ws) return false;
    ws.send(frame(type, data));
    return true;
  }

  private tg(method: string, body: Record<string, unknown>) {
    return tgCall<{ message_id: number }>(this.env.VEIL_BOT_TOKEN, method, body);
  }

  private async uploadLimit(): Promise<number> {
    return ((await this.load()).maxUploadMb ?? DEFAULT_UPLOAD_MB) * 1024 * 1024;
  }

  private async directBase(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("direct");
  }

  async getSession(): Promise<S.Session> {
    return this.load();
  }

  /** A random single-use ticket for the mini app socket (request URLs are logged; headers are not). */
  async ticket(memberKey: string): Promise<string> {
    const t = randomHex(16);
    await this.ctx.storage.put(`t:${t}`, { member: memberKey, exp: Date.now() + TICKET_TTL_MS });
    return t;
  }

  async ring(): Promise<RingResult> {
    const prev = await this.load();
    const { session, dispatch } = S.ring(prev, Date.now(), randomHex(8));
    if (!dispatch) return { session: prev, dispatched: false };
    await this.save(prev, session);
    const res = await dispatchRunner(this.env, session.sessionId!);
    if (!res.ok) {
      const off = await this.save(session, S.gone(session, Date.now()));
      return { session: off, dispatched: false, dispatchStatus: res.status };
    }
    return { session: await this.save(session, S.dispatched(session, res.runId)), dispatched: true, dispatchStatus: res.status };
  }

  async wake(chatId: number): Promise<RingResult> {
    const r = await this.ring();
    if (r.dispatched || r.session.state === "booting") {
      const wakers = (await this.ctx.storage.get<number[]>("wakers")) ?? [];
      if (!wakers.includes(chatId)) await this.ctx.storage.put("wakers", [...wakers, chatId]);
    }
    return r;
  }

  async sleep(): Promise<boolean> {
    return this.toRunner("session.drain");
  }

  /** After the runner is gone: forget stale searches, and ring again if work is still waiting. */
  private async afterGone(): Promise<void> {
    await this.ctx.storage.delete("direct");
    const now = Date.now();
    for (const [key, t] of await this.ctx.storage.list<{ exp: number }>({ prefix: "t:" })) if (t.exp < now) await this.ctx.storage.delete(key);
    const searches = await this.ctx.storage.list<SearchRec>({ prefix: "s:" });
    let waiting = false;
    for (const [key, rec] of searches) {
      if (now - rec.createdAt > SEARCH_TTL_MS) await this.ctx.storage.delete([key, `r:${rec.sid}`, `v:${rec.sid}`]);
      else if (rec.status !== "done") waiting = true;
    }
    const open = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state NOT IN ('delivered','failed')").first<{ n: number }>();
    if (!waiting && (open?.n ?? 0) === 0) return;
    // At most two automatic re-rings in a row; a successful hello resets the count.
    const auto = (await this.ctx.storage.get<number>("autoRings")) ?? 0;
    if (auto >= MAX_AUTO_RINGS) return;
    await this.ctx.storage.put("autoRings", auto + 1);
    await this.ring();
  }

  // ---------------------------------------------------------------- searches

  async search(member: Member, chatId: number, query: string, fmt: Fmt, origin: Origin = "bot"): Promise<{ sid: string; state: S.SessionState }> {
    const now = Date.now();
    const sid = randomHex(5);
    const prefs = JSON.parse(member.prefs) as Prefs;
    const rec: SearchRec = { sid, query, fmt, view: "t", chatId, member: member.member_key, prefs, origin, status: "pending", createdAt: now };
    await this.env.DB.batch([
      this.env.DB.prepare("INSERT INTO searches (id, user_id, query, format_filter, created_at) VALUES (?, ?, ?, ?, ?)").bind(sid, member.member_key, query, fmt, now),
      this.env.DB.prepare("INSERT INTO events (user_id, type, ref, created_at) VALUES (?, 'search', ?, ?)").bind(member.member_key, sid, now),
    ]);
    const s = await this.load();
    if (s.state === "ready" && this.toRunner("search.start", { search_id: sid, query })) rec.status = "sent";
    await this.ctx.storage.put(`s:${sid}`, rec);
    if (rec.status === "pending") return { sid, state: (await this.ring()).session.state };
    return { sid, state: s.state };
  }

  private async onResults(d: { search_id: string; responses?: number; files?: number; folders?: Folder[]; partial?: boolean }): Promise<void> {
    const rec = await this.ctx.storage.get<SearchRec>(`s:${d.search_id}`);
    if (!rec) return;
    const folders = d.folders ?? [];
    const users = [...new Set(folders.map((f) => f.u))];
    const hashes = await Promise.all(users.map((u) => hmacHex(this.env.PEER_HMAC_KEY, u)));
    const scores = new Map<string, number>();
    if (hashes.length) {
      const { results } = await this.env.DB.prepare(
        `SELECT peer_hash, ok, fail FROM peer_stats WHERE peer_hash IN (${hashes.map(() => "?").join(",")})`,
      ).bind(...hashes).all<{ peer_hash: string; ok: number; fail: number }>();
      const byHash = new Map(results.map((r) => [r.peer_hash, peerScore(r.ok, r.fail)]));
      users.forEach((u, i) => byHash.has(hashes[i]!) && scores.set(u, byHash.get(hashes[i]!)!));
    }
    await this.ctx.storage.put(`r:${rec.sid}`, { folders, scores: [...scores] } satisfies Results);
    const tally = counts(folders, rec.fmt, rec.prefs);

    if (d.partial) {
      // Results so far: the app shows them at once; the bot waits for the final set to keep the chat quiet.
      await this.ctx.storage.put(`s:${rec.sid}`, { ...rec, partial: true });
      await this.view(rec, rec.view, rec.fmt);
      this.toMember(rec.member, "search.update", { sid: rec.sid, partial: true, counts: tally });
      return;
    }

    await this.env.DB.prepare("UPDATE searches SET result_count = ? WHERE id = ?").bind(d.files ?? 0, rec.sid).run();
    let msgId: number | undefined;
    const { rendered } = await this.view(rec, rec.view, rec.fmt, 0); // also fixes the shown list for taps
    if (rec.origin === "bot") {
      const sent = await this.tg("sendMessage", { chat_id: rec.chatId, ...rendered, link_preview_options: { is_disabled: true } });
      msgId = sent.result?.message_id;
    }
    await this.ctx.storage.put(`s:${rec.sid}`, { ...rec, status: "done", partial: false, page: 0, msgId });
    this.toMember(rec.member, "search.done", { sid: rec.sid, counts: tally });
  }

  /** Rank cached results for a view and remember the ranked list, so a tap maps to the same item. */
  private async view(rec: SearchRec, view: View, fmt: Fmt, page = rec.page ?? 0) {
    const res = (await this.ctx.storage.get<Results>(`r:${rec.sid}`)) ?? { folders: [], scores: [] };
    const ranked = rank(res.folders, view, fmt, rec.prefs, new Map(res.scores));
    await this.ctx.storage.put(`v:${rec.sid}`, ranked.items);
    const s = await this.load();
    const tally = counts(res.folders, fmt, rec.prefs);
    const direct = Boolean(await this.directBase());
    return { ranked, tally, rendered: render(rec.sid, rec.query, view, fmt, ranked, s.maxUploadMb ?? DEFAULT_UPLOAD_MB, page, tally, direct) };
  }

  /** Callback data `s:<sid>:<op>:<arg>` from a results message. */
  async searchCallback(member: Member, chatId: number, msgId: number, cqId: string, data: string): Promise<BotAction> {
    const [, sid = "", op, arg = ""] = data.split(":");
    const answer = (text: string) => JSON.stringify({ method: "answerCallbackQuery", callback_query_id: cqId, text });
    const rec = await this.ctx.storage.get<SearchRec>(`s:${sid}`);
    if (!rec || rec.member !== member.member_key) return { reply: answer("That search has faded. Seek again.") };

    if (op === "n") return { reply: answer("") };
    if (op === "f" || op === "v" || op === "p") {
      const fmt = op === "f" ? (arg as Fmt) : rec.fmt;
      const view = op === "v" ? (arg as View) : rec.view;
      const page = op === "p" ? Math.max(0, Number(arg) || 0) : 0;
      await this.ctx.storage.put(`s:${sid}`, { ...rec, fmt, view, page });
      const { rendered } = await this.view({ ...rec, fmt, view, page }, view, fmt, page);
      return {
        reply: JSON.stringify({ method: "editMessageText", chat_id: chatId, message_id: msgId, ...rendered, link_preview_options: { is_disabled: true } }),
        also: [answer("")],
      };
    }

    if (op === "d") {
      const r = await this.crossIndex(member, chatId, rec, Number(arg), "bot");
      return { reply: answer(r.ok ? "Let it cross." : r.error) };
    }
    return { reply: answer("") };
  }

  // ---------------------------------------------------------------- mini app

  async appView(member: Member, sid: string, view?: View, fmt?: Fmt, offset = 0, count = 30): Promise<AppView> {
    const rec = await this.ctx.storage.get<SearchRec>(`s:${sid}`);
    const empty = { tracks: 0, albums: 0 };
    if (!rec || rec.member !== member.member_key) return { status: "gone", query: "", fmt: "flac", view: "t", total: 0, counts: empty, note: null, offset: 0, items: [] };
    const v = view ?? rec.view;
    const f = fmt ?? rec.fmt;
    if (v !== rec.view || f !== rec.fmt) await this.ctx.storage.put(`s:${sid}`, { ...rec, view: v, fmt: f });
    const status = rec.status === "done" ? "done" : rec.partial ? "partial" : rec.status;
    if (status !== "done" && status !== "partial") return { status, query: rec.query, fmt: f, view: v, total: 0, counts: empty, note: null, offset: 0, items: [] };
    const { ranked, tally } = await this.view(rec, v, f);
    const limit = await this.uploadLimit();
    const from = Math.max(0, offset);
    const items = ranked.items.slice(from, from + Math.min(Math.max(1, count), 60)).map((it, k) => {
      const big = it.kind === "t" ? it.size > limit : it.files.some((x) => x.size > limit);
      return {
        i: from + k, kind: it.kind, ...describe(it), ext: it.kind === "t" ? it.ext : it.exts.join("/"),
        size: it.size, free: it.free, direct: big,
        files: it.kind === "a" ? it.files.slice(0, 80).map((x) => ({ name: basename(x.path), size: x.size })) : [],
      };
    });
    return { status, query: rec.query, fmt: f, view: v, total: ranked.items.length, counts: tally, note: ranked.note ?? null, offset: from, items };
  }

  /** Session details for the mini app's status sheet. */
  async appSession(): Promise<{ state: S.SessionState; since: number; direct: boolean; maxUploadMb: number }> {
    const s = await this.load();
    return { state: s.state, since: s.since, direct: Boolean(await this.directBase()), maxUploadMb: s.maxUploadMb ?? DEFAULT_UPLOAD_MB };
  }

  /** `key` is "name|size" of the item the member saw; ranking can shift while partial results arrive. */
  async appCross(member: Member, chatId: number, sid: string, index: number, key?: string): Promise<{ ok: boolean; error?: string; gid?: string }> {
    const rec = await this.ctx.storage.get<SearchRec>(`s:${sid}`);
    if (!rec || rec.member !== member.member_key) return { ok: false, error: "That search has faded. Seek again." };
    if (key) {
      const items = (await this.ctx.storage.get<Item[]>(`v:${sid}`)) ?? [];
      const keyOf = (it: Item) => `${describe(it).name}|${it.size}`;
      if (items[index] && keyOf(items[index]!) !== key) {
        const found = items.findIndex((it) => keyOf(it) === key);
        if (found < 0) return { ok: false, error: "That result has faded. Seek again." };
        index = found;
      }
    }
    return this.crossIndex(member, chatId, rec, index, "app");
  }

  async appCrossings(member: Member): Promise<AppCrossing[]> {
    const out: AppCrossing[] = [];
    for (const [, g] of await this.ctx.storage.list<GroupRec>({ prefix: "g:" })) {
      if (g.member !== member.member_key) continue;
      out.push(await this.snapshot(g));
    }
    return out.sort((a, b) => a.gid.localeCompare(b.gid));
  }

  /** Files of a crossing that wait at the veil's edge, with their one-time tunnel links. */
  async appDirect(member: Member, gid: string): Promise<DirectFile[]> {
    const g = await this.ctx.storage.get<GroupRec>(`g:${gid}`);
    const base = await this.directBase();
    if (!g || g.member !== member.member_key || !base) return [];
    const files: DirectFile[] = [];
    for (const id of g.jobs) {
      const token = await this.ctx.storage.get<string>(`dj:${id}`);
      if (!token) continue;
      const job = await this.env.DB.prepare("SELECT name, size FROM jobs WHERE id = ?").bind(id).first<{ name: string; size: number }>();
      if (job) files.push({ job: id, name: job.name, size: job.size, url: `${base}/f/${token}` });
    }
    return files;
  }

  /** The member has the file: the runner deletes it and reports delivered. */
  async appRelease(member: Member, jobId: string): Promise<boolean> {
    const gid = await this.ctx.storage.get<string>(`jg:${jobId}`);
    const g = gid ? await this.ctx.storage.get<GroupRec>(`g:${gid}`) : undefined;
    if (!g || g.member !== member.member_key) return false;
    return this.toRunner("job.release", { job_id: jobId });
  }

  // ---------------------------------------------------------------- crossings (downloads)

  private async crossIndex(member: Member, chatId: number, rec: SearchRec, index: number, origin: Origin): Promise<{ ok: boolean; error: string; gid?: string }> {
    const items = (await this.ctx.storage.get<Item[]>(`v:${rec.sid}`)) ?? [];
    const item = items[index];
    if (!item) return { ok: false, error: "That result has faded. Seek again." };
    const limit = await this.uploadLimit();
    const direct = Boolean(await this.directBase());
    const big = (size: number) => size > limit;
    if (!direct && item.kind === "t" && big(item.size)) return { ok: false, error: "Too large for now. Pick a smaller file or MP3." };
    if (!direct && item.kind === "a" && item.files.every((f) => big(f.size))) return { ok: false, error: "Every file here is too large for now." };
    const gid = await this.cross(member, chatId, rec, item, origin, limit, direct);
    return { ok: true, error: "", gid };
  }

  private async cross(member: Member, chatId: number, rec: SearchRec, item: Item, origin: Origin, limit: number, direct: boolean): Promise<string> {
    const now = Date.now();
    const gid = randomHex(6);
    const files =
      item.kind === "t"
        ? [{ path: item.path, size: item.size, ext: item.ext, br: item.br }]
        : item.files.filter((f) => direct || f.size <= limit).map((f) => ({ ...f, br: null as number | null }));
    const name = item.kind === "t" ? basename(item.path) : dirname(item.d + "/x");
    const jobs = files.map((f) => ({ id: randomHex(8), mode: (f.size > limit ? "direct" : "chat") as JobMode, ...f }));

    await this.env.DB.batch([
      ...jobs.map((j) =>
        this.env.DB.prepare(
          `INSERT INTO jobs (id, user_id, search_id, chat_id, peer, path, size, format, bitrate, state, group_id, name, mode, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        ).bind(j.id, member.member_key, rec.sid, chatId, item.u, j.path, j.size, j.ext, j.br, gid, basename(j.path), j.mode, now, now),
      ),
      this.env.DB.prepare("INSERT INTO events (user_id, type, ref, created_at) VALUES (?, 'download', ?, ?)").bind(member.member_key, gid, now),
    ]);

    const group: GroupRec = { gid, chatId, member: member.member_key, origin, name, jobs: jobs.map((j) => j.id), createdAt: now };
    for (const j of jobs) {
      this.progress.set(j.id, { state: "pending" });
      await this.ctx.storage.put(`jg:${j.id}`, gid);
    }
    if (origin === "bot") {
      const sent = await this.tg("sendMessage", { chat_id: chatId, text: crossingText(name, jobs.map(() => ({ state: "pending" as const }))) });
      group.msgId = sent.result?.message_id;
    }
    await this.ctx.storage.put(`g:${gid}`, group);
    this.toMember(member.member_key, "crossing", { ...(await this.snapshot(group)) });

    const s = await this.load();
    if (s.state === "ready") {
      for (const j of jobs) {
        this.toRunner("job.start", { job_id: j.id, peer: item.u, path: j.path, size: j.size, chat_id: chatId, caption: basename(j.path), mode: j.mode });
      }
    } else {
      await this.ring();
    }
    return gid;
  }

  private async snapshot(g: GroupRec): Promise<AppCrossing> {
    const missing = g.jobs.filter((id) => !this.progress.has(id));
    if (missing.length) {
      const { results } = await this.env.DB.prepare(`SELECT id, state, error FROM jobs WHERE id IN (${missing.map(() => "?").join(",")})`)
        .bind(...missing).all<{ id: string; state: JobProgress["state"]; error: string | null }>();
      for (const r of results) this.progress.set(r.id, { state: r.state, error: r.error ?? undefined });
    }
    const states = g.jobs.map((id) => this.progress.get(id) ?? { state: "pending" as const });
    return {
      gid: g.gid,
      name: g.name,
      text: crossingText(g.name, states),
      jobs: g.jobs.map((id, i) => ({ id, state: states[i]!.state, pct: states[i]!.pct ?? null, place: states[i]!.place ?? null, error: states[i]!.error ?? null })),
    };
  }

  /** On hello: hand the runner every unfinished job it does not already hold. */
  private async pumpJobs(active: string[]): Promise<void> {
    const { results } = await this.env.DB.prepare(
      "SELECT id, chat_id, peer, path, size, name, attempts, mode FROM jobs WHERE state NOT IN ('delivered','failed')",
    ).all<{ id: string; chat_id: number; peer: string; path: string; size: number; name: string; attempts: number; mode: JobMode }>();
    for (const j of results) {
      if (active.includes(j.id)) continue;
      if (j.attempts >= MAX_OPENINGS) {
        await this.onJobState({ job_id: j.id, state: "failed", error: "gave_up" });
        continue;
      }
      await this.env.DB.prepare("UPDATE jobs SET attempts = attempts + 1, state = 'pending', updated_at = ? WHERE id = ?").bind(Date.now(), j.id).run();
      this.toRunner("job.start", { job_id: j.id, peer: j.peer, path: j.path, size: j.size, chat_id: j.chat_id, caption: j.name, mode: j.mode });
    }
  }

  /** The same file (name and size) from another peer in the cached results, if any is left to try. */
  private async retryElsewhere(m: JobStateMsg): Promise<boolean> {
    const job = await this.env.DB.prepare("SELECT search_id, peer, path, size, chat_id, name, mode FROM jobs WHERE id = ?")
      .bind(m.job_id).first<{ search_id: string; peer: string; path: string; size: number; chat_id: number; name: string; mode: JobMode }>();
    if (!job?.peer || !job.path) return false;
    const tried = (await this.ctx.storage.get<string[]>(`alt:${m.job_id}`)) ?? [job.peer];
    if (tried.length >= MAX_SOURCES) return false;
    const res = await this.ctx.storage.get<Results>(`r:${job.search_id}`);
    if (!res) return false;
    const want = basename(job.path).toLowerCase();
    const scores = new Map(res.scores);
    const candidates = res.folders
      .filter((f) => !tried.includes(f.u))
      .flatMap((f) => f.files.filter(([p, size]) => size === job.size && basename(p).toLowerCase() === want).map(([p]) => ({ u: f.u, path: p, free: f.f, q: f.q, score: scores.get(f.u) ?? 0.5 })))
      .sort((a, b) => Number(b.free) - Number(a.free) || b.score - a.score || a.q - b.q);
    const next = candidates[0];
    if (!next) return false;

    await this.peerStat(job.peer, m);
    await this.ctx.storage.put(`alt:${m.job_id}`, [...tried, next.u]);
    await this.env.DB.prepare("UPDATE jobs SET peer = ?, path = ?, state = 'pending', updated_at = ? WHERE id = ?").bind(next.u, next.path, Date.now(), m.job_id).run();
    if ((await this.load()).state === "ready") {
      this.toRunner("job.start", { job_id: m.job_id, peer: next.u, path: next.path, size: job.size, chat_id: job.chat_id, caption: job.name, mode: job.mode });
    }
    return true;
  }

  private async peerStat(peer: string, m: JobStateMsg): Promise<void> {
    await this.peerStatStmt(peer, m, Date.now()).then((s) => s.run());
  }

  private async peerStatStmt(peer: string, m: JobStateMsg, now: number): Promise<D1PreparedStatement> {
    const h = await hmacHex(this.env.PEER_HMAC_KEY, peer);
    const ok = m.state === "delivered" ? 1 : 0;
    const refused = m.error === "rejected" || m.error === "queue" ? 1 : 0;
    return this.env.DB.prepare(
      `INSERT INTO peer_stats (peer_hash, ok, fail, refused, avg_kbps, last_seen) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(peer_hash) DO UPDATE SET ok = ok + excluded.ok, fail = fail + excluded.fail, refused = refused + excluded.refused,
         avg_kbps = COALESCE((COALESCE(avg_kbps, excluded.avg_kbps) + excluded.avg_kbps) / 2, avg_kbps), last_seen = excluded.last_seen`,
    ).bind(h, ok, 1 - ok, refused, m.kbps ?? null, now);
  }

  private async onJobState(m: JobStateMsg): Promise<void> {
    const now = Date.now();
    const prev = this.progress.get(m.job_id);
    this.progress.set(m.job_id, { state: m.state, pct: m.pct, place: m.place, error: m.error });
    const changed = prev?.state !== m.state;

    if (m.state === "failed" && PEER_ERRORS.has(m.error ?? "") && (await this.retryElsewhere(m))) {
      m = { job_id: m.job_id, state: "pending" };
      this.progress.set(m.job_id, { state: "pending" });
    } else if (m.state === "delivered" || m.state === "failed") {
      await this.ctx.storage.delete([`dj:${m.job_id}`, `alt:${m.job_id}`]);
      await this.finishJob(m, now);
    } else if (changed) {
      await this.env.DB.prepare("UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?").bind(m.state, now, m.job_id).run();
    }

    const gid = await this.ctx.storage.get<string>(`jg:${m.job_id}`);
    const group = gid ? await this.ctx.storage.get<GroupRec>(`g:${gid}`) : undefined;
    if (!group) return;

    if (m.state === "awaiting" && m.token) {
      await this.ctx.storage.put(`dj:${m.job_id}`, m.token);
      if (changed && group.origin === "bot" && this.env.APP_URL) {
        await this.tg("sendMessage", {
          chat_id: group.chatId,
          text: `${group.name} is too large for the chat. It waits at the veil's edge for 30 minutes.`,
          reply_markup: { inline_keyboard: [[{ text: "Receive it", web_app: { url: `${this.env.APP_URL}/#receive/${group.gid}` } }]] },
        });
      }
    }

    const snap = await this.snapshot(group);
    const done = snap.jobs.every((j) => isTerminal(j.state as JobProgress["state"]));
    const due = now - (this.lastEdit.get(group.gid) ?? 0) >= EDIT_EVERY_MS;
    if (changed || due || done) {
      this.lastEdit.set(group.gid, now);
      this.toMember(group.member, "crossing", { ...snap, done });
      if (group.msgId) await this.tg("editMessageText", { chat_id: group.chatId, message_id: group.msgId, text: snap.text });
    }
    if (done) {
      await this.ctx.storage.delete([`g:${group.gid}`, ...group.jobs.map((id) => `jg:${id}`)]);
      for (const id of group.jobs) this.progress.delete(id);
      this.lastEdit.delete(group.gid);
    }
  }

  /** Terminal state: record the text metadata, update peer stats, erase peer/path/chat id. */
  private async finishJob(m: JobStateMsg, now: number): Promise<void> {
    const job = await this.env.DB.prepare("SELECT user_id, peer, state FROM jobs WHERE id = ?").bind(m.job_id).first<{ user_id: string; peer: string | null; state: string }>();
    if (!job || job.state === "delivered" || job.state === "failed") return;
    const db = this.env.DB;
    const stmts: D1PreparedStatement[] = [];
    let trackId: string | null = null;

    if (m.state === "delivered") {
      const t: TrackMeta = m.track ?? {};
      trackId = randomHex(8);
      stmts.push(
        db.prepare("INSERT INTO tracks (id, artist, title, album, year, format, mb_recording, mb_release) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(trackId, t.artist ?? null, t.title ?? null, t.album ?? null, t.year ?? null, t.format ?? null, t.mb_recording ?? null, t.mb_release ?? null),
        db.prepare("INSERT INTO events (user_id, type, ref, created_at) VALUES (?, 'deliver', ?, ?)").bind(job.user_id, trackId, now),
      );
    }
    stmts.push(
      db.prepare("UPDATE jobs SET state = ?, error = ?, track_id = ?, chat_id = NULL, peer = NULL, path = NULL, updated_at = ? WHERE id = ?")
        .bind(m.state, m.error ?? null, trackId, now, m.job_id),
    );
    if (job.peer && !["too_large", "upload", "gave_up", "unclaimed"].includes(m.error ?? "")) stmts.push(await this.peerStatStmt(job.peer, m, now));
    await db.batch(stmts);
  }

  // ---------------------------------------------------------------- WebSockets

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (url.pathname.endsWith("/runner")) {
      for (const old of this.ctx.getWebSockets(RUNNER)) if (old.readyState === WebSocket.OPEN) old.close(4000, "replaced");
      this.ctx.acceptWebSocket(server, [RUNNER]);
    } else {
      const t = url.searchParams.get("t") ?? "";
      const rec = /^[0-9a-f]{32}$/.test(t) ? await this.ctx.storage.get<{ member: string; exp: number }>(`t:${t}`) : undefined;
      if (rec) await this.ctx.storage.delete(`t:${t}`);
      if (!rec || rec.exp < Date.now()) return new Response("Not found", { status: 404 });
      this.ctx.acceptWebSocket(server, [APP, `m:${rec.member}`]);
      const s = await this.load();
      server.send(frame("session.state", { state: s.state, label: label(s.state) }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (!this.ctx.getTags(ws).includes(RUNNER)) return;
    let msg: Envelope;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as Envelope;
    } catch {
      return;
    }
    const d = (msg.data ?? {}) as Record<string, unknown>;
    const prev = await this.load();
    const now = Date.now();

    switch (msg.type) {
      case "runner.hello": {
        const next = await this.save(prev, S.hello(prev, now, d.run_id as number, (d.session_id as string) || undefined, d.max_upload_mb as number));
        if (typeof d.direct_base === "string" && d.direct_base.startsWith("https://")) await this.ctx.storage.put("direct", d.direct_base.replace(/\/+$/, ""));
        else await this.ctx.storage.delete("direct");
        ws.send(frame("hub.welcome", { state: next.state }));
        await this.ctx.storage.delete("autoRings");
        const wakers = (await this.ctx.storage.get<number[]>("wakers")) ?? [];
        await this.ctx.storage.delete("wakers");
        for (const chat of wakers) await this.tg("sendMessage", { chat_id: chat, text: label("ready") });
        for (const [, rec] of await this.ctx.storage.list<SearchRec>({ prefix: "s:" })) {
          if (rec.status === "done") continue;
          ws.send(frame("search.start", { search_id: rec.sid, query: rec.query }));
          if (rec.status === "pending") await this.ctx.storage.put(`s:${rec.sid}`, { ...rec, status: "sent" });
        }
        await this.pumpJobs((d.active_jobs as string[]) ?? []);
        break;
      }
      case "runner.heartbeat":
        await this.save(prev, S.heartbeat(prev, now));
        break;
      case "search.results":
        await this.onResults(d as Parameters<Hub["onResults"]>[0]);
        break;
      case "job.state":
        await this.onJobState(d as unknown as JobStateMsg);
        break;
      case "session.state":
        if (d.state === "draining") await this.save(prev, S.draining(prev, now));
        break;
      case "runner.bye":
        await this.save(prev, S.gone(prev, now));
        ws.close(1000, "bye");
        await this.afterGone();
        break;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
    // A dropped runner socket keeps the session until the heartbeat deadline, so a reconnect can resume.
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "error");
  }

  async alarm(): Promise<void> {
    const prev = await this.load();
    const next = await this.save(prev, S.tick(prev, Date.now()));
    if (next.state === "offline" && prev.state !== "offline") {
      for (const ws of this.ctx.getWebSockets(RUNNER)) if (ws.readyState === WebSocket.OPEN) ws.close(4001, "timeout");
      await this.afterGone();
    }
  }
}
