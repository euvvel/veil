// The Hub: one Durable Object that owns the runner session, routes searches and downloads to the
// runner, and keeps members' status messages current. WebSocket Hibernation API (ctx.acceptWebSocket).
//
// Transient storage (peer names, paths, chat ids) lives here only while it is needed:
//   s:<sid>  search record      r:<sid>  runner results     v:<sid>  items currently shown
//   g:<gid>  crossing (group)   jg:<job> job → group        wakers   chats waiting for /wake

import { DurableObject } from "cloudflare:workers";
import { hmacHex, randomHex } from "./crypto.ts";
import { crossingText, isTerminal, type JobProgress } from "./crossing.ts";
import { dispatchRunner } from "./doorbell.ts";
import type { Env } from "./env.ts";
import type { Member } from "./members.ts";
import { frame, type Envelope, type Fmt, type Folder, type JobStateMsg, type TrackMeta } from "./protocol.ts";
import { basename, dirname, peerScore, rank, render, type Item, type Prefs, type View } from "./rank.ts";
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

interface SearchRec {
  sid: string;
  query: string;
  fmt: Fmt;
  view: View;
  chatId: number;
  member: string;
  prefs: Prefs;
  status: "pending" | "sent" | "done";
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
  msgId?: number;
  name: string;
  jobs: string[];
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
    const msg = frame("session.state", { state: s.state, label: label(s.state) });
    for (const ws of this.ctx.getWebSockets(APP)) {
      try {
        ws.send(msg);
      } catch {
        // gone; close handler cleans up
      }
    }
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

  async getSession(): Promise<S.Session> {
    return this.load();
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
    const now = Date.now();
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

  async search(member: Member, chatId: number, query: string, fmt: Fmt): Promise<S.SessionState> {
    const now = Date.now();
    const sid = randomHex(5);
    const prefs = JSON.parse(member.prefs) as Prefs;
    const rec: SearchRec = { sid, query, fmt, view: "t", chatId, member: member.member_key, prefs, status: "pending", createdAt: now };
    await this.env.DB.batch([
      this.env.DB.prepare("INSERT INTO searches (id, user_id, query, format_filter, created_at) VALUES (?, ?, ?, ?, ?)").bind(sid, member.member_key, query, fmt, now),
      this.env.DB.prepare("INSERT INTO events (user_id, type, ref, created_at) VALUES (?, 'search', ?, ?)").bind(member.member_key, sid, now),
    ]);
    const s = await this.load();
    if (s.state === "ready" && this.toRunner("search.start", { search_id: sid, query })) rec.status = "sent";
    await this.ctx.storage.put(`s:${sid}`, rec);
    if (rec.status === "pending") return (await this.ring()).session.state;
    return s.state;
  }

  private async onResults(d: { search_id: string; responses?: number; files?: number; folders?: Folder[] }): Promise<void> {
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
    await this.env.DB.prepare("UPDATE searches SET result_count = ? WHERE id = ?").bind(d.files ?? 0, rec.sid).run();

    const view = await this.view(rec, rec.view, rec.fmt);
    const sent = await this.tg("sendMessage", { chat_id: rec.chatId, ...view, link_preview_options: { is_disabled: true } });
    await this.ctx.storage.put(`s:${rec.sid}`, { ...rec, status: "done", msgId: sent.result?.message_id });
  }

  /** Rank cached results for a view and remember what was shown, so a tap maps to the same item. */
  private async view(rec: SearchRec, view: View, fmt: Fmt) {
    const res = (await this.ctx.storage.get<Results>(`r:${rec.sid}`)) ?? { folders: [], scores: [] };
    const ranked = rank(res.folders, view, fmt, rec.prefs, new Map(res.scores));
    await this.ctx.storage.put(`v:${rec.sid}`, ranked.items);
    const s = await this.load();
    return render(rec.sid, rec.query, view, fmt, ranked, s.maxUploadMb ?? DEFAULT_UPLOAD_MB);
  }

  /** Callback data `s:<sid>:<op>:<arg>` from a results message. */
  async searchCallback(member: Member, chatId: number, msgId: number, cqId: string, data: string): Promise<BotAction> {
    const [, sid = "", op, arg = ""] = data.split(":");
    const answer = (text: string) => JSON.stringify({ method: "answerCallbackQuery", callback_query_id: cqId, text });
    const rec = await this.ctx.storage.get<SearchRec>(`s:${sid}`);
    if (!rec || rec.member !== member.member_key) return { reply: answer("That search has faded. Seek again.") };

    if (op === "f" || op === "v") {
      const fmt = op === "f" ? (arg as Fmt) : rec.fmt;
      const view = op === "v" ? (arg as View) : rec.view;
      await this.ctx.storage.put(`s:${sid}`, { ...rec, fmt, view });
      const out = await this.view({ ...rec, fmt, view }, view, fmt);
      return {
        reply: JSON.stringify({ method: "editMessageText", chat_id: chatId, message_id: msgId, ...out, link_preview_options: { is_disabled: true } }),
        also: [answer("")],
      };
    }

    if (op === "d") {
      const items = (await this.ctx.storage.get<Item[]>(`v:${sid}`)) ?? [];
      const item = items[Number(arg)];
      if (!item) return { reply: answer("That result has faded. Seek again.") };
      const limit = ((await this.load()).maxUploadMb ?? DEFAULT_UPLOAD_MB) * 1024 * 1024;
      if (item.kind === "t" && item.size > limit) return { reply: answer("Too large for now. Pick a smaller file or MP3.") };
      if (item.kind === "a" && item.files.every((f) => f.size > limit)) return { reply: answer("Every file here is too large for now.") };
      await this.cross(member, chatId, rec, item);
      return { reply: answer("Let it cross.") };
    }
    return { reply: answer("") };
  }

  // ---------------------------------------------------------------- crossings (downloads)

  private async cross(member: Member, chatId: number, rec: SearchRec, item: Item): Promise<void> {
    const now = Date.now();
    const limit = ((await this.load()).maxUploadMb ?? DEFAULT_UPLOAD_MB) * 1024 * 1024;
    const gid = randomHex(6);
    const files =
      item.kind === "t"
        ? [{ path: item.path, size: item.size, ext: item.ext, br: item.br }]
        : item.files.filter((f) => f.size <= limit).map((f) => ({ ...f, br: null as number | null }));
    const name = item.kind === "t" ? basename(item.path) : dirname(item.d + "/x");
    const jobs = files.map((f) => ({ id: randomHex(8), ...f }));

    await this.env.DB.batch([
      ...jobs.map((j) =>
        this.env.DB.prepare(
          `INSERT INTO jobs (id, user_id, search_id, chat_id, peer, path, size, format, bitrate, state, group_id, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        ).bind(j.id, member.member_key, rec.sid, chatId, item.u, j.path, j.size, j.ext, j.br, gid, basename(j.path), now, now),
      ),
      this.env.DB.prepare("INSERT INTO events (user_id, type, ref, created_at) VALUES (?, 'download', ?, ?)").bind(member.member_key, gid, now),
    ]);

    const group: GroupRec = { gid, chatId, member: member.member_key, name, jobs: jobs.map((j) => j.id) };
    for (const j of jobs) {
      this.progress.set(j.id, { state: "pending" });
      await this.ctx.storage.put(`jg:${j.id}`, gid);
    }
    const sent = await this.tg("sendMessage", { chat_id: chatId, text: crossingText(name, jobs.map(() => ({ state: "pending" as const }))) });
    group.msgId = sent.result?.message_id;
    await this.ctx.storage.put(`g:${gid}`, group);

    const s = await this.load();
    if (s.state === "ready") {
      for (const j of jobs) this.toRunner("job.start", { job_id: j.id, peer: item.u, path: j.path, size: j.size, chat_id: chatId, caption: basename(j.path) });
    } else {
      await this.ring();
    }
  }

  /** On hello: hand the runner every unfinished job it does not already hold. */
  private async pumpJobs(active: string[]): Promise<void> {
    const { results } = await this.env.DB.prepare(
      "SELECT id, chat_id, peer, path, size, name, attempts FROM jobs WHERE state NOT IN ('delivered','failed')",
    ).all<{ id: string; chat_id: number; peer: string; path: string; size: number; name: string; attempts: number }>();
    for (const j of results) {
      if (active.includes(j.id)) continue;
      if (j.attempts >= MAX_OPENINGS) {
        await this.onJobState({ job_id: j.id, state: "failed", error: "gave_up" });
        continue;
      }
      await this.env.DB.prepare("UPDATE jobs SET attempts = attempts + 1, state = 'pending', updated_at = ? WHERE id = ?").bind(Date.now(), j.id).run();
      this.toRunner("job.start", { job_id: j.id, peer: j.peer, path: j.path, size: j.size, chat_id: j.chat_id, caption: j.name });
    }
  }

  private async onJobState(m: JobStateMsg): Promise<void> {
    const now = Date.now();
    const prev = this.progress.get(m.job_id);
    this.progress.set(m.job_id, { state: m.state, pct: m.pct, place: m.place, error: m.error });
    const changed = prev?.state !== m.state;

    if (m.state === "delivered" || m.state === "failed") {
      await this.finishJob(m, now);
    } else if (changed) {
      await this.env.DB.prepare("UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?").bind(m.state, now, m.job_id).run();
    }

    const gid = await this.ctx.storage.get<string>(`jg:${m.job_id}`);
    const group = gid ? await this.ctx.storage.get<GroupRec>(`g:${gid}`) : undefined;
    if (!group) return;
    const states = group.jobs.map((id) => this.progress.get(id) ?? { state: "pending" as const });
    const done = states.every((p) => isTerminal(p.state));
    const due = now - (this.lastEdit.get(group.gid) ?? 0) >= EDIT_EVERY_MS;
    if (group.msgId && (changed || due || done)) {
      this.lastEdit.set(group.gid, now);
      await this.tg("editMessageText", { chat_id: group.chatId, message_id: group.msgId, text: crossingText(group.name, states) });
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
    if (job.peer && m.error !== "too_large" && m.error !== "upload" && m.error !== "gave_up") {
      const h = await hmacHex(this.env.PEER_HMAC_KEY, job.peer);
      const ok = m.state === "delivered" ? 1 : 0;
      const refused = m.error === "rejected" || m.error === "queue" ? 1 : 0;
      stmts.push(
        db.prepare(
          `INSERT INTO peer_stats (peer_hash, ok, fail, refused, avg_kbps, last_seen) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(peer_hash) DO UPDATE SET ok = ok + excluded.ok, fail = fail + excluded.fail, refused = refused + excluded.refused,
             avg_kbps = COALESCE((COALESCE(avg_kbps, excluded.avg_kbps) + excluded.avg_kbps) / 2, avg_kbps), last_seen = excluded.last_seen`,
        ).bind(h, ok, 1 - ok, refused, m.kbps ?? null, now),
      );
    }
    await db.batch(stmts);
  }

  // ---------------------------------------------------------------- WebSockets

  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).pathname.endsWith("/runner") ? RUNNER : APP;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (role === RUNNER) {
      for (const old of this.ctx.getWebSockets(RUNNER)) if (old.readyState === WebSocket.OPEN) old.close(4000, "replaced");
      this.ctx.acceptWebSocket(server, [RUNNER]);
    } else {
      this.ctx.acceptWebSocket(server, [APP]);
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
