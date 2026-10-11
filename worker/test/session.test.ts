import assert from "node:assert/strict";
import { test } from "node:test";
import * as S from "../src/session.ts";

const T = 1_000_000;

test("ring from offline dispatches once", () => {
  const off = S.initialSession(T);
  const a = S.ring(off, T, "s1");
  assert.equal(a.dispatch, true);
  assert.equal(a.session.state, "booting");
  const b = S.ring(a.session, T + 1000, "s2");
  assert.equal(b.dispatch, false, "no double start while booting");
  assert.equal(b.session.sessionId, "s1");
});

test("a stalled boot can be re-rung", () => {
  const { session } = S.ring(S.initialSession(T), T, "s1");
  const later = T + S.BOOT_TIMEOUT_MS + 1;
  assert.equal(S.ring(session, later, "s2").dispatch, true);
});

test("ring while ready does nothing", () => {
  const ready = S.hello(S.ring(S.initialSession(T), T, "s1").session, T + 20_000, 7);
  assert.equal(S.ring(ready, T + 21_000, "s2").dispatch, false);
});

test("hello → ready keeps session and run ids", () => {
  const booting = S.dispatched(S.ring(S.initialSession(T), T, "s1").session, 99);
  const ready = S.hello(booting, T + 22_000);
  assert.equal(ready.state, "ready");
  assert.equal(ready.sessionId, "s1");
  assert.equal(ready.runId, 99);
  assert.equal(ready.deadline, T + 22_000 + S.HEARTBEAT_GRACE_MS);
});

test("heartbeats keep it alive, silence takes it offline", () => {
  let s = S.hello(S.initialSession(T), T);
  s = S.heartbeat(s, T + 60_000);
  assert.equal(S.tick(s, T + 60_000 + S.HEARTBEAT_GRACE_MS - 1).state, "ready");
  assert.equal(S.tick(s, T + 60_000 + S.HEARTBEAT_GRACE_MS + 1).state, "offline");
});

test("boot timeout takes it offline", () => {
  const { session } = S.ring(S.initialSession(T), T, "s1");
  assert.equal(S.tick(session, T + 1000).state, "booting");
  assert.equal(S.tick(session, T + S.BOOT_TIMEOUT_MS + 1).state, "offline");
});

test("draining only from ready; bye always offline", () => {
  const off = S.initialSession(T);
  assert.equal(S.draining(off, T).state, "offline");
  const ready = S.hello(off, T);
  const dr = S.draining(ready, T + 1);
  assert.equal(dr.state, "draining");
  assert.equal(S.gone(dr, T + 2).state, "offline");
});

test("alarms: none when offline, deadline when ready", () => {
  assert.equal(S.nextAlarm(S.initialSession(T)), null);
  const ready = S.hello(S.initialSession(T), T);
  assert.equal(S.nextAlarm(ready), ready.deadline! + 1);
});
