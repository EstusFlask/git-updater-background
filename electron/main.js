'use strict';

// Electron main process — the standalone GUI. Replaces the localhost web server:
// the renderer talks to the engine over IPC (no socket), the engine runs in-process
// (no shell, no self-elevation), and closing the window exits everything (on-demand).

const { app, BrowserWindow, ipcMain, dialog, shell, screen, net } = require('electron');
const fs = require('fs');
const path = require('path');
const core = require('../src/core');
const github = require('../src/github');
const runner = require('../src/runner');
const state = require('../src/state');
const detect = require('../src/detect');
const platform = require('../src/platform');
const paths = require('../src/paths');
const catalog = require('../src/catalog');
const selfupdate = require('../src/selfupdate');
const autostart = require('../src/autostart');
const { log, LOG_FILE } = require('../src/log');

// macOS self-updates in place via Squirrel.Mac (electron/macupdate.js), not the launcher model
// in src/selfupdate.js. Required only on macOS, so electron-updater never loads on Win/Linux.
const IS_MAC = process.platform === 'darwin';
const macupdate = IS_MAC ? require('./macupdate') : null;

// Force HTTP/1.1 for all of Chromium's networking. TLS-inspecting corporate middleboxes
// (FortiEDR/FortiGate SSL inspection and the like) frequently mangle HTTP/2 streams, which
// surfaces as net::ERR_HTTP2_PROTOCOL_ERROR mid-download and kills self-update on managed
// machines even when nothing is actually being blocked. We keep using Electron net.fetch —
// it trusts the OS certificate store and proxy, which Node's https would not behind SSL
// inspection — and only drop the transport to h2-free HTTP/1.1. Must run before app ready.
app.commandLine.appendSwitch('disable-http2');

log(`--- git-updater ${app.getVersion()} started ---`);
process.on('uncaughtException', (e) => log(`UNCAUGHT: ${e && e.stack ? e.stack : e}`));
process.on('unhandledRejection', (e) => log(`UNHANDLED: ${e && e.stack ? e.stack : e}`));

// Self-update layout (see src/selfupdate.js): the exe at ROOT is the launcher, updated versions
// live in ROOT\app-<version>\. Whichever copy this is, ROOT is where new versions land.
const ROOT = selfupdate.layout(process.execPath).root;

function dirHasFiles(dir) {
  try {
    return !!dir && fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}
function portableDir(cfg, r) {
  if (r.install && r.install.dir) return r.install.dir;
  return cfg.portableRoot ? `${cfg.portableRoot.replace(/[\\/]+$/, '')}/${r.repo}` : null;
}

// Config lives with state in git-updater's own config dir — never the launch cwd.
const DATA_DIR = paths.configDir();
const CONFIG_PATH = process.env.GITUPDATER_CONFIG || path.join(DATA_DIR, 'config.json');

// One-time import of an older config sitting next to the app or in the cwd.
function migrateConfig() {
  if (fs.existsSync(CONFIG_PATH)) return;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  for (const legacy of [path.join(__dirname, '..', 'config.json'), path.resolve('config.json')]) {
    try {
      if (fs.existsSync(legacy)) {
        fs.copyFileSync(legacy, CONFIG_PATH);
        return;
      }
    } catch {}
  }
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return { portableRoot: '', repos: [] };
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// Light structural check; the portable-folder requirement is enforced at check/update.
function saveConfigFile(cfg) {
  if (!cfg || !Array.isArray(cfg.repos)) throw new Error('config: "repos" must be an array');
  core.downloadLimitBytes(cfg);
  cfg.repos.forEach((r, i) => {
    if (!r.owner || !r.repo) throw new Error(`app ${i + 1}: owner and repo are required`);
    if (r.type !== 'portable' && r.type !== 'installer') throw new Error(`app ${i + 1}: type must be portable or installer`);
  });
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  if (fs.existsSync(CONFIG_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.${stamp}.bak`);
  }
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

let win;
function createWindow() {
  // Tall enough for the whole UI without scrolling, capped at the screen's work area.
  const wa = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 840,
    height: Math.min(1000, wa.height),
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'), // dev + packaged Linux; Win/mac use the bundled app icon

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // renderer can't reach Node — only the narrow `window.api`
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.webContents.once('did-finish-load', () => { if (startupStatus) win.webContents.send('startup:status', startupStatus); });
}

// --- IPC: the only bridge between the renderer and the engine -----------------
ipcMain.handle('config:get', () => readConfig());
ipcMain.handle('state:get', () => state.load());

// Locally-installed version + presence per app, BEFORE checking GitHub.
// Installer -> uninstall-registry DisplayVersion; Portable -> our manifest + folder.
ipcMain.handle('installed:get', async () => {
  detect.clearCache(); // fresh scan — versions change after installs
  const cfg = readConfig();
  const stt = state.load();
  const out = {};
  for (const r of cfg.repos) {
    const key = `${r.owner}/${r.repo}#${r.type}`;
    if (r.type === 'installer') {
      let v = null;
      try {
        v = await detect.installedVersion(r.detect || r.repo);
      } catch {}
      out[key] = { current: v, present: !!v };
    } else {
      const dir = portableDir(cfg, r);
      const rec = stt[key];
      let current = (rec && rec.version) || null;
      let present = dirHasFiles(dir);
      // Neither a managed copy nor a git-updater record: fall back to the OS inventory. The
      // user may have installed the app by hand (e.g. dragged a dmg into /Applications) — it
      // then reads as installed though git-updater does not own the copy. For an SLA-guarded
      // dmg like Deskflow's, which cannot be unpacked unattended, this is the ONLY way it
      // ever shows as present.
      if (!present && !current) {
        let v = null;
        try {
          v = await detect.installedVersion(r.detect || r.repo);
        } catch {}
        if (v) {
          current = v;
          present = true;
        }
      }
      out[key] = { current, present };
    }
  }
  return out;
});
ipcMain.handle('folder:open', (_e, appKey) => {
  const cfg = readConfig();
  const r = cfg.repos.find((x) => `${x.owner}/${x.repo}#${x.type}` === appKey);
  const dir = r && portableDir(cfg, r);
  return dir ? shell.openPath(dir) : 'no folder';
});

// Collect this dir's files as manifest-style relative paths, shallowly (depth<=2 is enough
// to find an app's main exe without walking a whole install tree). Used only when an
// installer app has an InstallLocation but no usable DisplayIcon.
function shallowFiles(dir, depth = 2, prefix = '') {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (depth > 1) out = out.concat(shallowFiles(path.join(dir, e.name), depth - 1, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

// "Open App": launch the installed program behind a tracked row.
//  - portable  -> resolve the main file from our own install manifest + the portable dir.
//  - installer -> the registry DisplayIcon exe, else hunt InstallLocation for it.
// Launch prefers shell.openPath (ShellExecute) — no shell spawn, no temp exec — so it
// stays within the same EDR posture as installs and "Open folder". Linux is the
// exception, and has to be: its launch target is a .desktop entry, and openPath sends
// that to the user's association for application/x-desktop, which on KDE is the text
// editor. The platform layer launches it properly there; see linux.launchApp.
ipcMain.handle('app:launch', async (_e, appKey) => {
  const cfg = readConfig();
  const r = cfg.repos.find((x) => `${x.owner}/${x.repo}#${x.type}` === appKey);
  if (!r) throw new Error('app not found');
  let target = null;

  const portDir = r.type === 'portable' ? portableDir(cfg, r) : null;
  if (portDir && dirHasFiles(portDir)) {
    // A copy git-updater manages: launch it from our own manifest + the portable dir.
    const dir = portDir;
    const rec = state.load()[appKey];
    const files = (rec && rec.files) || shallowFiles(dir, 3);
    // On Unix the execute bit is what separates a program from a LICENSE file sitting at
    // the top of the same archive. core may not stat, so the check is supplied here.
    const isExec = (rel) => {
      try {
        return !!(fs.statSync(path.join(dir, rel)).mode & 0o111);
      } catch {
        return false;
      }
    };
    const rel = core.pickLaunchFile(files, r.repo, process.platform, isExec);
    if (rel) {
      const abs = path.join(dir, rel);
      if (fs.existsSync(abs)) target = abs;
    }
  } else {
    // An installer entry, OR a portable entry with no managed copy — the app was installed
    // by hand (found in the OS inventory, e.g. Deskflow in /Applications). Either way, launch
    // it from the OS's own record.
    const t = await detect.launchTarget(r.detect || r.repo);
    if (t && t.path && fs.existsSync(t.path)) target = t.path;
    if (!target && t && t.location && fs.existsSync(t.location)) {
      const rel = core.pickLaunchFile(shallowFiles(t.location, 2), r.repo, process.platform);
      if (rel) target = path.join(t.location, rel);
    }
  }

  if (!target) throw new Error(`couldn't find ${r.repo}'s program to open — try Open folder`);
  log(`launchApp ${appKey} -> ${target}`);
  if (await platform.launchApp(target)) return { ok: true, path: target };
  const err = await shell.openPath(target); // '' on success, else an OS error string
  if (err) throw new Error(err);
  return { ok: true, path: target };
});
ipcMain.handle('config:save', (_e, cfg) => {
  const previous = readConfig();
  if (!!cfg.autoStart !== !!previous.autoStart) {
    const launcherPath = process.platform === 'linux' && process.env.APPIMAGE
      ? process.env.APPIMAGE
      : path.join(ROOT, path.basename(process.execPath));
    autostart.setEnabled(app, !!cfg.autoStart, launcherPath);
  }
  saveConfigFile(cfg);
  return { ok: true };
});
ipcMain.handle('config:open', () => shell.openPath(CONFIG_PATH));
ipcMain.handle('log:open', () => shell.openPath(LOG_FILE));

// --- "Scan this PC" window: find installed catalog apps and add selected ---
let scanWin = null;
ipcMain.handle('scan:open', (_e, mode) => {
  if (scanWin && !scanWin.isDestroyed()) return scanWin.focus();
  scanWin = new BrowserWindow({
    width: 680,
    height: 680,
    parent: win,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // Linux has no installed-apps mode, so the window always opens on the catalog there
  // rather than on a tab that would answer nothing.
  const wanted = SCAN_PLATFORMS.has(process.platform) ? mode : 'all';
  scanWin.loadFile(path.join(__dirname, '..', 'ui', 'scan.html'), wanted === 'all' ? { query: { mode: 'all' } } : undefined);
});
// "Scan this PC" reads what is ALREADY INSTALLED and offers matches. That is the wrong
// question on Linux, where a package manager already owns most of what it would find:
// accepting a suggestion installs a SECOND copy outside dpkg, and the user ends up with
// two, launching whichever the desktop happens to resolve.
//
// Browsing the catalog is unaffected and stays — it never inspects the system, so none of
// that applies. Windows and macOS keep the scan: there is no system package manager
// updating those apps behind our back, which is the entire reason this program exists.
//
// Refused here as well as hidden in the UI. A disabled button is a suggestion; an empty
// answer from the main process is the guarantee.
const SCAN_PLATFORMS = new Set(['win32', 'darwin']);

ipcMain.handle('app:platform', () => ({ platform: process.platform, canScan: SCAN_PLATFORMS.has(process.platform) }));

ipcMain.handle('scan:run', async () => {
  if (!SCAN_PLATFORMS.has(process.platform)) return [];
  detect.clearCache();
  const tracked = new Set(readConfig().repos.map((r) => `${r.owner}/${r.repo}`.toLowerCase()));
  return catalog.matchInstalled(await detect.allInstalled(), tracked); // filtered to this OS
});
// The whole catalog (for "All known apps" browsing), tracked entries flagged.
ipcMain.handle('catalog:all', () => {
  const tracked = new Set(readConfig().repos.map((r) => `${r.owner}/${r.repo}`.toLowerCase()));
  return catalog.CATALOG
    .map((c) => ({ name: c.name, repo: c.repo, tracked: tracked.has(c.repo.toLowerCase()) }))
    .sort((a, b) => a.name.localeCompare(b.name));
});
// Add selected repos: [{repo: "owner/name", type: "portable"|"installer"}].
ipcMain.handle('scan:add', (_e, items) => {
  if (!Array.isArray(items)) throw new Error('items must be an array');
  const cfg = readConfig();
  if (!Array.isArray(cfg.repos)) cfg.repos = [];
  if (items.some((i) => i && i.type === 'portable') && !cfg.portableRoot) {
    throw new Error('set the portable apps folder first (main window → Settings), then add portable apps');
  }
  let added = 0;
  for (const it of items) {
    const m = /^([^/]+)\/([^/]+)$/.exec(String(it && it.repo));
    const type = it && it.type === 'portable' ? 'portable' : 'installer';
    if (!m) continue;
    if (cfg.repos.some((r) => r.owner === m[1] && r.repo === m[2] && r.type === type)) continue;
    cfg.repos.push({ owner: m[1], repo: m[2], type });
    added++;
  }
  if (added) saveConfigFile(cfg);
  if (win && !win.isDestroyed()) win.webContents.send('config-changed');
  if (scanWin && !scanWin.isDestroyed()) scanWin.close();
  return { added };
});
// Close a tracked app's running processes (graceful; force on request).
ipcMain.handle('app:close', async (_e, { appKey, force }) => {
  const r = readConfig().repos.find((x) => `${x.owner}/${x.repo}#${x.type}` === appKey);
  if (!r) throw new Error('app not found');
  log(`closeApp ${appKey} force=${!!force}`);
  return detect.closeApp(r.process || r.repo, { force: !!force });
});
// Validate a repo has a usable release before it's added (throws -> rejects).
ipcMain.handle('repo:validate', async (_e, { owner, repo, prerelease }) => {
  const rel = await github.getLatestRelease(owner, repo, { prerelease });
  return { ok: true, tag: rel.tag_name };
});
ipcMain.handle('release:open', (_e, { owner, repo }) =>
  shell.openExternal(`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`)
);
// Preview which Windows asset auto-pick would choose for the latest release.
ipcMain.handle('asset:preview', async (_e, appKey) => {
  const repo = readConfig().repos.find((r) => `${r.owner}/${r.repo}#${r.type}` === appKey);
  if (!repo) throw new Error('app not found');
  const rel = await github.getLatestRelease(repo.owner, repo.repo, { prerelease: repo.prerelease, tagPrefix: repo.tagPrefix });
  const asset = repo.asset ? core.matchAsset(rel.assets, repo.asset) : core.pickAsset(rel.assets, repo.type);
  return { tag: rel.tag_name, asset: asset.name };
});
// --- Self-update (portable, run-as-is) ----------------------------------------
// Checked only when the user runs "Check all" — no network at startup, same as
// tracked apps. Compares the latest release tag with the running version; on Update,
// downloads+verifies+extracts the new build, then hands off to a detached helper (a
// second copy of this same exe) to swap it in and relaunch once this process exits.
ipcMain.handle('selfupdate:check', async () => {
  if (!app.isPackaged) return null; // dev run
  try {
    const cfg = readConfig();
    const prerelease = !!cfg.selfUpdatePrerelease; // self-update beta channel (Settings)
    if (IS_MAC) {
      // macOS applies in place via Squirrel.Mac (electron-updater), reading latest-mac.yml off
      // our GitHub releases — so what the banner reports is exactly what will install.
      const found = await macupdate.check({ prerelease });
      return found ? { version: found.version, canApply: true } : null;
    }
    const found = await selfupdate.checkForUpdate(app.getVersion(), { prerelease });
    return found ? { version: found.version, canApply: selfupdate.canApply() } : null;
  } catch (e) {
    log(`selfupdate check: ${e && e.message ? e.message : e}`); // e.g. no releases yet
    return null;
  }
});
ipcMain.handle('selfupdate:lastApply', () => selfupdate.consumeApplyMarker(app.getVersion()));
// The releases page for git-updater itself. The URL is built HERE, from the engine's own
// constants — the renderer never passes a URL across the bridge, same as release:open.
ipcMain.handle('selfupdate:openRelease', () =>
  shell.openExternal(`https://github.com/${selfupdate.REPO.owner}/${selfupdate.REPO.repo}/releases`)
);
ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select the portable apps folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return { path: r.canceled || !r.filePaths.length ? '' : r.filePaths[0] };
});
// A check can discover that an app is typed as something the project does not publish,
// in either direction (see retypeIfUnavailable in src/runner.js). The runner only
// decides; persisting belongs here, because config.json is the main process's to own.
// Never silent: the renderer reports what changed and why, and it is logged.
function applyRetypes(results) {
  const changes = (results || []).filter((r) => r.retyped && (r.retyped.to === 'portable' || r.retyped.to === 'installer'));
  if (!changes.length) return;
  const cfg = readConfig();
  const hits = { portable: [], installer: [] };
  for (const r of changes) {
    const m = /^([^/]+)\/([^/]+)#(.+)$/.exec(r.id || '');
    if (!m) continue;
    const [, owner, repo, type] = m;
    const to = r.retyped.to;
    // If the user already tracks this repo as the target type, correcting would create a
    // duplicate entry. Leave the miscast one alone and let them untrack it.
    if (cfg.repos.some((x) => x.owner === owner && x.repo === repo && x.type === to)) continue;
    const entry = cfg.repos.find((x) => x.owner === owner && x.repo === repo && x.type === type);
    if (!entry) continue;
    entry.type = to;
    // Portable needs a folder to unpack into. Installer does not, but the folder is kept
    // rather than dropped so switching back by hand does not lose the chosen location.
    if (to === 'portable') entry.install = { ...(entry.install || {}), dir: r.retyped.dir };
    hits[to].push(`${owner}/${repo}`);
  }
  if (!hits.portable.length && !hits.installer.length) return;
  saveConfigFile(cfg);
  if (hits.portable.length) log(`retyped to portable (no installer published): ${hits.portable.join(', ')}`);
  if (hits.installer.length) log(`retyped to installer (no portable build published): ${hits.installer.join(', ')}`);
  if (win && !win.isDestroyed()) win.webContents.send('config-changed');
}

ipcMain.handle('check', async (_e, body = {}) => {
  const config = core.validateConfig(readConfig());
  const out = await runner.run(config, { mode: 'check', only: body.only });
  applyRetypes(out.results);
  return out;
});

let updating = false; // in-process guard; state lock guards other processes
ipcMain.handle('update', async (e, body = {}) => {
  if (updating) throw new Error('an update is already in progress');
  updating = true;
  let lock = null;
  try {
    const config = core.validateConfig(readConfig());
    if (!body.dryRun) lock = state.acquireLock();
    // Stream per-app progress to the renderer as it happens.
    const onProgress = (id, phase, pct) => e.sender.send('update:progress', { id, phase, pct });
    const openFile = (f) => shell.openPath(f); // ShellExecute: an installer's UAC manifest works
    return await runner.run(config, { only: body.only, force: !!body.force, dryRun: !!body.dryRun, onProgress, openFile });
  } finally {
    state.releaseLock(lock);
    updating = false;
  }
});

// Downloads+verifies+extracts the new build into ROOT\app-<version>\ (nothing running is
// touched), then restarts through the launcher, which hands off to it once this process is gone.
ipcMain.handle('selfupdate:apply', async (e) => {
  if (updating) throw new Error('an update is already in progress');
  if (!app.isPackaged) throw new Error('self-update is unavailable in a dev run');
  updating = true;
  try {
    const onProgress = (phase, pct) => e.sender.send('update:progress', { id: 'self', phase, pct });
    const cfg = readConfig();
    const prerelease = !!cfg.selfUpdatePrerelease; // self-update beta channel (Settings)
    if (IS_MAC) {
      // Squirrel.Mac downloads+verifies the signed zip, swaps the bundle and relaunches; it
      // owns the restart, so there is no launcher hand-off or app.exit here.
      const r = await macupdate.apply({ onProgress, prerelease });
      log(`self-update(mac): restarting into ${r.version}`);
      return r;
    }
    const { tag } = await selfupdate.prepareUpdate(ROOT, app.getVersion(), onProgress, { prerelease, maxBytes: core.downloadLimitBytes(cfg) });
    selfupdate.writeApplyMarker({ expectVersion: tag });
    selfupdate.relaunchViaLauncher(ROOT, process.pid);
    log(`self-update: restarting into ${tag}`);
    setTimeout(() => app.exit(0), 300); // let the IPC reply below flush before this process dies
    return { relaunching: true, version: tag };
  } catch (e) {
    log(`self-update FAILED: ${e && e.stack ? e.stack : e}`);
    throw e;
  } finally {
    updating = false; // only reached on a failure before the relaunch was started
  }
});

// --- login run: check tracked installed apps, optionally prompt, then exit ---
let startupStatus = '';
let startupRunning = false;
let loginRun = false;
let manualOpenedDuringStartup = false;
ipcMain.handle('startup:mode', () => loginRun);
function reportStartup(message) {
  startupStatus = message;
  log(`auto-start: ${message}`);
  if (win && !win.isDestroyed()) win.webContents.send('startup:status', message);
}

async function installedForStartup(repo, cfg) {
  if (repo.type === 'portable' && dirHasFiles(portableDir(cfg, repo))) return true;
  try { return !!(await detect.installedVersion(repo.detect || repo.repo)); }
  catch { return false; }
}

async function waitForExternalInstall(repo, before, targetVersion) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      detect.clearCache();
      const current = await detect.installedVersion(repo.detect || repo.repo);
      if (current && current !== before && core.cmpVersion(current, targetVersion) >= 0) return true;
    } catch {}
  }
  return false;
}

async function runStartupUpdates() {
  startupRunning = true;
  updating = true;
  try {
    const cfg = readConfig();
    if (!cfg.autoStart) return;
    reportStartup('Checking tracked apps for updates…');
    const checked = await runner.run(core.validateConfig(cfg), { mode: 'check' });
    applyRetypes(checked.results);
    const checkFailures = checked.results.filter((x) => x.status === 'failed');
    for (const r of checkFailures) log(`auto-start check failed ${r.id}: ${r.reason}`);
    // A tracked but absent app is an install, not an update. A retyped entry needs a
    // fresh check on its next run so we never install the wrong package format.
    const available = [];
    for (const r of checked.results.filter((x) => x.status === 'updated' && !x.retyped)) {
      const repo = cfg.repos.find((x) => `${x.owner}/${x.repo}#${x.type}` === r.id);
      if (repo && await installedForStartup(repo, cfg)) available.push(r);
    }
    if (!available.length) {
      reportStartup(checkFailures.length ? `${checkFailures.length} update checks failed; see log.` : 'No updates available.');
      return;
    }
    reportStartup(`${available.length} update${available.length === 1 ? '' : 's'} available.`);
    if (cfg.autoStartPrompt !== false) {
      const options = {
        type: 'question', title: 'git-updater',
        message: `${available.length} app update${available.length === 1 ? '' : 's'} available`,
        detail: available.map((r) => `${r.repo}: ${r.from} → ${r.to}`).join('\n'),
        buttons: ['Update now', 'Later'], defaultId: 0, cancelId: 1, noLink: true,
      };
      const choice = win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      if (choice.response !== 0) { reportStartup('Update postponed.'); return; }
    }
    let done = 0, failed = 0;
    for (const item of available) {
      reportStartup(`Updating ${item.repo} (${done + failed + 1}/${available.length})…`);
      let lock = null;
      try {
        const repo = readConfig().repos.find((x) => `${x.owner}/${x.repo}#${x.type}` === item.id);
        const before = repo ? await detect.installedVersion(repo.detect || repo.repo).catch(() => null) : null;
        lock = state.acquireLock();
        const result = await runner.run(core.validateConfig(readConfig()), {
          only: item.id,
          closeRunningApps: !!cfg.autoStartCloseApps,
          onProgress: (id, phase, pct) => {
            if (phase === 'downloading' && pct != null) reportStartup(`${item.repo}: ${pct}% downloaded`);
          },
          openFile: (file) => shell.openPath(file),
        });
        const row = result.results[0];
        if (row && (row.status === 'updated' || row.status === 'current')) done++;
        else if (repo && row && /installer window opened|disk image opened/.test(row.reason || '')) {
          reportStartup(`Waiting for ${item.repo}'s installer to finish…`);
          if (await waitForExternalInstall(repo, before, item.to)) done++;
          else { failed++; log(`auto-start update timed out waiting for ${item.id}'s installer`); }
        }
        else { failed++; log(`auto-start update failed ${item.id}: ${row && row.reason || 'no result'}`); }
      } catch (e) {
        failed++;
        log(`auto-start update failed ${item.id}: ${e && e.stack ? e.stack : e}`);
      } finally {
        state.releaseLock(lock);
      }
    }
    reportStartup(`${done} updated, ${failed} failed.`);
  } catch (e) {
    log(`auto-start failed: ${e && e.stack ? e.stack : e}`);
    reportStartup(`Update check failed: ${e.message || e}`);
  } finally {
    updating = false;
    startupRunning = false;
    if (manualOpenedDuringStartup) {
      loginRun = false;
      reportStartup('Login update task finished.');
    } else app.quit();
  }
}

// --- lifecycle: launcher hand-off, single instance, login or on-demand --------
(async () => {
  // Relaunch after a self-update: the updating process still holds the single-instance lock
  // until it exits, so wait for it before handing off.
  const waitPid = selfupdate.waitPidArg(process.argv);
  if (waitPid) await selfupdate.waitForExit(waitPid);

  // Launcher role: a newer app-<version> sibling exists -> run that instead of ourselves.
  // Also lets a version folder that is itself outdated defer to the newest one.
  const target = app.isPackaged ? selfupdate.handoffTarget(process.execPath, app.getVersion()) : null;
  if (target) {
    log(`launcher: handing off to ${target.dir}`);
    selfupdate.launch(target.dir, process.argv.includes(autostart.ARG) ? [autostart.ARG] : []);
    app.exit(0);
    return;
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', (_event, argv) => {
    if (argv.includes(autostart.ARG)) return;
    if (startupRunning) manualOpenedDuringStartup = true;
    if (!win || win.isDestroyed()) createWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    // Route the engine's HTTP through Chromium's network stack (Electron net.fetch): it trusts
    // the OS/Windows certificate store, so a corporate VPN/proxy's SSL-inspection root CA — the
    // one the browser already trusts — is honored here too. Node's own fetch ignores that store
    // and fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY on such networks.
    github.setFetch((url, init) => net.fetch(url, init));
    migrateConfig();
    if (app.isPackaged) selfupdate.cleanupLeftovers(ROOT, app.getVersion()).catch(() => {});
    loginRun = app.isPackaged && (process.argv.includes(autostart.ARG) || (IS_MAC && app.getLoginItemSettings().wasOpenedAtLogin));
    if (loginRun) {
      if (readConfig().autoStart && readConfig().autoStartShowWindow) createWindow();
      runStartupUpdates();
    } else {
      createWindow();
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // A visible login run may keep updating after the user closes its window. Ordinary
  // interactive runs still exit when their last window closes.
  app.on('window-all-closed', () => { if (!startupRunning) app.quit(); });
})();
