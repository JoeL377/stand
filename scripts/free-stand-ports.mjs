// Runs before `npm run try:mac`. Stand's pages are on port 5173 and its API on 3001.
// If an older Stand dev server still holds one of them (from this copy or another
// one), Vite quietly moves to 5174 and the Mac app keeps loading the old server's
// pages. So stop any Stand dev server on those ports first, and stop with a clear
// message when something that isn't Stand holds them.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PORTS = [5173, 3001];

/** lsof's output, or "" when nothing matches or lsof isn't there. */
function lsof(args) {
  try {
    return execFileSync("lsof", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

const listening = (port) => lsof(["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]).split("\n").filter(Boolean).map(Number);
const folderOf = (pid) =>
  lsof(["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    .split("\n")
    .find((l) => l.startsWith("n"))
    ?.slice(1) ?? "";
const short = (dir) => dir.replace(os.homedir(), "~");

function isStand(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name === "standup";
  } catch {
    return false;
  }
}

let blocked = false;
for (const port of PORTS)
  for (const pid of listening(port)) {
    const dir = folderOf(pid);
    if (isStand(dir)) {
      process.kill(pid);
      console.log(`Stopped an older Stand server on port ${port} (${short(dir)}).`);
    } else {
      blocked = true;
      let cmd = "";
      try {
        cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
      } catch {}
      console.error(`Port ${port} is taken by another program (process ${pid}${dir ? ` in ${short(dir)}` : ""}): ${cmd}`);
    }
  }
if (blocked) {
  console.error("Quit it, then run npm run try:mac again.");
  process.exit(1);
}

for (let i = 0; i < 50 && PORTS.some((p) => listening(p).length); i++) await new Promise((r) => setTimeout(r, 100));
