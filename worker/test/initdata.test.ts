import assert from "node:assert/strict";
import { test } from "node:test";
import { signInitData, validateInitData } from "../src/initdata.ts";

const TOKEN = "123456:TEST-token";
const NOW = 1_760_000_000;
const user = JSON.stringify({ id: 42, first_name: "A" });

test("accepts correctly signed initData", async () => {
  const raw = await signInitData({ auth_date: String(NOW - 10), query_id: "q", user }, TOKEN);
  const r = await validateInitData(raw, TOKEN, 3600, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.user.id, 42);
});

test("field order in the query string does not matter", async () => {
  const raw = await signInitData({ user, auth_date: String(NOW), query_id: "q" }, TOKEN);
  const shuffled = new URLSearchParams([...new URLSearchParams(raw).entries()].reverse()).toString();
  assert.equal((await validateInitData(shuffled, TOKEN, 3600, NOW)).ok, true);
});

test("signature field is part of the checked data", async () => {
  const raw = await signInitData({ auth_date: String(NOW), user, signature: "abc" }, TOKEN);
  assert.equal((await validateInitData(raw, TOKEN, 3600, NOW)).ok, true);
  const tampered = raw.replace("signature=abc", "signature=abd");
  assert.deepEqual(await validateInitData(tampered, TOKEN, 3600, NOW), { ok: false, reason: "bad_hash" });
});

test("rejects a tampered user", async () => {
  const raw = await signInitData({ auth_date: String(NOW), user }, TOKEN);
  const tampered = raw.replace(encodeURIComponent('"id":42'), encodeURIComponent('"id":43'));
  assert.deepEqual(await validateInitData(tampered, TOKEN, 3600, NOW), { ok: false, reason: "bad_hash" });
});

test("rejects another bot's token", async () => {
  const raw = await signInitData({ auth_date: String(NOW), user }, TOKEN);
  assert.deepEqual(await validateInitData(raw, "999:other", 3600, NOW), { ok: false, reason: "bad_hash" });
});

test("rejects stale auth_date", async () => {
  const raw = await signInitData({ auth_date: String(NOW - 7200), user }, TOKEN);
  assert.deepEqual(await validateInitData(raw, TOKEN, 3600, NOW), { ok: false, reason: "expired" });
});

test("rejects missing data", async () => {
  assert.deepEqual(await validateInitData("", TOKEN, 3600, NOW), { ok: false, reason: "missing" });
  assert.deepEqual(await validateInitData("auth_date=1", TOKEN, 3600, NOW), { ok: false, reason: "missing" });
});
