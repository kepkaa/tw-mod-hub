// на '//' не  смотрите, эт я для себя пишу

const { app, BrowserWindow, ipcMain, globalShortcut, session, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const initSqlJs = require('sql.js');
const admin = require('./admin');
const pointsWatcher = require('./points');

let ICON_PATH;
try {
  const base = app.getPath('appData');
  const old = path.join(base, 'TW Mod Hub');
  app.setPath('userData', fs.existsSync(old) ? old : path.join(base, 'tw-mod-hub'));
  try { require('./make-icon').ensure(); } catch {}
  const ip = path.join(__dirname, 'build', 'icon.png');
  if (fs.existsSync(ip)) ICON_PATH = ip;
} catch {}


app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const RENDERER_DIR = path.join(__dirname, 'renderer');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const DEFAULT_CLIENT_ID = '57ave30wqqtpap1f641f6p5fpu57wm';

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const PARTITIONS = {
  twitch: 'persist:twitch',
  telegram: 'persist:telegram',
  discord: 'persist:discord',
};

const DEFAULT_MACROS = [
  { id: 'm1', name: 'Бан', hotkey: 'Ctrl+Alt+B', text: '/ban {nick}' },
  { id: 'm2', name: 'Анбан', hotkey: 'Ctrl+Alt+N', text: '/unban {nick}' },
  { id: 'm3', name: 'Мут 10 мин', hotkey: 'Ctrl+Alt+M', text: '/timeout {nick} 600' },
  { id: 'm4', name: 'Анмут', hotkey: 'Ctrl+Alt+U', text: '/untimeout {nick}' },
];

const DEFAULTS = {
  clientId: '',
  token: '',
  adblock: true,
  accent: '#9146ff',
  compact: false,
  aurora: true,
  confirmBan: true,
  refreshSec: 60,
  chatHeight: 340,
  autoClaim: true,
  autoLive: true,
  panelOpen: true,
  chatMode: 'own',
  remoteUrl: '',
  lastChannel: '',
  macros: DEFAULT_MACROS,
};

let win = null;
let playerPort = 0;
let settings = { ...DEFAULTS };

// ---------- настройки ----------
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    settings = { ...DEFAULTS, ...raw };
  } catch {
    settings = { ...DEFAULTS };
  }
  // один общий публичный Client ID для всех (это не аккаунт и не секрет): каждый заходит своим Twitch-аккаунтом, токен хранится только у него
  settings.clientId = DEFAULT_CLIENT_ID;
  // хуйня, но надо
  for (const k of ['vpnUrl', 'vpnTwitch', 'vpnTelegram', 'vpnDiscord', 'vpnInit', 'proxyTelegram', 'proxyDiscord', 'proxyInit']) {
    delete settings[k];
  }
  saveSettings();
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    console.error('save settings', e);
  }
}
function publicSettings() {
  const { token, adminHash, adminSalt, ...rest } = settings;
  return { ...rest, loggedIn: !!token };
}

// ---------- локальный сервер для плеера Twitch (нужен parent=localhost) ----------
function startPlayerServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname === '/player') {
        const ch = (u.searchParams.get('channel') || '').replace(/[^A-Za-z0-9_]/g, '');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(
            `<!doctype html><html><head><meta charset="utf-8"></head>` +
            `<body style="margin:0;background:#000;overflow:hidden">` +
            `<iframe src="https://player.twitch.tv/?channel=${ch}&parent=localhost&muted=false&autoplay=true" ` +
            `style="position:fixed;inset:0;width:100%;height:100%;border:0" ` +
            `allow="autoplay; fullscreen" allowfullscreen></iframe></body></html>`
        );
      } else {
        // отдаём сам интерфейс по http://localhost:порт/ — иначе плеер Twitch не принимает parent=localhost
        let rel = '/';
        try { rel = decodeURIComponent(u.pathname); } catch {}
        if (rel === '/') rel = '/index.html';
        const file = path.normalize(path.join(RENDERER_DIR, rel));
        if (!file.startsWith(RENDERER_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        fs.createReadStream(file).pipe(res);
      }
    });
    srv.listen(0, '127.0.0.1', () => {
      playerPort = srv.address().port;
      resolve();
    });
  });
}

// ---------- user-agent / блокировка рекламы ----------
let adBlocked = 0;
const AD_PATTERNS = [
  '*://*.ads.twitch.tv/*',
  '*://imasdk.googleapis.com/*',
  '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*',
  '*://*.googleadservices.com/*',
  '*://*.2mdn.net/*',
  '*://*.amazon-adsystem.com/*',
  '*://*.adsrvr.org/*',
  '*://*.moatads.com/*',
  '*://*.criteo.com/*',
  '*://*.serving-sys.com/*',
  '*://*.scorecardresearch.com/*',
  '*://*.adnxs.com/*',
  '*://*.pubmatic.com/*',
  '*://*.rubiconproject.com/*',
  '*://*.casalemedia.com/*',
  '*://*.openx.net/*',
  '*://*.taboola.com/*',
  '*://*.outbrain.com/*',
  '*://*.adform.net/*',
  '*://*.demdex.net/*',
  '*://*.imrworldwide.com/*',
  '*://*.quantserve.com/*',
  '*://*.krxd.net/*',
  '*://*.bluekai.com/*',
  '*://*.sentry.io/*',
  '*://*.branch.io/*',
];

async function setupSessions() {
  for (const p of Object.values(PARTITIONS)) {
    session.fromPartition(p).setUserAgent(UA);
  }
  registerAdblock();
}

// ---------- Twitch OAuth + подписки ----------
function twitchLogin() {
  return new Promise((resolve) => {
    if (!settings.clientId) return resolve({ ok: false, error: 'Сначала укажи Client ID в настройках' });
    const redirect = 'http://localhost';
    const url =
        'https://id.twitch.tv/oauth2/authorize?' +
        new URLSearchParams({
          client_id: settings.clientId,
          redirect_uri: redirect,
          response_type: 'token',
          force_verify: 'true', // всегда показывать экран разрешений, чтобы токен получил все новые права
          scope: [
          'user:read:follows',
          'chat:read',
          'chat:edit',
          'user:read:moderated_channels',
          'moderator:manage:banned_users',
          'moderator:manage:chat_messages',
          'moderator:manage:chat_settings',
          'moderator:manage:shoutouts',
          'moderator:manage:warnings',
          'channel:manage:moderators',
          'channel:manage:vips',
          'channel:manage:polls',
          'channel:manage:predictions',
        ].join(' '),
        });
    const w = new BrowserWindow({
      width: 520,
      height: 760,
      parent: win,
      modal: true,
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITIONS.twitch },
    });
    let done = false;
    const check = (u) => {
      if (done || !u || !u.startsWith(redirect)) return false;
      const params = new URLSearchParams(u.split('#')[1] || '');
      const token = params.get('access_token');
      done = true;
      if (token) {
        settings.token = token;
        saveSettings();
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: params.get('error_description') || 'Вход отменён' });
      }
      w.destroy();
      return true;
    };
    w.webContents.on('will-redirect', (e, u) => {
      if (check(u)) e.preventDefault();
    });
    w.webContents.on('will-navigate', (e, u) => {
      if (check(u)) e.preventDefault();
    });
    w.webContents.on('did-fail-load', (e, code, desc, u) => check(u));
    w.on('closed', () => {
      if (!done) {
        done = true;
        resolve({ ok: false, error: 'Окно входа закрыто' });
      }
    });
    w.loadURL(url);
  });
}

const sendToWin = (ch, d) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, d);
};

async function helixReq(method, p, body) {
  const r = await session.fromPartition(PARTITIONS.twitch).fetch('https://api.twitch.tv/helix' + p, {
    method,
    headers: {
      'Client-Id': settings.clientId,
      Authorization: 'Bearer ' + settings.token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) {
    let msg = '';
    try { msg = (await r.json()).message || ''; } catch {}
    // 401 из-за нехватки прав — токен не сбрасываем, просто просим войти заново с новыми правами
    if (/scope/i.test(msg)) throw new Error('Не хватает прав — выйди и войди в Twitch заново (' + msg + ')');
    settings.token = '';
    meCache = null;
    saveSettings();
    sendToWin('auth-expired');
    throw new Error('auth');
  }
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json()).message || ''; } catch {}
    throw new Error(msg || 'HTTP ' + r.status);
  }
  if (r.status === 204) return {};
  try { return await r.json(); } catch { return {}; }
}
const helix = (p) => helixReq('GET', p);

let meCache = null;
async function getMe() {
  if (meCache && meCache.token === settings.token) return meCache;
  const u = (await helix('/users')).data[0];
  meCache = { id: u.id, login: u.login, token: settings.token };
  return meCache;
}
const userIdCache = new Map();
async function userIdByLogin(login) {
  const l = String(login || '').trim().replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
  if (!l) throw new Error('не указан ник');
  if (userIdCache.has(l)) return userIdCache.get(l);
  const d = (await helix('/users?login=' + encodeURIComponent(l))).data[0];
  if (!d) throw new Error('пользователь не найден: ' + l);
  userIdCache.set(l, d.id);
  return d.id;
}
// '600', '10m', '1h', '2d', '1w' -> секунды
function parseDur(s) {
  const m = String(s || '').trim().match(/^(\d+)\s*([smhdw]?)$/i);
  if (!m) return null;
  const mult = { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2].toLowerCase()];
  return parseInt(m[1], 10) * mult;
}

// Команды /ban, /timeout, /delete и т.д. Twitch больше не принимает через IRC — выполняем через Helix API.
async function runChatCommand(channel, text) {
  try {
    if (!settings.token) throw new Error('нужен вход в Twitch');
    const parts = String(text || '').trim().split(/\s+/);
    const cmd = parts.shift().replace(/^\//, '').toLowerCase();
    const me = await getMe();
    const ch = String(channel || '').replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
    if (!ch) throw new Error('канал не выбран');
    const bid = ch === me.login ? me.id : await userIdByLogin(ch);
    const base = `broadcaster_id=${bid}&moderator_id=${me.id}`;
    const settingsPatch = (data) => helixReq('PATCH', `/chat/settings?${base}`, data);

    switch (cmd) {
      case 'ban':
      case 'timeout': {
        const uid = await userIdByLogin(parts.shift());
        const data = { user_id: uid };
        if (cmd === 'timeout') {
          let d = parseDur(parts[0]);
          if (d == null) d = 600;
          else parts.shift();
          data.duration = Math.min(Math.max(d, 1), 1209600);
        }
        const reason = parts.join(' ').slice(0, 500);
        if (reason) data.reason = reason;
        await helixReq('POST', `/moderation/bans?${base}`, { data });
        break;
      }
      case 'unban':
      case 'untimeout': {
        const uid = await userIdByLogin(parts.shift());
        await helixReq('DELETE', `/moderation/bans?${base}&user_id=${uid}`);
        break;
      }
      case 'delete': {
        const id = parts.shift();
        if (!id) throw new Error('нужен id сообщения');
        await helixReq('DELETE', `/moderation/chat?${base}&message_id=${encodeURIComponent(id)}`);
        break;
      }
      case 'clear':
        await helixReq('DELETE', `/moderation/chat?${base}`);
        break;
      case 'warn': {
        const uid = await userIdByLogin(parts.shift());
        const reason = parts.join(' ').slice(0, 500) || 'Предупреждение от модератора';
        await helixReq('POST', `/moderation/warnings?${base}`, { data: { user_id: uid, reason } });
        break;
      }
      case 'mod':
      case 'unmod': {
        const uid = await userIdByLogin(parts.shift());
        await helixReq(cmd === 'mod' ? 'POST' : 'DELETE', `/moderation/moderators?broadcaster_id=${bid}&user_id=${uid}`);
        break;
      }
      case 'vip':
      case 'unvip': {
        const uid = await userIdByLogin(parts.shift());
        await helixReq(cmd === 'vip' ? 'POST' : 'DELETE', `/channels/vips?broadcaster_id=${bid}&user_id=${uid}`);
        break;
      }
      case 'shoutout':
      case 'so': {
        const uid = await userIdByLogin(parts.shift());
        await helixReq('POST', `/chat/shoutouts?from_broadcaster_id=${bid}&to_broadcaster_id=${uid}&moderator_id=${me.id}`);
        break;
      }
      case 'slow': {
        let d = parseDur(parts[0]);
        if (d == null) d = 30;
        await settingsPatch({ slow_mode: true, slow_mode_wait_time: Math.min(Math.max(d, 3), 120) });
        break;
      }
      case 'slowoff':
        await settingsPatch({ slow_mode: false });
        break;
      case 'followers': {
        const d = parseDur(parts[0]);
        const minutes = d == null ? 0 : Math.min(Math.ceil(d / 60), 129600);
        await settingsPatch({ follower_mode: true, follower_mode_duration: minutes });
        break;
      }
      case 'followersoff':
        await settingsPatch({ follower_mode: false });
        break;
      case 'subscribers':
        await settingsPatch({ subscriber_mode: true });
        break;
      case 'subscribersoff':
        await settingsPatch({ subscriber_mode: false });
        break;
      case 'emoteonly':
        await settingsPatch({ emote_mode: true });
        break;
      case 'emoteonlyoff':
        await settingsPatch({ emote_mode: false });
        break;
      case 'uniquechat':
        await settingsPatch({ unique_chat_mode: true });
        break;
      case 'uniquechatoff':
        await settingsPatch({ unique_chat_mode: false });
        break;
      default:
        throw new Error('команда /' + cmd + ' не поддерживается');
    }
    return { ok: true };
  } catch (e) {
    logErr('chat:command ' + text + ' -> ' + (e && e.message));
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// ---------- блокировка рекламы: встроенные + удалённые + локальные правила ----------
function allAdPatterns() {
  let extra = [];
  try {
    extra = [...(admin.getRemote().adPatterns || []), ...(admin.readCfg().adPatterns || [])];
  } catch {}
  return [...new Set([...AD_PATTERNS, ...extra])];
}
function registerAdblock() {
  // повторный вызов заменяет прежний обработчик — правила обновляются на лету
  session.fromPartition(PARTITIONS.twitch).webRequest.onBeforeRequest({ urls: allAdPatterns() }, (d, cb) => {
    if (settings.adblock) {
      adBlocked++;
      cb({ cancel: true });
    } else cb({});
  });
}

// ---------- удалённый конфиг (объявление + доп. правила рекламы) ----------
let lastAnnSent = '';
async function refreshRemote(force) {
  try {
    const r = await admin.fetchRemote(settings.remoteUrl);
    registerAdblock();
    const a = r && r.announcement;
    if (a && a.text && (force || a.id !== lastAnnSent)) {
      lastAnnSent = a.id;
      sendToWin('remote', r);
    }
    return r;
  } catch (e) {
    logErr('refreshRemote: ' + (e && e.message));
    return admin.getRemote();
  }
}

const avatarCache = {};
async function getFollowed() {
  try {
    if (!settings.clientId || !settings.token) return { ok: false, error: 'auth' };
    const me = await getMe(); // кэш: не дёргаем /users каждый раз
    const live = (await helix(`/streams/followed?user_id=${me.id}&first=100`)).data;
    const avatars = {};
    const miss = live.filter((s) => !avatarCache[s.user_id]);
    if (miss.length) {
      const q = miss.map((s) => 'id=' + s.user_id).join('&');
      (await helix('/users?' + q)).data.forEach((u) => (avatarCache[u.id] = u.profile_image_url));
    }
    live.forEach((s) => (avatars[s.user_id] = avatarCache[s.user_id]));
    return {
      ok: true,
      me: me.login,
      streams: live.map((s) => ({
        login: s.user_login,
        name: s.user_name,
        game: s.game_name,
        viewers: s.viewer_count,
        title: s.title,
        avatar: avatars[s.user_id] || '',
      })),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- AHK ----------
function accelToAhk(acc) {
  const parts = acc.split('+');
  const key = parts.pop();
  let mods = '';
  for (const m of parts) {
    const l = m.toLowerCase();
    if (l === 'ctrl' || l === 'control' || l === 'commandorcontrol') mods += '^';
    else if (l === 'alt') mods += '!';
    else if (l === 'shift') mods += '+';
    else if (l === 'super' || l === 'meta') mods += '#';
  }
  const map = { Return: 'Enter', Up: 'Up', Down: 'Down', Left: 'Left', Right: 'Right' };
  let k = map[key] || key;
  if (/^num\d$/i.test(k)) k = 'Numpad' + k.slice(3);
  if (k.length === 1) k = k.toLowerCase();
  return mods + k;
}
const ahkStr = (s) => s.replace(/`/g, '``').replace(/"/g, '`"');

function buildAhk(macros) {
  let out = '#Requires AutoHotkey v2.0\n#SingleInstance Force\n\n';
  out += '; Сгенерировано из tw-mod-hub. Горячая клавиша печатает команду в активное окно\n';
  out += '; (кликни в поле чата Twitch, нажми хоткей, команда уйдёт Enter-ом).\n\n';
  for (const m of macros) {
    if (!m.hotkey || !m.text) continue;
    const hk = accelToAhk(m.hotkey);
    const needNick = m.text.includes('{nick}');
    out += `; ${m.name}\n${hk}:: {\n`;
    if (needNick) {
      out += `    ib := InputBox("Ник:", "${ahkStr(m.name)}")\n`;
      out += `    if ib.Result != "OK" || ib.Value = ""\n        return\n`;
      out += `    t := StrReplace("${ahkStr(m.text)}", "{nick}", ib.Value)\n`;
    } else {
      out += `    t := "${ahkStr(m.text)}"\n`;
    }
    out += `    SendText(t)\n    Sleep(80)\n    Send("{Enter}")\n}\n\n`;
  }
  return out;
}

// ---------- база данных (SQLite через sql.js) ----------
let db = null;
let dbOk = false;
let dbError = '';
let dbTimer = null;
const errLogFile = () => path.join(app.getPath('userData'), 'error.log');
function logErr(m) {
  try {
    fs.mkdirSync(path.dirname(errLogFile()), { recursive: true });
    fs.appendFileSync(errLogFile(), new Date().toISOString() + '  ' + String(m) + '\n');
  } catch {}
}
process.on('uncaughtException', (e) => logErr('uncaughtException: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => logErr('unhandledRejection: ' + (e && e.stack || e)));
const dbFile = () => path.join(app.getPath('userData'), 'modhub.sqlite');
const cleanLogin = (s) => String(s || '').trim().replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '').toLowerCase();

async function initDb() {
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(__dirname, 'node_modules', 'sql.js', 'dist', f),
  });
  db = fs.existsSync(dbFile()) ? new SQL.Database(fs.readFileSync(dbFile())) : new SQL.Database();
  db.run(`
    CREATE TABLE IF NOT EXISTS mod_actions(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, channel TEXT, action TEXT,
      target TEXT, reason TEXT, duration INTEGER DEFAULT 0, command TEXT);
    CREATE INDEX IF NOT EXISTS idx_ma_target ON mod_actions(target);
    CREATE INDEX IF NOT EXISTS idx_ma_ts ON mod_actions(ts);
    CREATE TABLE IF NOT EXISTS user_notes(nick TEXT PRIMARY KEY, note TEXT, updated INTEGER);
    CREATE TABLE IF NOT EXISTS favorites(channel TEXT PRIMARY KEY, added INTEGER);
    CREATE TABLE IF NOT EXISTS watch_history(id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, ts INTEGER);
  `);
  dbOk = true;
  flushDb();
}
function flushDb() {
  clearTimeout(dbTimer);
  if (!db) return;
  try {
    fs.mkdirSync(path.dirname(dbFile()), { recursive: true });
    fs.writeFileSync(dbFile(), Buffer.from(db.export()));
  } catch (e) {
    console.error('db flush', e);
  }
}
function dbRun(sql, params = []) {
  if (!db) return;
  db.run(sql, params);
  clearTimeout(dbTimer);
  dbTimer = setTimeout(flushDb, 400);
}
function dbAll(sql, params = []) {
  if (!db) return [];
  const st = db.prepare(sql);
  st.bind(params);
  const rows = [];
  while (st.step()) rows.push(st.getAsObject());
  st.free();
  return rows;
}

ipcMain.handle('db:log', (e, a) => {
  dbRun('INSERT INTO mod_actions(ts,channel,action,target,reason,duration,command) VALUES(?,?,?,?,?,?,?)', [
    Date.now(), cleanLogin(a.channel), String(a.action || ''), cleanLogin(a.target),
    String(a.reason || ''), (a.duration | 0), String(a.command || ''),
  ]);
  return true;
});
ipcMain.handle('db:history', (e, { q, limit } = {}) => {
  const n = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const s = String(q || '').trim().toLowerCase();
  if (!s) return dbAll('SELECT * FROM mod_actions ORDER BY ts DESC LIMIT ' + n);
  const like = '%' + s + '%';
  return dbAll(
      'SELECT * FROM mod_actions WHERE lower(target) LIKE ? OR lower(channel) LIKE ? OR lower(action) LIKE ? OR lower(reason) LIKE ? ORDER BY ts DESC LIMIT ' + n,
      [like, like, like, like]
  );
});
ipcMain.handle('db:nick', (e, nick) => {
  const n = cleanLogin(nick);
  const note = dbAll('SELECT note FROM user_notes WHERE nick=?', [n])[0];
  const st = dbAll('SELECT COUNT(*) AS c, MAX(ts) AS last FROM mod_actions WHERE target=?', [n])[0] || {};
  return { note: note ? note.note : '', actions: st.c || 0, last: st.last || 0 };
});
ipcMain.handle('db:noteSet', (e, nick, note) => {
  const n = cleanLogin(nick);
  if (!n) return false;
  if (String(note || '').trim()) {
    dbRun('INSERT OR REPLACE INTO user_notes(nick,note,updated) VALUES(?,?,?)', [n, String(note).trim(), Date.now()]);
  } else {
    dbRun('DELETE FROM user_notes WHERE nick=?', [n]);
  }
  return true;
});
ipcMain.handle('db:stats', () => {
  const start = new Date().setHours(0, 0, 0, 0);
  const today = {};
  dbAll('SELECT action, COUNT(*) AS c FROM mod_actions WHERE ts>=? GROUP BY action', [start]).forEach((r) => (today[r.action] = r.c));
  const total = (dbAll('SELECT COUNT(*) AS c FROM mod_actions')[0] || {}).c || 0;
  return { today, total };
});
ipcMain.handle('db:favs', () => dbAll('SELECT channel FROM favorites ORDER BY added').map((r) => r.channel));
ipcMain.handle('db:favToggle', (e, ch) => {
  const c = cleanLogin(ch);
  if (c) {
    if (dbAll('SELECT 1 FROM favorites WHERE channel=?', [c]).length) dbRun('DELETE FROM favorites WHERE channel=?', [c]);
    else dbRun('INSERT INTO favorites(channel,added) VALUES(?,?)', [c, Date.now()]);
  }
  return dbAll('SELECT channel FROM favorites ORDER BY added').map((r) => r.channel);
});
ipcMain.handle('db:watch', (e, ch) => {
  const c = cleanLogin(ch);
  if (c) dbRun('INSERT INTO watch_history(channel,ts) VALUES(?,?)', [c, Date.now()]);
  return true;
});
ipcMain.handle('db:recent', () =>
    dbAll('SELECT channel, MAX(ts) AS t FROM watch_history GROUP BY channel ORDER BY t DESC LIMIT 10').map((r) => r.channel)
);
ipcMain.handle('db:exportCsv', async () => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Экспорт журнала в CSV',
    defaultPath: 'mod-actions.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false };
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = dbAll('SELECT * FROM mod_actions ORDER BY ts');
  let out = 'time,channel,action,target,reason,duration,command\n';
  for (const x of rows) {
    out += [new Date(x.ts).toISOString(), x.channel, x.action, x.target, x.reason, x.duration, x.command].map(q).join(',') + '\n';
  }
  fs.writeFileSync(r.filePath, '\ufeff' + out, 'utf8');
  return { ok: true, path: r.filePath, count: rows.length };
});

// ---------- окно ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 360,
    minHeight: 520,
    backgroundColor: '#0e0e10',
    autoHideMenuBar: true,
    title: 'Kepka Deck',
    ...(ICON_PATH ? { icon: ICON_PATH } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // окно живёт в сессии Twitch: блокировка рекламы действует и на плеер, и на чат
      partition: PARTITIONS.twitch,
    },
  });
  // диагностика: всё из консоли окна -> error.log, DevTools открывается отдельным окном
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 2) logErr(`console[${level}] ${message} (${String(sourceId).split('/').pop()}:${line})`);
  });
  win.webContents.on('preload-error', (e, p, err) => logErr('preload-error: ' + (err && err.stack || err)));
  win.webContents.on('render-process-gone', (e, d) => logErr('render-process-gone: ' + JSON.stringify(d)));
  win.webContents.on('unresponsive', () => logErr('window unresponsive'));
  win.webContents.on('did-fail-load', (e, code, desc) => logErr('did-fail-load: ' + code + ' ' + desc));
  win.webContents.once('did-finish-load', () => logErr('did-finish-load OK'));
  win.on('closed', () => pointsWatcher.stop()); // скрытое окно баллов не должно держать приложение
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  if (playerPort) win.loadURL(`http://localhost:${playerPort}/index.html`);
  else win.loadFile(path.join(RENDERER_DIR, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function registerHotkeys(macros) {
  globalShortcut.unregisterAll();
  const failed = [];
  for (const m of macros || []) {
    if (!m.hotkey) continue;
    try {
      const ok = globalShortcut.register(m.hotkey, () => {
        if (win && !win.isDestroyed()) win.webContents.send('hotkey', m.id);
      });
      if (!ok) failed.push(m.hotkey);
    } catch {
      failed.push(m.hotkey);
    }
  }
  return failed;
}

// ---------- IPC ----------
ipcMain.handle('app:status', () => ({ dbOk, dbError, userData: app.getPath('userData'), adBlocked, remote: admin.getRemote() }));
ipcMain.handle('app:openData', () => shell.openPath(app.getPath('userData')));
ipcMain.handle('app:logError', (e, m) => {
  logErr('renderer: ' + m);
  return true;
});
ipcMain.handle('settings:get', () => publicSettings());
ipcMain.handle('settings:save', async (e, patch) => {
  const allowed = [
    'adblock',
    'accent', 'compact', 'aurora', 'confirmBan', 'refreshSec', 'chatHeight', 'lastChannel', 'macros',
    'panelOpen', 'chatMode', 'autoClaim', 'autoLive',
  ];
  for (const k of allowed) if (k in patch) settings[k] = patch[k];
  // адрес удалённого конфига меняет только администратор
  if ('remoteUrl' in patch && admin.isAdmin()) settings.remoteUrl = String(patch.remoteUrl || '').trim();
  saveSettings();
  return publicSettings();
});
ipcMain.handle('settings:reset', async () => {
  const token = settings.token;
  const keep = { adminHash: settings.adminHash, adminSalt: settings.adminSalt, remoteUrl: settings.remoteUrl || '' };
  settings = { ...DEFAULTS, ...keep, clientId: DEFAULT_CLIENT_ID, token };
  saveSettings();
  registerHotkeys(settings.macros);
  return publicSettings();
});
ipcMain.handle('twitch:login', () => twitchLogin());
ipcMain.handle('twitch:logout', async () => {
  settings.token = '';
  meCache = null;
  saveSettings();
  pointsWatcher.stop();
  // чистим cookies Twitch в окне входа, чтобы следующий вход мог быть под другим аккаунтом
  try { await session.fromPartition(PARTITIONS.twitch).clearStorageData({ storages: ['cookies'] }); } catch (e) { logErr('logout clear: ' + (e && e.message)); }
  return true;
});
ipcMain.handle('twitch:followed', () => getFollowed());

// все каналы, на которые подписан человек (не только в эфире); нужно право user:read:follows
ipcMain.handle('twitch:following', async () => {
  try {
    if (!settings.token) return { ok: false, error: 'no-token' };
    const me = await getMe();
    const list = [];
    let after = '';
    for (let i = 0; i < 30; i++) { // до 3000 каналов
      const j = await helix(`/channels/followed?user_id=${me.id}&first=100` + (after ? '&after=' + after : ''));
      for (const x of j.data || []) {
        list.push({ login: x.broadcaster_login, name: x.broadcaster_name || x.broadcaster_login, followedAt: x.followed_at });
      }
      after = j.pagination && j.pagination.cursor;
      if (!after) break;
    }
    return { ok: true, list };
  } catch (e) {
    logErr('following: ' + (e && e.message));
    return { ok: false, error: (e && e.message) || String(e) };
  }
});
ipcMain.handle('player:port', () => playerPort);
ipcMain.handle('hotkeys:register', (e, macros) => registerHotkeys(macros));
ipcMain.handle('ahk:export', async (e, macros) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Сохранить AHK-скрипт',
    defaultPath: 'twitch-mod.ahk',
    filters: [{ name: 'AutoHotkey', extensions: ['ahk'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, '\ufeff' + buildAhk(macros), 'utf8');
  return { ok: true, path: r.filePath };
});
ipcMain.handle('open:external', (e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// ---------- чат: авторизация, проверка модератора, команды ----------
ipcMain.handle('chat:auth', async () => {
  if (!settings.token) return { ok: false, reason: 'no-token' };
  try {
    const r = await session.fromPartition(PARTITIONS.twitch).fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: 'OAuth ' + settings.token },
    });
    if (r.status === 401) {
      settings.token = '';
      meCache = null;
      saveSettings();
      sendToWin('auth-expired');
      return { ok: false, reason: 'no-token' };
    }
    const j = await r.json();
    const sc = j.scopes || [];
    if (!sc.includes('chat:read') || !sc.includes('chat:edit')) {
      return { ok: false, reason: 'нужен повторный вход (обновились права доступа)' };
    }
    if (!j.login) return { ok: false, reason: 'no-user' };
    return { ok: true, token: settings.token, login: j.login };
  } catch (e) {
    logErr('chat:auth ' + (e && e.message));
    return { ok: false, reason: 'no-user' };
  }
});

ipcMain.handle('twitch:checkMod', async (e, channel) => {
  try {
    if (!settings.token) return { isMod: false };
    const me = await getMe();
    const ch = cleanLogin(channel);
    if (ch === me.login) return { isMod: true };
    let after = '';
    for (let i = 0; i < 5; i++) {
      const j = await helix(`/moderation/channels?user_id=${me.id}&first=100` + (after ? '&after=' + after : ''));
      if ((j.data || []).some((x) => x.broadcaster_login === ch)) return { isMod: true };
      after = j.pagination && j.pagination.cursor;
      if (!after) break;
    }
    return { isMod: false };
  } catch (err) {
    logErr('checkMod: ' + (err && err.message));
    return { isMod: false };
  }
});

ipcMain.handle('chat:command', (e, channel, text) => runChatCommand(channel, text));

// значки чата (глобальные + канальные) → { 'moderator/1': url, ... }
const badgeCache = new Map();
ipcMain.handle('twitch:badges', async (e, channel) => {
  try {
    if (!settings.token) return {};
    const ch = cleanLogin(channel);
    const hit = badgeCache.get(ch);
    if (hit && Date.now() - hit.t < 3600e3) return hit.map;
    const map = {};
    const add = (j) => (j.data || []).forEach((s) => (s.versions || []).forEach((v) => {
      map[s.set_id + '/' + v.id] = v.image_url_2x || v.image_url_1x;
    }));
    add(await helix('/chat/badges/global'));
    try { add(await helix('/chat/badges?broadcaster_id=' + (await userIdByLogin(ch)))); }
    catch (err) { logErr('channel badges: ' + (err && err.message)); }
    badgeCache.set(ch, { t: Date.now(), map });
    return map;
  } catch (err) {
    logErr('badges: ' + (err && err.message));
    return {};
  }
});

// баллы канала. Официального API для баланса зрителя у Twitch нет, поэтому — неофициальный GQL, может не сработать.
ipcMain.handle('twitch:points', async (e, channel) => {
  try {
    if (!settings.token) return { ok: false, error: 'no-token' };
    const r = await session.fromPartition(PARTITIONS.twitch).fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-Id': settings.clientId, Authorization: 'OAuth ' + settings.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query($l:String!){user(login:$l){channel{self{communityPoints{balance}}}}}',
        variables: { l: cleanLogin(channel) },
      }),
    });
    const j = await r.json();
    const u = j && j.data && j.data.user;
    const b = u && u.channel && u.channel.self && u.channel.self.communityPoints && u.channel.self.communityPoints.balance;
    if (typeof b === 'number') return { ok: true, balance: b };
    logErr('points: unexpected reply ' + JSON.stringify(j).slice(0, 300));
    return { ok: false, error: 'bad-reply' };
  } catch (err) {
    logErr('points: ' + (err && err.message));
    return { ok: false, error: 'fail' };
  }
});

// ---------- баллы канала (скрытое окно) ----------
ipcMain.handle('points:watch', (e, channel) => {
  const ch = cleanLogin(channel);
  if (!ch || !settings.token) { pointsWatcher.stop(); return false; }
  pointsWatcher.start(ch, PARTITIONS.twitch, settings.autoClaim !== false, (d) => sendToWin('points', d));
  return true;
});
ipcMain.handle('points:stop', () => { pointsWatcher.stop(); return true; });

// ---------- отписка от канала ----------
// В официальном API Twitch нет отписки/подписки (убраны в 2023), поэтому кликаем кнопку на странице канала
// в скрытом окне (та же сессия, где выполнен вход). Вёрстка Twitch меняется — может перестать работать.
const UNFOLLOW_CODE = `(async () => {
  const q = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isDone = () => q('[data-a-target="follow-button"]') && !q('[data-a-target="unfollow-button"]');
  for (let i = 0; i < 40; i++) {
    if (isDone()) return { state: 'not-following' };
    const u = q('[data-a-target="unfollow-button"]');
    if (u) {
      u.click();
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      for (let j = 0; j < 24; j++) {
        await sleep(500);
        // пункт меню / кнопка подтверждения «Отписаться» (не сама нажатая кнопка)
        const c = [...document.querySelectorAll('button,[role="menuitem"],[role="button"],a,div[tabindex]')]
          .find((x) => x !== u && !u.contains(x) && visible(x) && /^\\s*(отписаться|unfollow)\\s*$/i.test(x.textContent || ''));
        if (c) c.click();
        if (!q('[data-a-target="unfollow-button"]')) return { state: 'done' };
      }
      const dlg = q('[role="dialog"], .ReactModal__Content');
      return {
        state: 'timeout',
        dialog: dlg ? dlg.innerText.slice(0, 200) : null,
        targets: [...document.querySelectorAll('[data-a-target*="follow"]')].map((x) => x.getAttribute('data-a-target') + ':' + (x.textContent || '').trim().slice(0, 30)),
      };
    }
    await sleep(500);
  }
  return { state: 'nobutton', logged: !!q('[data-a-target="chat-input"]') };
})()`;
ipcMain.handle('twitch:unfollow', async (e, channel) => {
  const ch = cleanLogin(channel);
  if (!ch || !settings.token) return { ok: false, error: 'нужен вход в Twitch' };
  let w;
  try {
    w = new BrowserWindow({
      show: false, width: 1100, height: 800,
      webPreferences: { partition: PARTITIONS.twitch, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    w.webContents.setAudioMuted(true);
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await w.loadURL('https://www.twitch.tv/' + ch).catch(() => {});
    const r = await w.webContents.executeJavaScript(UNFOLLOW_CODE);
    if (r && (r.state === 'done' || r.state === 'not-following')) return { ok: true };
    logErr('unfollow ' + ch + ': ' + JSON.stringify(r));
    return { ok: false, error: r && r.state === 'nobutton' && r.logged === false ? 'не видно входа на twitch.tv — выйди и войди заново' : 'не нашёл кнопку «Отписаться» на странице канала' };
  } catch (err) {
    logErr('unfollow: ' + (err && err.message));
    return { ok: false, error: (err && err.message) || 'ошибка' };
  } finally {
    try { if (w && !w.isDestroyed()) w.destroy(); } catch {}
  }
});

// ---------- опросы и ставки (Helix; только владелец канала) ----------
async function ownerId(channel) {
  const me = await getMe();
  if (cleanLogin(channel) !== me.login) {
    throw new Error('Опросы и ставки через API доступны только на своём канале. На чужом запускай через Mod View.');
  }
  return me.id;
}
const bcWrap = (fn) => async (e, a) => {
  try { return { ok: true, data: await fn(a || {}) }; }
  catch (er) { return { ok: false, error: (er && er.message) || String(er) }; }
};
ipcMain.handle('bc:state', bcWrap(async (a) => {
  const id = await ownerId(a.channel);
  const [p, pr] = await Promise.all([
    helix('/polls?broadcaster_id=' + id + '&first=1'),
    helix('/predictions?broadcaster_id=' + id + '&first=1'),
  ]);
  const poll = p.data[0] && p.data[0].status === 'ACTIVE' ? p.data[0] : null;
  const pred = pr.data[0] && ['ACTIVE', 'LOCKED'].includes(pr.data[0].status) ? pr.data[0] : null;
  return { poll, pred };
}));
ipcMain.handle('poll:create', bcWrap(async (a) => {
  const id = await ownerId(a.channel);
  const title = String(a.title || '').trim().slice(0, 60);
  const choices = (a.choices || []).map((t) => String(t).trim().slice(0, 25)).filter(Boolean).slice(0, 5).map((t) => ({ title: t }));
  if (!title) throw new Error('Впиши вопрос');
  if (choices.length < 2) throw new Error('Нужно минимум 2 варианта');
  const duration = Math.min(1800, Math.max(15, parseInt(a.duration, 10) || 60));
  await helixReq('POST', '/polls', { broadcaster_id: id, title, choices, duration });
  return true;
}));
ipcMain.handle('poll:end', bcWrap(async (a) => {
  const id = await ownerId(a.channel);
  await helixReq('PATCH', '/polls', { broadcaster_id: id, id: a.pollId, status: 'TERMINATED' });
  return true;
}));
ipcMain.handle('pred:create', bcWrap(async (a) => {
  const id = await ownerId(a.channel);
  const title = String(a.title || '').trim().slice(0, 45);
  const outcomes = (a.outcomes || []).map((t) => String(t).trim().slice(0, 25)).filter(Boolean).slice(0, 10).map((t) => ({ title: t }));
  if (!title) throw new Error('Впиши вопрос ставки');
  if (outcomes.length < 2) throw new Error('Нужно минимум 2 исхода');
  const prediction_window = Math.min(1800, Math.max(30, parseInt(a.window, 10) || 120));
  await helixReq('POST', '/predictions', { broadcaster_id: id, title, outcomes, prediction_window });
  return true;
}));
// status: LOCKED (закрыть приём) | CANCELED (вернуть баллы) | RESOLVED (выбрать победителя)
ipcMain.handle('pred:set', bcWrap(async (a) => {
  const id = await ownerId(a.channel);
  if (!['LOCKED', 'CANCELED', 'RESOLVED'].includes(a.status)) throw new Error('bad status');
  const body = { broadcaster_id: id, id: a.predId, status: a.status };
  if (a.status === 'RESOLVED') body.winning_outcome_id = a.outcomeId;
  await helixReq('PATCH', '/predictions', body);
  return true;
}));

// ---------- админ-режим ----------
ipcMain.handle('admin:state', () => ({
  isAdmin: admin.isAdmin(),
  hasPassword: !!settings.adminHash,
  cfg: admin.isAdmin() ? admin.readCfg() : null,
  remoteUrl: admin.isAdmin() ? settings.remoteUrl || '' : '',
}));
ipcMain.handle('admin:setup', (e, pw) => {
  const r = admin.setup(settings, pw);
  if (r.ok) saveSettings();
  return r;
});
ipcMain.handle('admin:unlock', (e, pw) => admin.unlock(settings, pw));
ipcMain.handle('admin:lock', () => {
  admin.lock();
  return true;
});
ipcMain.handle('admin:saveCfg', (e, cfg) => {
  if (!admin.isAdmin()) return { ok: false, error: 'Нет доступа' };
  const a = (cfg && cfg.announcement) || {};
  admin.writeCfg({
    announcement: { id: String(a.id || '').slice(0, 80), text: String(a.text || '').slice(0, 500) },
    adPatterns: admin.cleanPatterns(cfg && cfg.adPatterns),
    note: '',
  });
  registerAdblock();
  return { ok: true };
});
ipcMain.handle('admin:exportConfig', async () => {
  if (!admin.isAdmin()) return { ok: false, error: 'Нет доступа' };
  const r = await dialog.showSaveDialog(win, {
    title: 'Сохранить remote-config.json',
    defaultPath: 'remote-config.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false };
  const cfg = admin.readCfg();
  const out = { adPatterns: cfg.adPatterns || [] };
  if (cfg.announcement && cfg.announcement.text) out.announcement = cfg.announcement;
  fs.writeFileSync(r.filePath, JSON.stringify(out, null, 2), 'utf8');
  return { ok: true, path: r.filePath };
});
ipcMain.handle('admin:forceFetch', () => refreshRemote(true));

app.whenReady().then(async () => {
  try { loadSettings(); } catch (e) { logErr('loadSettings: ' + (e && e.stack || e)); }
  try {
    await initDb();
  } catch (e) {
    dbOk = false;
    dbError = e && e.message ? e.message : String(e);
    logErr('initDb: ' + (e && e.stack || e));
  }
  try { await startPlayerServer(); } catch (e) { logErr('playerServer: ' + (e && e.stack || e)); }
  try { await setupSessions(); } catch (e) { logErr('setupSessions: ' + (e && e.stack || e)); }
  createWindow();
  try { registerHotkeys(settings.macros); } catch (e) { logErr('hotkeys: ' + (e && e.stack || e)); }
  setupAutoUpdate();
  refreshRemote();
  setInterval(() => refreshRemote(), 60 * 60 * 1000);
});

// ---------- автообновление (GitHub Releases) ----------
function setupAutoUpdate() {
  if (!app.isPackaged) return; // в режиме npm start не нужно
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('error', (e) => logErr('updater: ' + (e && e.message || e)));
    autoUpdater.on('update-available', (i) => win && win.webContents.send('update', { state: 'downloading', version: i.version }));
    autoUpdater.on('update-downloaded', (i) => {
      if (win && !win.isDestroyed()) win.webContents.send('update', { state: 'ready', version: i.version });
    });
    ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000);
  } catch (e) {
    logErr('setupAutoUpdate: ' + (e && e.stack || e));
  }
}

app.on('will-quit', () => {
  pointsWatcher.stop();
  globalShortcut.unregisterAll();
  flushDb();
});
app.on('window-all-closed', () => app.quit());