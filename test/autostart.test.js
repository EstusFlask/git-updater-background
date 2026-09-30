'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const autostart = require('../src/autostart');

test('Windows login item launches the stable launcher with the login flag', () => {
  let saved;
  const app = {
    isPackaged: true,
    setLoginItemSettings: (value) => { saved = value; },
    getLoginItemSettings: () => ({ openAtLogin: saved.openAtLogin }),
  };
  const launcher = 'C:\\Portable Apps\\git-updater.exe';
  autostart.setEnabled(app, true, launcher, { platform: 'win32' });
  assert.deepEqual(saved, { openAtLogin: true, path: launcher, args: ['--auto-start'] });
  autostart.setEnabled(app, false, launcher, { platform: 'win32' });
  assert.equal(saved.openAtLogin, false);
});

test('macOS login item uses the app registration', () => {
  let saved;
  const app = {
    isPackaged: true,
    setLoginItemSettings: (value) => { saved = value; },
    getLoginItemSettings: () => ({ openAtLogin: saved.openAtLogin }),
  };
  autostart.setEnabled(app, true, '/Applications/git-updater.app', { platform: 'darwin' });
  assert.deepEqual(saved, { openAtLogin: true });
});

test('Linux writes and removes an XDG autostart entry', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-autostart-'));
  const app = { isPackaged: true };
  try {
    const env = { XDG_CONFIG_HOME: base };
    const launcher = '/home/user/My 100% Apps/git-updater';
    autostart.setEnabled(app, true, launcher, { platform: 'linux', env });
    const entry = fs.readFileSync(autostart.linuxEntryPath(env), 'utf8');
    assert.match(entry, /Exec="\/home\/user\/My 100%% Apps\/git-updater" --auto-start/);
    autostart.setEnabled(app, false, launcher, { platform: 'linux', env });
    assert.equal(fs.existsSync(autostart.linuxEntryPath(env)), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('development run cannot register a login item', () => {
  assert.throws(() => autostart.setEnabled({ isPackaged: false }, true, '/app', { platform: 'linux' }), /packaged/);
});
