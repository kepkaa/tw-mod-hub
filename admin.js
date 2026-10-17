const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, net: enet } = require('electron');

let unlocked = false;
let remote = { announcement: null, adPatterns: [] };

const cfgFile = () => path.join(app.getPath('userData'), 'admin-config.json');
const DEFAULT_CFG = { announcement: { id: '', text: '' }, adPatterns: [], note: '' };

function readCfg() {
  try { return { ...DEFAULT_CFG, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; }
  catch { return { ...DEFAULT_CFG }; }
}
function writeCfg(c) {
  fs.mkdirSync(path.dirname(cfgFile()), { recursive: true });
  fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 2), 'utf8');
}

const hash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');

function setup(settings, pw) {
  if (settings.adminHash) return { ok: false, error: 'Пароль уже задан' };
  if (String(pw || '').length < 6) return { ok: false, error: 'Минимум 6 символов' };
  settings.adminSalt = crypto.randomBytes(16).toString('hex');
  settings.adminHash = hash(pw, settings.adminSalt);
  unlocked = true;
  return { ok: true };
}
function unlock(settings, pw) {
  if (!settings.adminHash) return { ok: false, error: 'Пароль не задан' };
  const a = Buffer.from(hash(pw, settings.adminSalt), 'hex');
  const b = Buffer.from(settings.adminHash, 'hex');
  unlocked = a.length === b.length && crypto.timingSafeEqual(a, b);
  return unlocked ? { ok: true } : { ok: false, error: 'Неверный пароль' };
}
const lock = () => { unlocked = false; };
const isAdmin = () => unlocked;

const cleanPatterns = (arr) =>
    (Array.isArray(arr) ? arr : []).map((x) => String(x).trim())
        .filter((x) => /^\*:\/\/[^\s]+$/.test(x)).slice(0, 200);

async function fetchRemote(url) {
  if (!/^https:\/\//i.test(url || '')) return remote;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const r = await enet.fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (r.ok) {
      const j = await r.json();
      remote = {
        announcement: j.announcement && j.announcement.text
            ? { id: String(j.announcement.id || ''), text: String(j.announcement.text).slice(0, 500) }
            : null,
        adPatterns: cleanPatterns(j.adPatterns),
      };
    }
  } catch {}
  return remote;
}
const getRemote = () => remote;

module.exports = { setup, unlock, lock, isAdmin, readCfg, writeCfg, cleanPatterns, fetchRemote, getRemote };