'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ARG = '--auto-start';

function desktopQuote(value) {
  return `"${String(value).replace(/([\\"`$])/g, '\\$1').replace(/%/g, '%%')}"`;
}

function linuxEntryPath(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'git-updater.desktop');
}

function setEnabled(app, enabled, launcherPath, opts = {}) {
  const platform = opts.platform || process.platform;
  if (!app.isPackaged && enabled) throw new Error('auto-start requires a packaged app');
  if (platform === 'linux') {
    const file = linuxEntryPath(opts.env);
    if (!enabled) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=git-updater\nExec=${desktopQuote(launcherPath)} ${ARG}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
    return;
  }
  if (platform !== 'win32' && platform !== 'darwin') throw new Error(`auto-start is unsupported on ${platform}`);
  const settings = platform === 'darwin'
    ? { openAtLogin: !!enabled }
    : { openAtLogin: !!enabled, path: launcherPath, args: [ARG] };
  app.setLoginItemSettings(settings);
  if (app.getLoginItemSettings && app.getLoginItemSettings(settings).openAtLogin !== !!enabled) {
    throw new Error('the operating system did not apply the auto-start setting');
  }
}

module.exports = { ARG, linuxEntryPath, setEnabled };
