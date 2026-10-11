// Runner session state machine. Pure: the Hub persists it and acts on the returned effects.
//
//   offline ──ring──▶ booting ──hello──▶ ready ──draining──▶ draining
//      ▲                 │                 │                    │
//      └── boot timeout ─┘                 └── bye / close / heartbeat timeout ──┘

export type SessionState = "offline" | "booting" | "ready" | "draining";

export interface Session {
  state: SessionState;
  since: number; // ms, when `state` was entered
  sessionId?: string;
  runId?: number;
  deadline?: number; // ms, heartbeat deadline while ready/draining
}

export const BOOT_TIMEOUT_MS = 3 * 60_000;
export const HEARTBEAT_GRACE_MS = 90_000;

export const initialSession = (now: number): Session => ({ state: "offline", since: now });

function enter(state: SessionState, now: number, keep: Partial<Session> = {}): Session {
  return { ...keep, state, since: now };
}

/** A member wants the runner. Dispatch only from offline, or from a boot that stalled. */
export function ring(s: Session, now: number, sessionId: string): { session: Session; dispatch: boolean } {
  const stalled = s.state === "booting" && now - s.since > BOOT_TIMEOUT_MS;
  if (s.state === "offline" || stalled) {
    return { session: enter("booting", now, { sessionId }), dispatch: true };
  }
  return { session: s, dispatch: false };
}

export function dispatched(s: Session, runId: number | undefined): Session {
  return { ...s, runId };
}

export function hello(s: Session, now: number, runId?: number, sessionId?: string): Session {
  return enter("ready", now, {
    sessionId: sessionId ?? s.sessionId,
    runId: runId ?? s.runId,
    deadline: now + HEARTBEAT_GRACE_MS,
  });
}

export function heartbeat(s: Session, now: number): Session {
  if (s.state !== "ready" && s.state !== "draining") return s;
  return { ...s, deadline: now + HEARTBEAT_GRACE_MS };
}

export function draining(s: Session, now: number): Session {
  if (s.state !== "ready") return s;
  return enter("draining", now, { sessionId: s.sessionId, runId: s.runId, deadline: now + HEARTBEAT_GRACE_MS });
}

export function gone(_s: Session, now: number): Session {
  return initialSession(now);
}

/** Called from the Hub alarm. */
export function tick(s: Session, now: number): Session {
  if (s.state === "booting" && now - s.since > BOOT_TIMEOUT_MS) return gone(s, now);
  if ((s.state === "ready" || s.state === "draining") && s.deadline !== undefined && now > s.deadline) return gone(s, now);
  return s;
}

/** When the Hub should next wake to run `tick`, or null. */
export function nextAlarm(s: Session): number | null {
  if (s.state === "booting") return s.since + BOOT_TIMEOUT_MS + 1;
  if (s.state === "ready" || s.state === "draining") return (s.deadline ?? s.since) + 1;
  return null;
}
