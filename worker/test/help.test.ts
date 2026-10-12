import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COMMANDS, helpText, menuFor } from "../src/help.ts";

const guide = readFileSync(new URL("../../docs/GUIDE.md", import.meta.url), "utf8");

test("docs/GUIDE.md documents every command and alias", () => {
  for (const c of COMMANDS) {
    assert.ok(guide.includes(`/${c.command}`), `GUIDE.md is missing /${c.command}`);
    for (const a of c.aliases ?? []) assert.ok(guide.includes(`/${a}`), `GUIDE.md is missing /${a}`);
  }
});

test("/help lists exactly the commands of the role", () => {
  const admin = helpText("admin", "courier");
  const member = helpText("member", "courier");
  for (const c of COMMANDS) {
    const usage = c.usage ?? `/${c.command}`;
    assert.equal(admin.includes(usage), c.roles.includes("admin"), `admin help and ${usage}`);
    assert.equal(member.includes(usage), c.roles.includes("member"), `member help and ${usage}`);
  }
  assert.ok(!admin.includes("{courier}"));
});

test("menus fit Telegram's limits", () => {
  for (const role of ["admin", "member"] as const) {
    for (const m of menuFor(role)) {
      assert.match(m.command, /^[a-z0-9_]{1,32}$/);
      assert.ok(m.description.length >= 1 && m.description.length <= 256);
    }
  }
});

test("/help stays under Telegram's 4096-character message limit", () => {
  assert.ok(helpText("admin", "courier").length < 4096);
});
