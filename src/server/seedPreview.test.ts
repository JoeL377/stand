import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "./db.ts";

const seed = (dataDir: string) =>
  spawnSync(process.execPath, ["--import", "tsx", "scripts/seed-preview.ts"], {
    env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: "test" },
    encoding: "utf8",
  });

test("the preview's sample data still loads, with something in each state", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stand-")), "preview");
  const run = seed(dir);
  assert.equal(run.status, 0, run.stderr);
  const db = openDb(path.join(dir, "standup.db"));
  const sam = db.upsertUser({ googleSub: null, email: "sam@acme.test", name: "Sam Rivera", picture: null });
  const spaces = db.userRooms(sam.id);
  assert.equal(spaces.length, 4);
  const room = spaces.find((s) => s.name === "Acme Checkout")!;
  const todos = db.memberActions(sam.id).filter((n) => n.roomId === room.id);
  assert.ok(todos.some((n) => n.doneAt && n.state !== "dropped"));
  assert.ok(todos.some((n) => n.state === "dropped"));
  assert.equal(db.roomLinks(room.id, "depends_on").length, 1);
  assert.equal(db.roomLinks(room.id, "conflicts").length, 1);
});

test("it wipes its folder, so it won't run on one that isn't named preview", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stand-"));
  const keep = path.join(dir, "keep.txt");
  fs.writeFileSync(keep, "real data");
  assert.equal(seed(dir).status, 1);
  assert.ok(fs.existsSync(keep));
});
