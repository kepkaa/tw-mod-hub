'use strict';

// ------------------------------------------------------------------
//  Kepkaa Deck — веб-версия (iPhone / любой браузер)
// ------------------------------------------------------------------
const CLIENT_ID = '57ave30wqqtpap1f641f6p5fpu57wm';
const SCOPES = [
  'user:read:follows',
  'chat:read',
  'chat:edit',
  'moderator:manage:chat_messages',
  'moderator:manage:banned_users',
  'channel:manage:polls',
  'channel:manage:predictions',
];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

const S = {
  token: '', login: '', uid: '', scopes: [],
  channel: '', chanId: '', own: false, mod: false,
  ws: null, retry: 0, retryT: null,
  me: null,            // метки USERSTATE (свои значки/цвет)
  badgeMap: {},
  player: null, lagT: null,
  stick: true,
  userIds: {},
  reply: null,         // на какое сообщение отвечаем
};

// ---------- мелочи ----------
let toastT;
function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), ms);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : String(n));
const cleanLogin = (s) => String(s || '').trim().toLowerCase().replace(/^[#@]/, '').replace(/[^a-z0-9_]/g, '');

// ---------- вход ----------
function loginRedirect(force) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPES.join(' '),
  });
  if (force) p.set('force_verify', 'true');
  location.href = 'https://id.twitch.tv/oauth2/authorize?' + p;
}

function readHash() {
  if (!location.hash) return '';
  const p = new URLSearchParams(location.hash.slice(1));
  const t = p.get('access_token');
  const err = p.get('error_description') || p.get('error') || '';
  if (t) store.set('token', t);
  if (t || err) history.replaceState(null, '', location.pathname + location.search);
  return err;
}

async function validate() {
  const r = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth ' + S.token } });
  if (!r.ok) throw new Error('auth');
  const j = await r.json();
  if (j.client_id !== CLIENT_ID) throw new Error('auth');
  S.login = j.login;
  S.uid = j.user_id;
  S.scopes = j.scopes || [];
}

function showGate(msg) {
  $('#app').hidden = true;
  $('#gate').hidden = false;
  $('#gateMsg').textContent = msg || '';
}

function logout() {
  store.del('token');
  closeChat();
  location.replace(redirectUri());
}

// ---------- Helix ----------
async function errMsg(r) {
  try { return (await r.clone().json()).message || ''; } catch { return ''; }
}
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('https://api.twitch.tv/helix' + path, {
    method,
    headers: {
      'Client-Id': CLIENT_ID,
      Authorization: 'Bearer ' + S.token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) {
    const m = await errMsg(r);
    if (/scope/i.test(m)) throw new Error('Не хватает прав — открой ☰ и нажми «Обновить права»');
    store.del('token');
    showGate('Сессия истекла — войди снова');
    throw new Error('Сессия истекла');
  }
  if (!r.ok) throw new Error((await errMsg(r)) || 'Ошибка ' + r.status);
  return r.status === 204 ? {} : r.json();
}
async function userId(login) {
  login = cleanLogin(login);
  if (S.userIds[login]) return S.userIds[login];
  const j = await api('/users?login=' + encodeURIComponent(login));
  if (!j.data[0]) throw new Error('Пользователь «' + login + '» не найден');
  return (S.userIds[login] = j.data[0].id);
}

// ---------- список каналов ----------
async function loadFollowed() {
  const box = $('#followed');
  try {
    const j = await api(`/streams/followed?user_id=${S.uid}&first=100`);
    box.innerHTML = '';
    if (!j.data.length) { box.innerHTML = '<div class="none">Из подписок сейчас никого нет в эфире.</div>'; return; }
    j.data.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'ch' + (s.user_login === S.channel ? ' active' : '');
      b.dataset.ch = s.user_login;
      b.innerHTML = `<b>${esc(s.user_name)}<span>● ${fmtNum(s.viewer_count)}</span></b><small>${esc(s.game_name || '')} · ${esc(s.title || '')}</small>`;
      box.appendChild(b);
    });
  } catch (e) {
    box.innerHTML = '<div class="none">Не удалось загрузить: ' + esc(e.message) + '</div>';
  }
}

function openDrawer() {
  $('#drawer').classList.add('open');
  $('#scrim').hidden = false;
  loadFollowed();
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  if ($('#sheet').hidden && $('#modSheet').hidden) $('#scrim').hidden = true;
}

// ---------- канал ----------
async function openChannel(raw) {
  const name = cleanLogin(raw);
  if (!name) return;
  S.channel = name;
  S.chanId = '';
  S.own = name === S.login;
  S.mod = S.own;
  S.me = null;
  cancelReply();
  store.set('last', name);
  $('#chName').textContent = name;
  $('#btnMod').hidden = !S.mod;
  $('#empty').hidden = true;
  closeDrawer();
  clearChat();
  mountPlayer(name);
  await loadBadges(name);
  if (S.channel === name) connectChat(name);
}

function whenTwitch(cb, tries = 25) {
  if (window.Twitch && window.Twitch.Player) return cb();
  if (tries <= 0) { toast('Плеер Twitch не загрузился — проверь интернет'); return; }
  setTimeout(() => whenTwitch(cb, tries - 1), 200);
}

function mountPlayer(name) {
  stopLag();
  $('#player').innerHTML = '';
  S.player = null;
  whenTwitch(() => {
    if (S.channel !== name) return;
    S.player = new window.Twitch.Player('player', {
      channel: name, parent: [location.hostname], width: '100%', height: '100%', autoplay: true, muted: false,
    });
    S.player.addEventListener(window.Twitch.Player.PLAYING, startLag);
  });
}

function startLag() {
  if (S.lagT) return;
  S.lagT = setInterval(() => {
    try {
      const l = +S.player.getPlaybackStats().hlsLatencyBroadcaster;
      if (!(l > 0)) return;
      const p = $('#lag');
      p.hidden = false;
      $('#lagVal').textContent = l.toFixed(1) + ' с';
      p.className = 'pill ' + (l <= 6 ? 'good' : l <= 12 ? 'warn' : 'bad');
    } catch {}
  }, 4000);
}
function stopLag() {
  clearInterval(S.lagT);
  S.lagT = null;
  $('#lag').hidden = true;
}

// ---------- значки ----------
async function loadBadges(name) {
  S.badgeMap = {};
  const add = (sets) => sets.forEach((s) => s.versions.forEach((v) => (S.badgeMap[s.set_id + '/' + v.id] = v.image_url_1x)));
  try {
    add((await api('/chat/badges/global')).data);
    add((await api('/chat/badges?broadcaster_id=' + (await userId(name)))).data);
  } catch {}
}

// ---------- IRC-чат ----------
const unesc = (v) => v.replace(/\\([s:rn\\])/g, (m, c) => ({ s: ' ', ':': ';', r: '\r', n: '\n', '\\': '\\' }[c]));

function parseIrc(line) {
  const tags = {};
  let rest = line;
  if (rest[0] === '@') {
    const i = rest.indexOf(' ');
    rest.slice(1, i).split(';').forEach((kv) => {
      const j = kv.indexOf('=');
      tags[kv.slice(0, j)] = unesc(kv.slice(j + 1));
    });
    rest = rest.slice(i + 1);
  }
  let prefix = '';
  if (rest[0] === ':') {
    const i = rest.indexOf(' ');
    prefix = rest.slice(1, i);
    rest = rest.slice(i + 1);
  }
  let text = null;
  const t = rest.indexOf(' :');
  if (t >= 0) { text = rest.slice(t + 2); rest = rest.slice(0, t); }
  const parts = rest.split(' ');
  return { tags, prefix, cmd: parts[0], params: parts.slice(1), text };
}

function setStatus(t) { $('#chStatus').textContent = t; }

function connectChat(name) {
  closeChat();
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  S.ws = ws;
  ws.onopen = () => {
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    ws.send('PASS oauth:' + S.token);
    ws.send('NICK ' + S.login);
    ws.send('JOIN #' + name);
    setStatus('подключаюсь…');
  };
  ws.onmessage = (e) => String(e.data).split('\r\n').forEach((l) => l && onIrc(l));
  ws.onclose = () => {
    if (S.ws !== ws || S.channel !== name) return;
    setStatus('переподключаюсь…');
    S.retry++;
    S.retryT = setTimeout(() => connectChat(name), Math.min(15000, 1000 * S.retry));
  };
}
function closeChat() {
  clearTimeout(S.retryT);
  const ws = S.ws;
  S.ws = null;
  if (ws) { try { ws.close(); } catch {} }
}

function onIrc(line) {
  if (line.startsWith('PING')) { S.ws && S.ws.send('PONG :tmi.twitch.tv'); return; }
  const m = parseIrc(line);
  switch (m.cmd) {
    case 'PRIVMSG': addMessage(m.tags, m.prefix.split('!')[0], m.text || ''); break;
    case 'USERSTATE': S.me = m.tags; updateRole(); break;
    case 'ROOMSTATE': S.retry = 0; setStatus('онлайн'); break;
    case 'CLEARMSG': markGone((n) => n.dataset.id === m.tags['target-msg-id']); break;
    case 'CLEARCHAT':
      if (m.tags['target-user-id']) markGone((n) => n.dataset.uid === m.tags['target-user-id']);
      else { clearChat(); system('Чат очищен модератором'); }
      break;
    case 'NOTICE':
      if (/authentication failed/i.test(m.text || '')) { showGate('Twitch отклонил вход — войди заново'); store.del('token'); closeChat(); }
      else system(m.text || '');
      break;
    case 'RECONNECT': S.ws && S.ws.close(); break;
  }
}

function updateRole() {
  const b = (S.me && S.me.badges) || '';
  S.mod = S.own || /(^|,)(moderator|broadcaster)\//.test(b) || (S.me && S.me.mod === '1');
  $('#btnMod').hidden = !S.mod;
}

// ---------- сообщения ----------
const chat = () => $('#chat');

function clearChat() { chat().innerHTML = ''; }

function renderBody(text, emotes) {
  const frag = document.createDocumentFragment();
  const chars = Array.from(text);
  const ranges = [];
  if (emotes) {
    emotes.split('/').forEach((e) => {
      const [id, pos] = e.split(':');
      (pos || '').split(',').forEach((p) => {
        const [a, b] = p.split('-').map(Number);
        if (Number.isFinite(a) && Number.isFinite(b)) ranges.push({ id, a, b });
      });
    });
  }
  ranges.sort((x, y) => x.a - y.a);
  let i = 0;
  for (const r of ranges) {
    if (r.a < i) continue;
    if (r.a > i) frag.append(chars.slice(i, r.a).join(''));
    const img = new Image();
    img.className = 'emote';
    img.alt = chars.slice(r.a, r.b + 1).join('');
    img.loading = 'lazy';
    img.src = `https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/1.0`;
    frag.append(img);
    i = r.b + 1;
  }
  if (i < chars.length) frag.append(chars.slice(i).join(''));
  return frag;
}

function addMessage(tags, login, raw) {
  let text = raw;
  let action = false;
  const am = /^\u0001ACTION (.*)\u0001$/.exec(raw);
  if (am) { text = am[1]; action = true; }

  const li = document.createElement('div');
  li.className = 'msg' + (action ? ' action' : '');
  li.dataset.id = tags.id || '';
  li.dataset.uid = tags['user-id'] || '';
  li.dataset.login = login;
  li.dataset.nick = tags['display-name'] || login;
  li.dataset.badges = tags.badges || '';
  li.dataset.text = text;

  if (tags['reply-parent-display-name']) {
    const r = document.createElement('span');
    r.className = 'reply';
    r.textContent = '↪ ' + tags['reply-parent-display-name'];
    li.append(r);
  }
  (tags.badges || '').split(',').filter(Boolean).forEach((b) => {
    const u = S.badgeMap[b];
    if (!u) return;
    const img = new Image();
    img.className = 'badge';
    img.alt = '';
    img.src = u;
    li.append(img);
  });
  const nick = document.createElement('span');
  nick.className = 'nick';
  nick.textContent = li.dataset.nick;
  nick.style.color = tags.color || '#c8a8ff';
  li.append(nick, action ? ' ' : ': ');
  const body = document.createElement('span');
  body.className = 'body';
  body.append(renderBody(text, tags.emotes));
  li.append(body);
  push(li);
}

function system(text) {
  if (!text) return;
  const d = document.createElement('div');
  d.className = 'sys';
  d.textContent = text;
  push(d);
}

function push(node) {
  const c = chat();
  c.append(node);
  while (c.children.length > 300) c.firstChild.remove();
  if (S.stick) c.scrollTop = c.scrollHeight;
  else $('#newBtn').hidden = false;
}

function markGone(test) {
  $$('.msg', chat()).forEach((n) => { if (test(n)) n.classList.add('gone'); });
}

function sendMessage(text) {
  text = text.trim();
  if (!text) return;
  if (!S.ws || S.ws.readyState !== 1) { toast('Чат не подключён'); return; }
  const isMe = /^\/me /i.test(text);
  const rp = isMe ? null : S.reply;
  if (text.startsWith('/') && !isMe) {
    toast('Команды вроде /ban больше не работают — используй 🛡 или нажми на сообщение');
    return;
  }
  S.ws.send((rp ? `@reply-parent-msg-id=${rp.id} ` : '') + `PRIVMSG #${S.channel} :${rp ? '@' + rp.login + ' ' : ''}${text}`);
  // Twitch не присылает своё сообщение обратно — рисуем сами
  const me = S.me || {};
  addMessage(
    { 'display-name': me['display-name'] || S.login, color: me.color, badges: me.badges, 'user-id': S.uid, ...(rp ? { 'reply-parent-display-name': rp.nick } : {}) },
    S.login,
    isMe ? '\u0001ACTION ' + text.slice(4) + '\u0001' : (rp ? '@' + rp.login + ' ' : '') + text
  );
  cancelReply();
}

// ---------- модерация ----------
const act = async (okText, fn) => {
  try { await fn(); toast(okText); } catch (e) { toast('⚠ ' + e.message, 5000); }
};
async function modQuery() {
  if (!S.chanId) S.chanId = await userId(S.channel);
  return `broadcaster_id=${S.chanId}&moderator_id=${S.uid}`;
}
const delMsg = async (id) => api(`/moderation/chat?${await modQuery()}&message_id=${encodeURIComponent(id)}`, { method: 'DELETE' });
const banUser = async (uid, duration) =>
  api(`/moderation/bans?${await modQuery()}`, { method: 'POST', body: { data: { user_id: uid, ...(duration ? { duration } : {}) } } });
const unbanUser = async (uid) => api(`/moderation/bans?${await modQuery()}&user_id=${uid}`, { method: 'DELETE' });

function openSheet(el) {
  el.hidden = false;
  $('#scrim').hidden = false;
}
function closeSheets() {
  $('#sheet').hidden = true;
  $('#modSheet').hidden = true;
  if (!$('#drawer').classList.contains('open')) $('#scrim').hidden = true;
}

function messageSheet(node) {
  const nick = node.dataset.nick;
  const target = node.dataset.uid;
  const isBoss = /(^|,)broadcaster\//.test(node.dataset.badges);
  $('#shNick').textContent = nick;
  $('#shText').textContent = node.dataset.text;
  const box = $('#shActions');
  box.innerHTML = '';
  const add = (label, fn, cls = '', disabled = false) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.disabled = disabled;
    b.onclick = () => { closeSheets(); fn(); };
    box.append(b);
  };
  add('↩ Ответить', () => startReply(node));
  if (S.mod) add('📌 Закрепить', () => pinMenu(node), '', !node.dataset.id);
  if (S.mod) add('🗑 Удалить', () => act('Сообщение удалено', async () => { await delMsg(node.dataset.id); node.classList.add('gone'); }), 'danger', !node.dataset.id);
  add('📋 Скопировать', () => navigator.clipboard && navigator.clipboard.writeText(node.dataset.text).then(() => toast('Скопировано')));
  if (S.mod) {
    [['⏱ 1 мин', 60], ['⏱ 10 мин', 600], ['⏱ 1 час', 3600], ['⏱ 1 день', 86400]].forEach(([l, d]) =>
      add(l, () => act(nick + ': мут ' + l.slice(2), () => banUser(target, d)), '', isBoss || !target));
    add('♻ Снять мут/бан', () => act(nick + ': снято', () => unbanUser(target)), '', isBoss || !target);
    add('⛔ Бан', () => { if (confirm('Забанить ' + nick + '?')) act(nick + ' забанен', () => banUser(target)); }, 'danger', isBoss || !target);
  }
  openSheet($('#sheet'));
}

// ответ на сообщение
function startReply(node) {
  if (!node.dataset.id) { toast('На своё только что отправленное сообщение ответить нельзя'); return; }
  S.reply = { id: node.dataset.id, nick: node.dataset.nick, login: node.dataset.login, text: node.dataset.text };
  $('#replyTxt').textContent = S.reply.nick + ': ' + S.reply.text.slice(0, 80);
  $('#replyBar').hidden = false;
  $('#msg').focus();
}
function cancelReply() {
  S.reply = null;
  $('#replyBar').hidden = true;
}

// закреп: PUT /chat/pins (нужны права модератора)
function pinMenu(node) {
  const box = $('#shActions');
  box.innerHTML = '';
  $('#shNick').textContent = '📌 Закрепить';
  $('#shText').textContent = node.dataset.nick + ': ' + node.dataset.text;
  const add = (label, fn, cls = '') => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = () => { closeSheets(); fn(); };
    box.append(b);
  };
  const pin = (sec) => act('📌 Закреплено', async () =>
    api(`/chat/pins?${await modQuery()}&message_id=${encodeURIComponent(node.dataset.id)}${sec ? '&duration_seconds=' + sec : ''}`, { method: 'PUT' }));
  add('5 минут', () => pin(300));
  add('10 минут', () => pin(600));
  add('30 минут', () => pin(1800));
  add('До конца стрима', () => pin(0));
  add('✖ Снять закреп', () => act('Закреп снят', async () => api(`/chat/pins?${await modQuery()}`, { method: 'DELETE' })), 'danger wide');
  openSheet($('#sheet'));
}

// панель модератора
async function nickTarget() {
  const n = cleanLogin($('#mNick').value);
  if (!n) throw new Error('Укажи ник');
  return userId(n);
}
function bindModPanel() {
  $('#mMute').onclick = () => act('Замучен', async () => banUser(await nickTarget(), +$('#mDur').value));
  $('#mUnmute').onclick = () => act('Размучен', async () => unbanUser(await nickTarget()));
  $('#mBan').onclick = () => { if (confirm('Забанить ' + $('#mNick').value + '?')) act('Забанен', async () => banUser(await nickTarget())); };
  $('#mUnban').onclick = () => act('Разбанен', async () => unbanUser(await nickTarget()));

  const addInput = (box, ph, max) => {
    const n = $$('.pc', box).length;
    if (n >= max) return toast('Максимум ' + max);
    const i = document.createElement('input');
    i.className = 'pc';
    i.maxLength = 25;
    i.placeholder = ph + ' ' + (n + 1);
    box.append(i);
  };
  const vals = (box) => $$('.pc', box).map((x) => x.value.trim()).filter(Boolean);
  $('#pollAdd').onclick = () => addInput($('#pollChoices'), 'Вариант', 5);
  $('#predAdd').onclick = () => addInput($('#predChoices'), 'Исход', 10);

  $('#pollStart').onclick = () => act('📊 Опрос запущен', async () => {
    const title = $('#pollTitle').value.trim();
    const choices = vals($('#pollChoices')).map((t) => ({ title: t }));
    if (!title) throw new Error('Впиши вопрос');
    if (choices.length < 2) throw new Error('Нужно минимум 2 варианта');
    await api('/polls', { method: 'POST', body: { broadcaster_id: S.uid, title, choices, duration: +$('#pollDur').value } });
    await refreshBc();
  });
  $('#predStart').onclick = () => act('🎯 Ставка запущена', async () => {
    const title = $('#predTitle').value.trim();
    const outcomes = vals($('#predChoices')).map((t) => ({ title: t }));
    if (!title) throw new Error('Впиши вопрос');
    if (outcomes.length < 2) throw new Error('Нужно минимум 2 исхода');
    await api('/predictions', { method: 'POST', body: { broadcaster_id: S.uid, title, outcomes, prediction_window: +$('#predWin').value } });
    await refreshBc();
  });
  $('#pollLive').onclick = (e) => {
    const b = e.target.closest('[data-poll]');
    if (b) act('Опрос завершён', async () => { await api('/polls', { method: 'PATCH', body: { broadcaster_id: S.uid, id: b.dataset.poll, status: 'TERMINATED' } }); await refreshBc(); });
  };
  $('#predLive').onclick = (e) => {
    const b = e.target.closest('[data-pred]');
    if (!b) return;
    if (b.dataset.pred === 'RESOLVED' && !confirm('Победитель: «' + b.dataset.title + '»?')) return;
    act('Ставка обновлена', async () => {
      const body = { broadcaster_id: S.uid, id: b.dataset.id, status: b.dataset.pred };
      if (body.status === 'RESOLVED') body.winning_outcome_id = b.dataset.out;
      await api('/predictions', { method: 'PATCH', body });
      await refreshBc();
    });
  };
}

async function refreshBc() {
  if (!S.own) return;
  try {
    const [p, pr] = await Promise.all([
      api(`/polls?broadcaster_id=${S.uid}&first=1`),
      api(`/predictions?broadcaster_id=${S.uid}&first=1`),
    ]);
    const poll = p.data[0] && p.data[0].status === 'ACTIVE' ? p.data[0] : null;
    const pred = pr.data[0] && ['ACTIVE', 'LOCKED'].includes(pr.data[0].status) ? pr.data[0] : null;

    const pl = $('#pollLive');
    pl.hidden = !poll;
    if (poll) {
      pl.innerHTML = `<b>${esc(poll.title)}</b>` +
        poll.choices.map((c) => `<div class="opt"><span>${esc(c.title)}</span><span>${c.votes || 0}</span></div>`).join('') +
        `<div class="acts"><button class="danger" data-poll="${esc(poll.id)}">⏹ Завершить</button></div>`;
    }
    const pd = $('#predLive');
    pd.hidden = !pred;
    if (pred) {
      const btn = (st, label, extra = '', cls = '') => `<button class="${cls}" data-pred="${st}" data-id="${esc(pred.id)}" ${extra}>${label}</button>`;
      pd.innerHTML = `<b>${esc(pred.title)} <small>(${pred.status === 'LOCKED' ? 'приём закрыт' : 'идёт приём'})</small></b>` +
        pred.outcomes.map((o) => `<div class="opt"><span>${esc(o.title)}</span><span>${o.users || 0} 👤 · ${fmtNum(o.channel_points || 0)}</span></div>`).join('') +
        `<div class="acts">` +
        (pred.status === 'ACTIVE' ? btn('LOCKED', '🔒 Закрыть приём') : '') +
        pred.outcomes.map((o) => btn('RESOLVED', '🏆 ' + esc(o.title), `data-out="${esc(o.id)}" data-title="${esc(o.title)}"`)).join('') +
        btn('CANCELED', '↩ Отменить', '', 'danger') + `</div>`;
    }
  } catch (e) {
    // нет прав / не Affiliate — подробности покажем при нажатии «Запустить»
  }
}

function openModPanel() {
  $('#bcOwn').hidden = !S.own;
  $('#bcHint').hidden = S.own;
  openSheet($('#modSheet'));
  refreshBc();
}

// ---------- запуск ----------
function bindUi() {
  $('#gateLogin').onclick = () => loginRedirect(false);
  $('#btnDrawer').onclick = openDrawer;
  $('#btnLive').onclick = () => { if (S.channel) { mountPlayer(S.channel); toast('⟳ Плеер перезапущен — прямой эфир'); } };
  $('#btnMod').onclick = openModPanel;
  $('#btnReauth').onclick = () => loginRedirect(true);
  $('#btnLogout').onclick = logout;

  $('#scrim').onclick = () => { closeDrawer(); closeSheets(); };
  $$('[data-close]').forEach((b) => (b.onclick = () => { closeDrawer(); closeSheets(); }));

  $('#openForm').onsubmit = (e) => { e.preventDefault(); openChannel($('#openName').value); $('#openName').value = ''; };
  $('#followed').onclick = (e) => { const b = e.target.closest('.ch'); if (b) openChannel(b.dataset.ch); };

  $('#form').onsubmit = (e) => { e.preventDefault(); const i = $('#msg'); sendMessage(i.value); i.value = ''; };

  // зажатие на сообщении → меню «ответить / закрепить / удалить» (мышью — обычный клик)
  let pressT = null;
  let pressXY = null;
  let ptype = 'touch';
  const cancelPress = () => clearTimeout(pressT);
  chat().addEventListener('pointerdown', (e) => {
    ptype = e.pointerType || 'touch';
    const n = e.target.closest('.msg');
    if (!n || ptype === 'mouse') return;
    pressXY = [e.clientX, e.clientY];
    clearTimeout(pressT);
    pressT = setTimeout(() => {
      if (navigator.vibrate) navigator.vibrate(15);
      messageSheet(n);
    }, 450);
  });
  chat().addEventListener('pointermove', (e) => {
    if (pressXY && Math.hypot(e.clientX - pressXY[0], e.clientY - pressXY[1]) > 10) cancelPress();
  });
  ['pointerup', 'pointercancel', 'pointerleave', 'scroll'].forEach((t) => chat().addEventListener(t, cancelPress));
  chat().addEventListener('contextmenu', (e) => e.preventDefault());
  chat().addEventListener('click', (e) => {
    const n = e.target.closest('.msg');
    if (n && ptype === 'mouse') messageSheet(n);
  });
  $('#replyCancel').onclick = cancelReply;
  chat().addEventListener('scroll', () => {
    const c = chat();
    S.stick = c.scrollHeight - c.scrollTop - c.clientHeight < 40;
    if (S.stick) $('#newBtn').hidden = true;
  });
  $('#newBtn').onclick = () => { const c = chat(); c.scrollTop = c.scrollHeight; };

  bindModPanel();

  // iPhone «усыпляет» сокеты в фоне — после возврата переподключаемся
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !S.channel) return;
    if (!S.ws || S.ws.readyState > 1) connectChat(S.channel);
  });
}

async function init() {
  bindUi();
  const hashErr = readHash();
  S.token = store.get('token') || '';
  if (!S.token) return showGate(hashErr ? 'Twitch: ' + hashErr : '');
  try {
    await validate();
  } catch {
    store.del('token');
    return showGate('Сессия истекла — войди снова');
  }
  $('#gate').hidden = true;
  $('#app').hidden = false;
  $('#who').textContent = 'Вы вошли как ' + S.login;

  const missing = SCOPES.filter((s) => !S.scopes.includes(s));
  if (missing.length) {
    const b = $('#banner');
    b.hidden = false;
    b.innerHTML = 'Часть функций недоступна — нужны новые права. <button id="bnFix">Обновить</button>';
    $('#bnFix').onclick = () => loginRedirect(true);
  }

  const last = store.get('last');
  if (last) openChannel(last);
  else openDrawer();
  setInterval(() => { if (!document.hidden && $('#drawer').classList.contains('open')) loadFollowed(); }, 90000);
}

init();
