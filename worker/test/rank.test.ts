import assert from "node:assert/strict";
import { test } from "node:test";
import type { Folder } from "../src/protocol.ts";
import { rank, render } from "../src/rank.ts";

const MB = 1024 * 1024;
const prefs = { format: "flac" as const, max_mb: 150, fallback: true };
const folder = (u: string, free: boolean, files: Folder["files"], q = 0, s = 1000): Folder => ({ u, d: `Music\\${u}\\Album`, f: free, q, s, files });

test("filters by format and puts free slots first", () => {
  const fs = [
    folder("busy", false, [["a\\01 song.flac", 30 * MB, "flac", null, 16, 44100, 200]], 5),
    folder("free", true, [["b\\01 song.flac", 31 * MB, "flac", null, 16, 44100, 200], ["b\\01 song.mp3", 8 * MB, "mp3", 320, null, null, 200]]),
  ];
  const r = rank(fs, "t", "flac", prefs, new Map());
  assert.deepEqual(r.items.map((i) => i.u), ["free", "busy"]);
  assert.ok(r.items.every((i) => i.kind === "t" && i.ext === "flac"));
});

test("oversize files sink below normal ones", () => {
  const fs = [
    folder("big", true, [["x\\big.flac", 400 * MB, "flac", null, 24, 96000, 300]]),
    folder("small", false, [["y\\small.flac", 40 * MB, "flac", null, 16, 44100, 300]], 3),
  ];
  assert.deepEqual(rank(fs, "t", "flac", prefs, new Map()).items.map((i) => i.u), ["small", "big"]);
});

test("fallback: no FLAC under max_mb → MP3 320 first", () => {
  const fs = [
    folder("hires", true, [["x\\t.flac", 400 * MB, "flac", null, 24, 192000, 300]]),
    folder("mp3", true, [["y\\t.mp3", 10 * MB, "mp3", 320, null, null, 300], ["y\\t2.mp3", 4 * MB, "mp3", 128, null, null, 300]]),
  ];
  const r = rank(fs, "t", "flac", prefs, new Map());
  assert.equal(r.note, "No FLAC under 150 MB, so MP3 320 comes first");
  assert.deepEqual(r.items.map((i) => (i.kind === "t" ? i.ext : "")), ["mp3", "flac"], "128 kbps is not a fallback");
});

test("peer score breaks ties between equal peers", () => {
  const fs = [folder("flaky", true, [["a\\s.flac", 30 * MB, "flac", null, 16, 44100, 1]]), folder("solid", true, [["b\\t.flac", 30 * MB, "flac", null, 16, 44100, 1]])];
  const scores = new Map([["flaky", 0.2], ["solid", 0.9]]);
  assert.deepEqual(rank(fs, "t", "flac", prefs, scores).items.map((i) => i.u), ["solid", "flaky"]);
});

test("identical files from many peers are shown once", () => {
  const same: Folder["files"] = [["x\\Same Song.flac", 30 * MB, "flac", null, 16, 44100, 1]];
  const fs = [folder("p1", true, same), folder("p2", true, same), folder("p3", false, same, 2)];
  const r = rank(fs, "t", "flac", prefs, new Map());
  assert.equal(r.total, 1);
  assert.equal(r.items[0]!.u, "p1");
});

test("albums view groups a folder's matching files", () => {
  const fs = [folder("alb", true, [["d\\01.flac", 30 * MB, "flac", null, 16, 44100, 1], ["d\\02.flac", 32 * MB, "flac", null, 16, 44100, 1], ["d\\cover.jpg", 1 * MB, "jpg", null, null, null, null]])];
  const r = rank(fs, "a", "flac", prefs, new Map());
  assert.equal(r.items.length, 1);
  const a = r.items[0]!;
  assert.equal(a.kind === "a" && a.files.length, 2);
});

test("render: page of 8, page row, toggles, callback data under 64 bytes", () => {
  const fs = [folder("p", true, Array.from({ length: 19 }, (_, i) => [`x\\${String(i).padStart(2, "0")}.flac`, 30 * MB, "flac", null, 16, 44100, 100] as Folder["files"][number]))];
  const ranked = rank(fs, "t", "flac", prefs, new Map());
  const out = render("a1b2c3d4e5", "nine inch nails ghosts", "t", "flac", ranked, 50, 0, { tracks: 19, albums: 1 });
  const kb = out.reply_markup.inline_keyboard;
  assert.equal(kb[0]!.length, 4);
  assert.equal(kb[1]!.length, 4);
  assert.deepEqual(kb[2]!.map((b) => b.text), ["·", "1 / 3", "▶"]);
  assert.equal(kb[3]!.map((b) => b.text).join(","), "· FLAC ·,MP3,Any");
  assert.ok(kb.flat().every((b) => new TextEncoder().encode(b.callback_data).length <= 64));
  assert.match(out.text, /^Seek · nine inch nails ghosts\nFLAC · tracks · 19 tracks · 1 albums/);
});

test("render: later pages number items absolutely and tap the right index", () => {
  const fs = [folder("p", true, Array.from({ length: 19 }, (_, i) => [`x\\${String(i).padStart(2, "0")}.flac`, 30 * MB, "flac", null, 16, 44100, 100] as Folder["files"][number]))];
  const out = render("s", "q", "t", "flac", rank(fs, "t", "flac", prefs, new Map()), 50, 2);
  const kb = out.reply_markup.inline_keyboard;
  assert.deepEqual(kb[0]!.map((b) => b.text), ["17", "18", "19"]);
  assert.equal(kb[0]![0]!.callback_data, "s:s:d:16");
  assert.deepEqual(kb[1]!.map((b) => b.text), ["◀", "3 / 3", "·"]);
  assert.match(out.text, /^17\. 16\.flac/m);
});

test("render: oversize says direct when the tunnel is up", () => {
  const fs = [folder("p", true, [["x\\huge.flac", 80 * MB, "flac", null, 24, 96000, 100]])];
  assert.match(render("s", "q", "t", "flac", rank(fs, "t", "flac", prefs, new Map()), 50, 0, undefined, true).text, / · direct/);
});

test("rank keeps more than one page", () => {
  const fs = [folder("p", true, Array.from({ length: 30 }, (_, i) => [`x\\${i}.flac`, 30 * MB, "flac", null, 16, 44100, 100] as Folder["files"][number]))];
  assert.equal(rank(fs, "t", "flac", prefs, new Map()).items.length, 30);
});

test("render marks files above the upload limit", () => {
  const fs = [folder("p", true, [["x\\huge.flac", 80 * MB, "flac", null, 24, 96000, 100]])];
  assert.match(render("s", "q", "t", "flac", rank(fs, "t", "flac", prefs, new Map()), 50).text, /too large for now/);
});
