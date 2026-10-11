// Builds native/stand-native.node from native/stand-native.mm, for Apple silicon and Intel
// Macs, with Apple's command line tools (xcode-select --install). Run before the app
// starts, it only rebuilds when the source changed. If the build fails, the app runs
// without it (the floating bar then briefly brings Stand forward when clicked), and
// native/build.log says why. `--required` makes a failure stop the command instead.
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..", "native");
const SRC = path.join(DIR, "stand-native.mm");
const OUT = path.join(DIR, "stand-native.node");
const LOG = path.join(DIR, "build.log");
const required = process.argv.includes("--required");

if (process.platform !== "darwin") process.exit(0);
if (fs.existsSync(OUT) && fs.statSync(OUT).mtimeMs >= fs.statSync(SRC).mtimeMs) process.exit(0);

const args = [
  "clang++",
  ...["-x", "objective-c++", "-std=c++17", "-fobjc-arc", "-O2"],
  ...["-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=13.0"],
  ...["-bundle", "-undefined", "dynamic_lookup", "-framework", "AppKit", "-framework", "CoreGraphics"],
  ...["-o", OUT, SRC],
];
const r = spawnSync("xcrun", args, { encoding: "utf8" });
const ok = r.status === 0;
const details = `${r.stdout || ""}${r.stderr || ""}${r.error ? r.error.message : ""}`;
fs.writeFileSync(LOG, `${new Date().toISOString()} ${ok ? "built" : "failed"}\nxcrun ${args.join(" ")}\n${details}\n`);
if (!ok) {
  fs.rmSync(OUT, { force: true });
  const where = path.relative(process.cwd(), LOG);
  if (required) {
    console.error(`\nStand's native Mac code didn't build. Details: ${where}\n`);
    process.exit(1);
  }
  console.warn(`Stand's native Mac code didn't build, so the app runs without it. Details: ${where}`);
}
