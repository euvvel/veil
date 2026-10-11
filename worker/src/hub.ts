// The Hub: one Durable Object that owns the runner session, the runner's WebSocket
// and the mini app sockets. Uses the WebSocket Hibernation API (ctx.acceptWebSocket).

import { DurableObject } from "cloudflare:workers";
import { dispatchRunner } from "./doorbell.ts";
import type { Env } from "./env.ts";
import { randomHex } from "./crypto.ts";
import * as S from "./session.ts";
import { label } from "./words.ts";

const RUNNER = "runner";
const APP = "app";

interface Envelope {
  v: 1;
  type: string;
  id?: string;
  ts?: number;
  data?: Record<string, unknown>;
}

export interface RingResult {
  session: S.Session;
  dispatched: boolean;
  dispatchStatus?: number;
}

export class Hub extends DurableObject<Env> {
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
    const msg = JSON.stringify({ v: 1, type: "session.state", ts: Date.now(), data: { state: s.state, label: label(s.state) } });
    for (const ws of this.ctx.getWebSockets(APP)) {
      try {
        ws.send(msg);
      } catch {
        // socket already gone; the close handler cleans up
      }
    }
  }

  private openRunners(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets(RUNNER).filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN);
  }

  // ---- RPC (called by the Worker) ----

  async getSession(): Promise<S.Session> {
    return this.load();
  }

  async ring(): Promise<RingResult> {
    const prev = await this.load();
    const now = Date.now();
    const { session, dispatch } = S.ring(prev, now, randomHex(8));
    if (!dispatch) return { session: prev, dispatched: false };

    await this.save(prev, session);
    const res = await dispatchRunner(this.env, session.sessionId!);
    if (!res.ok) {
      const off = await this.save(session, S.gone(session, Date.now()));
      return { session: off, dispatched: false, dispatchStatus: res.status };
    }
    const withRun = await this.save(session, S.dispatched(session, res.runId));
    return { session: withRun, dispatched: true, dispatchStatus: res.status };
  }

  // ---- WebSocket upgrades (forwarded by the Worker after it has authenticated the caller) ----

  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).pathname.endsWith("/runner") ? RUNNER : APP;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    if (role === RUNNER) {
      for (const old of this.openRunners()) old.close(4000, "replaced");
      this.ctx.acceptWebSocket(server, [RUNNER]);
    } else {
      this.ctx.acceptWebSocket(server, [APP]);
      server.send(JSON.stringify({ v: 1, type: "session.state", ts: Date.now(), data: await this.stateData() }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private async stateData() {
    const s = await this.load();
    return { state: s.state, label: label(s.state) };
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (!this.ctx.getTags(ws).includes(RUNNER)) return; // app sockets are receive-only for now
    let msg: Envelope;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as Envelope;
    } catch {
      return;
    }
    const prev = await this.load();
    const now = Date.now();
    const d = msg.data ?? {};
    switch (msg.type) {
      case "runner.hello": {
        const next = await this.save(prev, S.hello(prev, now, d.run_id as number | undefined, d.session_id as string | undefined));
        ws.send(JSON.stringify({ v: 1, type: "hub.welcome", ts: now, data: { state: next.state } }));
        break;
      }
      case "runner.heartbeat":
        await this.save(prev, S.heartbeat(prev, now));
        break;
      case "session.state":
        if (d.state === "draining") await this.save(prev, S.draining(prev, now));
        break;
      case "runner.bye":
        await this.save(prev, S.gone(prev, now));
        ws.close(1000, "bye");
        break;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
    if (this.ctx.getTags(ws).includes(RUNNER) && this.openRunners(ws).length === 0) {
      const prev = await this.load();
      if (prev.state !== "offline" && prev.state !== "booting") await this.save(prev, S.gone(prev, Date.now()));
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "error");
  }

  async alarm(): Promise<void> {
    const prev = await this.load();
    const next = await this.save(prev, S.tick(prev, Date.now()));
    if (next.state === "offline") for (const ws of this.openRunners()) ws.close(4001, "timeout");
  }
}
