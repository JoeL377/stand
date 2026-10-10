// Makes the Stand .dmg to hand to teammates: one app for Apple silicon and Intel Macs,
// signed with your Developer ID and notarized by Apple, so it opens on any Mac with no
// warning. Run it on a Mac: `npm run dist`.
//
// `npm run dist:unsigned` makes one without a Developer ID. On another Mac that one
// opens only through System Settings › Privacy & Security › Open Anyway.
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..");
const UNSIGNED = process.argv.includes("--unsigned");
const PROFILE = process.env.APPLE_KEYCHAIN_PROFILE || "stand-notary";
const SETUP = 'the "Share it with your team" steps in desktop/README.md';

function stop(...lines) {
  console.error(`\n${lines.join("\n")}\n`);
  process.exit(1);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}${r.error ? r.error.message : ""}` };
}

if (process.platform !== "darwin") stop("Build the Mac app on a Mac.");

if (!UNSIGNED) {
  const ids = run("security", ["find-identity", "-v", "-p", "codesigning"]).out;
  const id = /"(Developer ID Application: [^"]+)"/.exec(ids);
  if (!id) {
    stop(
      'There\'s no "Developer ID Application" certificate in your keychain yet.',
      `Make one with ${SETUP}, or run \`npm run dist:unsigned\` for now.`,
    );
  }
  console.log(`Signing as ${id[1]}`);

  // electron-builder notarizes when it finds Apple credentials in the environment. The
  // usual ones are a notarytool profile saved in the keychain, so nothing secret is
  // typed here or kept in a file.
  if (!process.env.APPLE_ID && !process.env.APPLE_API_KEY) {
    const check = run("xcrun", ["notarytool", "history", "--keychain-profile", PROFILE]);
    if (!check.ok && /xcrun: error|unable to find utility/.test(check.out)) {
      stop("Apple's notary tool isn't installed. Run `xcode-select --install`, then try again.");
    }
    if (!check.ok) {
      stop(
        `Apple didn't accept the notary sign-in saved as "${PROFILE}":`,
        check.out.trim().split("\n").slice(-2).join("\n"),
        `Save it again with ${SETUP}.`,
      );
    }
    process.env.APPLE_KEYCHAIN_PROFILE = PROFILE;
    console.log(`Notarizing with the "${PROFILE}" sign-in from your keychain`);
  }
}

// The floating bar's native code goes in the app, so here a failed build stops the .dmg.
const native = spawnSync(process.execPath, [path.join(__dirname, "build-native.js"), "--required"], { stdio: "inherit" });
if (native.status !== 0) process.exit(1);

const { build, Platform, Arch } = require("electron-builder");

const unsignedConfig = {
  mac: { identity: "-", hardenedRuntime: false },
  dmg: { artifactName: "Stand-${version}-mac-unsigned.${ext}" },
};

build({
  projectDir: DIR,
  targets: Platform.MAC.createTarget("dmg", Arch.universal),
  config: UNSIGNED ? unsignedConfig : undefined,
})
  .then((files) => {
    const dmg = files.find((f) => f.endsWith(".dmg"));
    if (!dmg) stop("electron-builder finished without a .dmg.");
    const mb = Math.round(fs.statSync(dmg).size / 1e6);
    const where = path.relative(DIR, dmg);

    if (UNSIGNED) {
      console.log(`\nMade ${where} (${mb} MB), not signed.`);
      console.log("On another Mac: open it, drag Stand to Applications and open Stand. When macOS blocks it,");
      console.log("go to System Settings › Privacy & Security and click Open Anyway.\n");
      return;
    }

    const app = path.join(path.dirname(dmg), "mac-universal", "Stand.app");
    const verdict = run("spctl", ["--assess", "--type", "execute", "-vv", app]).out;
    if (!/source=Notarized Developer ID/.test(verdict)) {
      stop(`Made ${where}, but macOS doesn't see it as notarized yet:`, verdict.trim());
    }
    console.log(`\nReady to share: ${where} (${mb} MB)`);
    console.log("Signed with your Developer ID and notarized by Apple, so it opens on any Mac.\n");
  })
  .catch((err) => stop(String((err && err.message) || err)));
