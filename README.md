# git-updater-background

A fork of [TeeJS/git-updater](https://github.com/TeeJS/git-updater) adding optional login-time checks/updates, configurable download limits, and closing running apps before updating.

[简体中文](README.zh-CN.md)

<p align="center">
  <img src="docs/logo.png" alt="git-updater" width="440">
</p>

**Keep your apps up to date straight from their GitHub releases. Windows, macOS and Linux.**

A ton of great software ships on GitHub — and nothing keeps it updated. git-updater is a
self-hosted **Ninite replacement**: you pick the apps, it checks their latest releases and
updates them, portable apps and installed programs alike. No accounts or store — just your
list and GitHub.

## Get this fork

Download the files actually listed in [this fork's Releases](https://github.com/EstusFlask/git-updater-background/releases). Its published `v0.2.6` assets are Windows x64/arm64 ZIPs: extract a ZIP and run `git-updater.exe`. For other platforms, use a source build or consult upstream releases; upstream binaries do not automatically include this fork's changes.

The upstream application supports Windows, macOS, and Linux. Signing, notarization, and available package formats depend on the specific build; upstream release assurances do not establish the signing status of a fork build. The macOS notes below describe upstream packaging behavior.

## What it does

- **Tracks any app that ships GitHub releases.** Paste a releases URL (or `owner/repo`),
  say whether you want it *portable* or *installed*, done. It figures out the right download
  for your machine by itself — platform, architecture, archive vs installer, even matching
  the format an app is already installed in (MSI vs EXE on Windows, deb vs rpm on Linux) so
  you never end up with duplicates.
- **Shows what you actually have.** *Current* comes from the system itself — the uninstall
  registry on Windows, the app bundle's own version on macOS, dpkg/rpm/flatpak/snap on
  Linux, or the portable folder — not from what some tool remembers doing. Next to it: the
  latest available version and a live status.
- **Updates on your terms.** Per-app Check/Update buttons, or *Check all* / *Update all*
  batches with live progress (Downloading 42% → Verifying → Installing). Each row has an
  overflow menu: Edit, Force reinstall, Close app & update, View release, Open folder,
  Stop tracking.
- **Scan this PC** (Windows and macOS). Finds programs you already have that git-updater
  recognizes — a curated catalog of 120+ GitHub-released apps (browsers, media, dev tools,
  AI tools, runtimes), filtered to the ones that exist on your platform — and adds the ones
  you pick. Not offered on Linux, where your package manager already owns most of what it
  would find and accepting a suggestion would give you a second copy outside it. Browsing
  the whole catalog and cherry-picking works everywhere.
- **Safe by default.** Every download is checksum-verified. Portable updates are
  transactional — a failed or interrupted update restores the previous version completely,
  and your settings inside the app folder survive. Installers that need admin rights fall
  back to their own window with a normal UAC prompt.
- **Configurable download limit.** Settings defaults to 500 MiB per asset. Raise the
  limit for large installers or turn it off; large files are hashed and inspected in chunks.
- **Optional login updates.** In Settings, start at login to check tracked apps, choose
  whether to ask before updating, whether to close running apps before installing, and
  whether to show the window. Closing apps tries a normal exit first and then forces them
  closed if needed; unsaved work may be lost. The task updates apps already installed and
  exits when complete. It also tells you when git-updater itself
  has a new release during a manual check.

## On macOS

**Only notarized apps will run.** git-updater will install any app you point it at, but
on Apple Silicon macOS refuses to LAUNCH anything that is not notarized — including an app
signed with a valid Developer ID that was simply never notarized, which it treats exactly
as it treats an unsigned one. git-updater cannot change that, and does not try to.

**Downloads keep their quarantine flag.** macOS attaches it, Apple's own copy tool carries
it across unchanged, and git-updater does not strip it. One consequence worth knowing: an
app you had previously approved by hand is replaced whole by an update, and the new copy
arrives carrying the download's own quarantine — so your earlier approval does not carry
over with it.

**An update that would damage an app is rolled back.** A macOS application is sealed, and
a single stray file inside it stops macOS accepting it. If an update leaves a bundle whose
signature no longer verifies, git-updater puts the previous version back rather than
leaving you with the damaged one.

**git-updater updates itself in place on Windows and Linux**, where the new version is
installed in its own folder and the launcher switches to it on next start. On macOS it
tells you a new version exists and sends you to the release page instead: an app bundle is
the unit macOS launches, so there is nowhere to put a launcher that is not itself inside
the thing being replaced.

## Quick start

1. Open Settings (top right) and pick your **portable apps folder** (`C:\PortableApps`,
   `~/Applications`, `~/Apps` — wherever you like).
2. **Add app** → paste a GitHub releases URL → choose Portable or Installer.
3. **Check all**, then **Update all**. That's it.

Prefer beta builds for a specific app? Tick *include beta (pre-release) versions* when
adding it.

## On the open-quake panel

git-updater is also available as a **drop-in app for [open-quake](https://github.com/TeeJS/open-quake)**
(Settings → Drop-In Apps → Browse). It shares the same app list and state with the desktop
version — add apps here, update them from the panel, or vice versa.

## For developers

```bash
npm install && npm start   # run from source
npm test                   # engine tests
npm run dist               # build the portable zips (signed when the machine has the signing setup)
```

`npm run dist:mac` and `npm run dist:linux` build the other two (each must run on that OS).

There's also a headless CLI (`node bin/watch.js check|update`) for scripting. Config lives in
git-updater's own folder — `%APPDATA%\git-updater\` on Windows, `~/Library/Application
Support/git-updater/` on macOS, `~/.config/git-updater/` on Linux. Per-app overrides (asset
patterns, custom install dirs, installer switches), architecture notes, and design details
are in **[docs/INTERNALS.md](docs/INTERNALS.md)**.
