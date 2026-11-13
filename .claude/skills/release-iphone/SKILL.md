---
name: release-iphone
description: Build Stand's iPhone app and upload it to TestFlight so testers get an update. Use when asked to "release the iPhone app", "ship to TestFlight", "push an app update" or after a change under iphone/ has merged. Not needed for web or server changes - the app loads the live site, so those reach phones with a normal deploy.
---

# Release the iPhone app

The iPhone app (`iphone/`) is a native shell around the live site. **Only changes under `iphone/` need a release**: Swift code, the icon, permissions, `capacitor.config.json`. Everything in `src/` reaches the app the moment it deploys. If the ask is "get my change onto phones" and nothing under `iphone/` changed since the last release, say so and don't release.

## Where it runs

On a Mac with Xcode, signed in to the team's Apple account in Xcode (Settings > Accounts). In a cloud session, start a Remote Control session on the person's Mac and run it there; a cloud container can't build iOS apps.

## Steps

1. Use a clean checkout of `main` on the Mac (the team keeps one at `~/Projects/stand-iphone`): `git fetch origin main && git checkout main && git pull`. Don't release from a branch unless asked to.
2. Check what changed since the last release: `git log --oneline $(git describe --tags --match 'iphone-*' --abbrev=0 2>/dev/null || echo HEAD~20)..HEAD -- iphone/`.
3. Dry run first if the native code changed: `npm --prefix iphone run release -- --no-upload`. It builds, signs and checks the push entitlement, and leaves `iphone/build/export/App.ipa`.
4. Release: `npm --prefix iphone run release`. Add `VERSION=1.1` in front to change the version people see. The build number is the time, so it always goes up.
5. Tag it so the next release knows where this one was: `git tag iphone-<build number> && git push origin iphone-<build number>`.
6. Tell the person: the build number, that Apple takes 10 to 20 minutes to process it, and that internal testers get it straight away while external testers wait for Apple's beta review only when the version number changed (new builds of an approved version usually pass without one).

## An upload is outward-facing

Uploading puts a build in front of the team's testers. Do it only when the person asked for a release in their own words.

## When it fails

- **"No Accounts" / "No signing certificate"**: Xcode isn't signed in on this Mac. The person opens Xcode > Settings > Accounts and signs in. Never ask for the password in chat.
- **Agreement errors ("PLA Update available")**: the person accepts the new agreement at developer.apple.com/account.
- **A keychain prompt on the Mac**: the person clicks Always Allow.
- **"The bundle version must be higher"**: the clock-based build number went backwards; run again with `BUILD=<higher number>`.
- **Product > Archive in Xcode fails with "no devices"**: expected until an iPhone is registered to the team. This script doesn't need one; see the comment at the top of `iphone/scripts/release.sh`.
