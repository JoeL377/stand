// Builds native/stand-native.node from native/stand-native.mm, and native/stand-ocr (which
// reads the text in a snap) from native/stand-ocr.m, for Apple silicon and Intel Macs, with
// Apple's command line tools (xcode-select --install). Run before the app starts, it only
// rebuilds what changed. If stand-native fails, the app runs without it (the floating bar
// then briefly brings Stand forward when clicked), and native/build.log says why;
// `--required` makes that failure stop the command instead. If stand-ocr fails, snaps save
// without their text, and native/build-ocr.log says why; that never stops the command.
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

/** Builds `out` from `src` with xcrun when the source is newer; returns whether it's there. */
function build(src, out, log, args) {
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) return true;
  const r = spawnSync("xcrun", args, { encoding: "utf8" });
  const ok = r.status === 0;
  const details = `${r.stdout || ""}${r.stderr || ""}${r.error ? r.error.message : ""}`;
  fs.writeFileSync(log, `${new Date().toISOString()} ${ok ? "built" : "failed"}\nxcrun ${args.join(" ")}\n${details}\n`);
  if (!ok) fs.rmSync(out, { force: true });
  return ok;
}

const MACS = ["-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=13.0"];
const OCR_SRC = path.join(DIR, "stand-ocr.m");
const OCR_OUT = path.join(DIR, "stand-ocr");
const OCR_LOG = path.join(DIR, "build-ocr.log");
const ocr = build(OCR_SRC, OCR_OUT, OCR_LOG, [
  "clang",
  ...["-x", "objective-c", "-fobjc-arc", "-O2"],
  ...MACS,
  ...["-framework", "Foundation", "-framework", "CoreGraphics", "-framework", "ImageIO", "-framework", "Vision"],
  ...["-o", OCR_OUT, OCR_SRC],
]);
if (!ocr) console.warn(`Stand's text reading didn't build, so snaps save without their text. Details: ${path.relative(process.cwd(), OCR_LOG)}`);

const args = [
  "clang++",
  ...["-x", "objective-c++", "-std=c++17", "-fobjc-arc", "-O2"],
  ...MACS,
  ...["-bundle", "-undefined", "dynamic_lookup", "-framework", "AppKit", "-framework", "CoreGraphics"],
  ...["-o", OUT, SRC],
];
if (!build(SRC, OUT, LOG, args)) {
  const where = path.relative(process.cwd(), LOG);
  if (required) {
    console.error(`\nStand's native Mac code didn't build. Details: ${where}\n`);
    process.exit(1);
  }
  console.warn(`Stand's native Mac code didn't build, so the app runs without it. Details: ${where}`);
}
