const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

let settings = {};
let me = null;
let playerPort = 0;
let currentChannel = '';
let currentFavs = [];
let isModOnChannel = false;
let lastChatUser = '';
let lastChatMsgId = '';
let chatWs = null;
let chatReconnectTimer = null;
let chatLogin = '';
let myBadges = '';
let followingAll = [];
let followingLoaded = false;
let chatBackoff = 0;
let recentChannels = [];
let macrosDraft = [];
let badgeMap = {};
let twPlayer = null;
let latencyTimer = null;
let lagHits = 0;
let lastCatchUp = 0;
let catchupAt = 0;
let autoLiveOff = false;
let panelOpen = true;
let bcTimer = null;
let pointsSeen = false;
let pointsFallbackT = null;

// ---------------- INIT ----------------
async function boot() {
  settings = await window.modhub.getSettings();
  applyTheme();
  // пока не вошёл — показываем только экран входа, остальное не запускаем
  if (!settings.loggedIn) { showGate(); return; }
  bindUI();
  await initFavsRecent();
  await initStats();
  await initHistory();
  await initMacros();
  await initAdmin();
  initUser();
  initPlayer();
  initPanel();
  initChatMode();
  initBroadcast();

  window.modhub.onHotkey(handleHotkey);
  window.modhub.onUpdate(onUpdate);
  window.modhub.onPoints(setPoints);
  // Список стримов обновляем по таймеру и только когда окно видно — лишние API-запросы не тратим
  setInterval(() => { if (!document.hidden && settings.loggedIn) initUser(); }, Math.max(30, +settings.refreshSec || 60) * 1000);
  window.modhub.onRemote((r) => {
    if (r && r.announcement && r.announcement.text) toast('📣 ' + r.announcement.text, 8000);
  });
  window.modhub.onAuthExpired(() => {
    settings.loggedIn = false;
    showGate('Сессия Twitch истекла — войди заново');
  });

  const app = await window.modhub.appStatus();
  if (app && app.adBlocked != null) setAdCount(app.adBlocked);
  if (app && app.remote && app.remote.announcement && app.remote.announcement.text) {
    toast('📣 ' + app.remote.announcement.text, 8000);
  }
  if (!settings.loggedIn) toast('Войди в Twitch, чтобы писать в чат', 4000);
  setInterval(async () => {
    const s = await window.modhub.appStatus();
    if (s) setAdCount(s.adBlocked);
  }, 4000);

  if (settings.loggedIn && settings.lastChannel) {
    setTimeout(() => openChannel(settings.lastChannel), 350);
  }
}

function applyTheme() {
  const root = document.documentElement;
  if (settings.accent) {
    root.style.setProperty('--accent', settings.accent);
    root.style.setProperty('--accent-2', mix(settings.accent, '#ffffff', .25));
    const rgb = hexToRgb(settings.accent);
    if (rgb) root.style.setProperty('--accent-rgb', `${rgb.r},${rgb.g},${rgb.b}`);
  }
  document.body.classList.toggle('no-aurora', settings.aurora === false);
  document.body.classList.toggle('compact', !!settings.compact);
}

function mix(hex, hex2, w) {
  const p = (h) => { h = h.replace('#',''); if (h.length===3) h=h.split('').map(c=>c+c).join(''); return [0,2,4].map(i=>parseInt(h.substr(i,2),16)); };
  const a = p(hex), b = p(hex2);
  const c = a.map((v,i)=>Math.round(v*(1-w)+b[i]*w));
  return '#'+c.map(v=>v.toString(16).padStart(2,'0')).join('');
}
function hexToRgb(hex) {
  const m = String(hex||'').replace('#','').match(/^([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map(c=>c+c).join('');
  return { r: parseInt(h.substr(0,2),16), g: parseInt(h.substr(2,2),16), b: parseInt(h.substr(4,2),16) };
}

async function initUser() {
  if (settings.loggedIn) {
    const f = await window.modhub.followed();
    if (f.ok) {
      me = f;
      $('#meLabel').textContent = '@' + f.me;
      updateMeBadge();
      renderStreams(f.streams);
      if (!followingLoaded) loadFollowing(); else renderFollowing();
      return;
    }
  }
  $('#meLabel').textContent = 'не вошёл';
  renderStreams([]);
}

function renderStreams(list) {
  const el = $('#streamsList');
  if (!list.length) {
    el.innerHTML = `<div class="muted" style="padding:16px;text-align:center;font-size:12px">Нет активных стримов.<br>Проверь вход в Twitch.</div>`;
    return;
  }
  el.innerHTML = list.map((s) => `
    <div class="stream" data-ch="${s.login}">
      <img class="stream-av" src="${s.avatar || ''}" alt="" onerror="this.style.visibility='hidden'"/>
      <div class="stream-info">
        <div class="stream-name">${esc(s.name)}</div>
        <div class="stream-meta">${esc(s.game || '—')} · ${fmtNum(s.viewers)}👁</div>
      </div>
      <div class="stream-live">LIVE</div>
    </div>`).join('');
  $$('.stream', el).forEach((el2) => el2.addEventListener('click', () => openChannel(el2.dataset.ch)));
  $$('.stream', el).forEach((el2) => el2.classList.toggle('active', el2.dataset.ch === currentChannel));
}

async function initFavsRecent() {
  currentFavs = await window.modhub.dbFavs();
  recentChannels = await window.modhub.dbRecent();
  renderChips();
}
function renderChips() {
  $('#favList').innerHTML = currentFavs.length
      ? currentFavs.map((c) => `<span class="chip" data-ch="${c}">★ ${esc(c)}</span>`).join('')
      : `<span class="muted small">пусто</span>`;
  $('#recentList').innerHTML = recentChannels.length
      ? recentChannels.map((c) => `<span class="chip" data-ch="${c}">${esc(c)}</span>`).join('')
      : `<span class="muted small">пусто</span>`;
  $$('.chip').forEach((el) => el.addEventListener('click', () => openChannel(el.dataset.ch)));
}

async function initPlayer() { playerPort = await window.modhub.playerPort(); }

// ---------------- BIND ----------------
function bindUI() {
  $('#btnGo').addEventListener('click', () => openChannel($('#channelInput').value.trim()));
  $('#channelInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') openChannel(e.target.value.trim()); });
  $('#btnRefresh').addEventListener('click', () => { followingLoaded = false; initUser(); });
  // «Мои подписки»: клик по каналу и поиск
  $('#followList').addEventListener('click', (e) => {
    const it = e.target.closest('.follow-item');
    if (it) openChannel(it.dataset.ch);
  });
  $('#followSearch').addEventListener('input', debounce(renderFollowing, 120));
  $('#btnFav').addEventListener('click', toggleFav);
  $('#btnOpenTwitch').addEventListener('click', () => {
    if (currentChannel) window.modhub.openExternal('https://twitch.tv/' + currentChannel);
  });

  $('#btnPanel').addEventListener('click', () => togglePanel());
  $('#btnClosePanel').addEventListener('click', () => togglePanel(false));
  $('#btnStreams').addEventListener('click', () => showMobile('streams'));
  $$('.bottomnav button').forEach((b) => b.addEventListener('click', () => showMobile(b.dataset.nav)));

  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    $$('.pane').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $(`.pane[data-pane="${t.dataset.tab}"]`).classList.add('active');
  }));

  $('#chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('#chatText').value); $('#chatText').value = ''; });
  $('#btnChatReconnect').addEventListener('click', () => connectChat());
  $('#btnChatClear').addEventListener('click', () => { $('#chatBody').innerHTML = ''; });

  $$('.mod-btns button').forEach((b) => b.addEventListener('click', () => modAction(b.dataset.cmd)));
  $('#modPickFromLast').addEventListener('click', () => { if (lastChatUser) $('#modNick').value = lastChatUser; });
  $('#modNick').addEventListener('input', refreshNickMeta);
  $('#btnNoteSave').addEventListener('click', saveNote);

  $('#btnAddMacro').addEventListener('click', () => {
    macrosDraft.push({ id: 'm' + Date.now(), name: 'Новый', hotkey: '', text: '' });
    renderMacros();
  });
  $('#btnSaveMacros').addEventListener('click', saveMacros);
  $('#btnExportAhk').addEventListener('click', async () => {
    const r = await window.modhub.exportAhk(macrosDraft);
    if (r.ok) toast('AHK сохранён: ' + r.path, 4000);
  });

  $('#histQuery').addEventListener('input', debounce(initHistory, 200));
  $('#btnExportCsv').addEventListener('click', async () => {
    const r = await window.modhub.dbExportCsv();
    if (r.ok) toast('CSV сохранён: ' + r.path + ' (' + r.count + ')', 4000);
  });

  $('#clientId').value = settings.clientId || '';
  $('#clientId').addEventListener('change', () => window.modhub.saveSettings({ clientId: $('#clientId').value.trim() }));
  $('#btnLogin').addEventListener('click', doLogin);
  $('#btnLogout').addEventListener('click', doLogout);

  $('#accent').value = settings.accent || '#9146ff';
  $('#aurora').checked = settings.aurora !== false;
  $('#compact').checked = !!settings.compact;
  $('#confirmBan').checked = settings.confirmBan !== false;
  $('#refreshSec').value = settings.refreshSec;
  $('#adblock').checked = settings.adblock !== false;

  $('#accent').addEventListener('input', (e) => { settings.accent = e.target.value; applyTheme(); window.modhub.saveSettings({ accent: e.target.value }); });
  $('#aurora').addEventListener('change', (e) => { settings.aurora = e.target.checked; applyTheme(); window.modhub.saveSettings({ aurora: e.target.checked }); });
  $('#compact').addEventListener('change', (e) => { settings.compact = e.target.checked; applyTheme(); window.modhub.saveSettings({ compact: e.target.checked }); });
  $('#confirmBan').addEventListener('change', (e) => window.modhub.saveSettings({ confirmBan: e.target.checked }));
  $('#refreshSec').addEventListener('change', (e) => window.modhub.saveSettings({ refreshSec: parseInt(e.target.value, 10) || 60 }));
  $('#adblock').addEventListener('change', (e) => window.modhub.saveSettings({ adblock: e.target.checked }));
  $('#btnOpenData').addEventListener('click', () => window.modhub.openDataDir());
  $('#btnReset').addEventListener('click', async () => {
    if (!confirm('Сбросить все настройки (кроме входа)?')) return;
    settings = await window.modhub.resetSettings();
    location.reload();
  });
}

function showMobile(view) {
  $$('.bottomnav button').forEach((b) => b.classList.toggle('active', b.dataset.nav === view));
  $$('.col').forEach((c) => c.classList.remove('active'));
  document.querySelector('.center').classList.remove('active');
  if (view === 'streams') $('#colStreams').classList.add('active');
  else if (view === 'panel') $('#colPanel').classList.add('active');
  else {
    document.querySelector('.center').classList.add('active');
    if (view === 'chat') {
      setTimeout(() => { $('#chatWrap').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 60);
    }
  }
}

// ---------------- CHANNEL ----------------
async function openChannel(ch) {
  ch = String(ch || '').replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
  if (!ch) return;
  currentChannel = ch;
  window.modhub.dbWatch(ch);
  window.modhub.saveSettings({ lastChannel: ch });
  startPointsWatch(ch);

  mountPlayer(ch);
  if (settings.chatMode === 'twitch') applyChatMode(true);

  $('#chName').textContent = 'twitch.tv/' + ch;
  $('#chSub').textContent = 'подключение…';
  $('#btnOpenTwitch').textContent = 'Открыть на Twitch';

  $$('.stream').forEach((s) => s.classList.toggle('active', s.dataset.ch === ch));
  $$('.follow-item').forEach((s) => s.classList.toggle('active', s.dataset.ch === ch));

  refreshChannelInfo();

  const m = await window.modhub.checkMod(ch);
  isModOnChannel = !!(m && m.isMod);
  applyModUi();
  loadBadgesFor(ch);
  $('#modPill').hidden = !isModOnChannel;
  $('#noModCard').hidden = isModOnChannel;
  document.querySelector('.mod-only').style.display = isModOnChannel ? '' : 'none';

  connectChat();

  if (window.innerWidth < 900) showMobile('player');
}

async function refreshChannelInfo() {
  if (!me || !me.streams) return;
  const s = me.streams.find((x) => x.login === currentChannel);
  if (s) {
    $('#chAvatar').style.backgroundImage = `url("${s.avatar}")`;
    $('#chName').textContent = s.name;
    $('#chSub').textContent = `${s.game || '—'} · ${fmtNum(s.viewers)} зрителей`;
  } else {
    $('#chAvatar').style.backgroundImage = '';
    $('#chSub').textContent = 'офлайн или не в подписках';
  }
  const isFav = currentFavs.includes(currentChannel);
  $('#btnFav').textContent = isFav ? '★ Убрать из избранного' : '☆ В избранное';
}

async function toggleFav() {
  if (!currentChannel) return;
  currentFavs = await window.modhub.dbFavToggle(currentChannel);
  renderChips();
  refreshChannelInfo();
}

// ---------------- CHAT (Twitch IRC over WS) ----------------
async function connectChat() {
  if (chatWs) { const old = chatWs; chatWs = null; old.onclose = null; try { old.close(); } catch {} }
  clearTimeout(chatReconnectTimer);
  if (!currentChannel) return;

  const auth = await window.modhub.chatAuth();
  if (!auth.ok) {
    const reasons = {
      'no-token': 'нужен вход в Twitch',
      'no-user':  'не удалось получить профиль',
    };
    const msg = reasons[auth.reason] || auth.reason || 'auth';

    $('#chatStatus').innerHTML =
        msg + ' — <button id="chatLoginBtn" style="background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;border:0;border-radius:8px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;margin-left:6px">Войти</button>';
    const btn = document.getElementById('chatLoginBtn');
    if (btn) btn.addEventListener('click', () => {
      const tab = document.querySelector('.tab[data-tab="set"]');
      if (tab) tab.click();
      setTimeout(() => doLogin(), 80);
    });

    window.modhub.logError('chatAuth failed: ' + JSON.stringify(auth));
    return;
  }
  setChatStatus('подключение…');
  chatLogin = auth.login.toLowerCase();
  $('#chatBody').innerHTML = '';

  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  chatWs = ws;

  ws.onopen = () => {
    ws.send('CAP REQ :twitch.tv/membership twitch.tv/tags twitch.tv/commands');
    ws.send('PASS oauth:' + auth.token);
    ws.send('NICK ' + auth.login.toLowerCase());
    ws.send('JOIN #' + currentChannel);
    setChatStatus('подключение…');
  };
  ws.onmessage = (e) => {
    const lines = String(e.data).split('\r\n').filter(Boolean);
    for (const l of lines) handleIrcLine(l);
  };
  ws.onclose = () => {
    if (chatWs !== ws) return;
    setChatStatus('отключён, переподключаюсь…');
    $('#chatDot').classList.remove('live');
    chatBackoff = Math.min(chatBackoff + 1, 6);
    chatReconnectTimer = setTimeout(connectChat, 2000 * chatBackoff);
  };
  ws.onerror = () => setChatStatus('ошибка');
}

function setChatStatus(s) { $('#chatStatus').textContent = s; }
function onChatReady() {
  chatBackoff = 0;
  setChatStatus('онлайн · #' + currentChannel);
  updateMeBadge();
  applyModUi();
  $('#chatDot').classList.add('live');
}

function parseTags(raw) {
  const tags = {};
  if (raw[0] === '@') {
    const idx = raw.indexOf(' ');
    const part = raw.slice(1, idx);
    raw = raw.slice(idx + 1);
    for (const kv of part.split(';')) {
      const eq = kv.indexOf('=');
      if (eq === -1) tags[kv] = '';
      else tags[kv.slice(0, eq)] = kv.slice(eq + 1)
          .replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\')
          .replace(/\\r/g, '\r').replace(/\\n/g, '\n');
    }
  }
  return [tags, raw];
}

function handleIrcLine(line) {
  if (line.startsWith('PING')) { chatWs && chatWs.send('PONG :tmi.twitch.tv'); return; }
  const [tags, rest] = parseTags(line);
  const m = rest.match(/^(?::(\S+)!)?(\S+) (PRIVMSG|CLEARCHAT|CLEARMSG|NOTICE|USERSTATE|ROOMSTATE|JOIN|PART|001|376|RECONNECT) ?(.*)$/);
  if (!m) {
    if (/^:\S+ 001 /.test(rest)) onChatReady();
    return;
  }
  const [, , , cmd, args] = m;
  if (cmd === 'PRIVMSG') {
    const parts = args.match(/^#(\S+) :(.*)$/);
    if (!parts) return;
    const [, , text] = parts;
    const id = tags['id'] || '';
    const user = tags['display-name'] || tags['login'] || '';
    const color = tags['color'] || '';
    const badges = tags['badges'] || '';
    const msg = {
      id, user, text, color,
      isMod: tags['mod'] === '1' || badges.includes('broadcaster'),
      badges,
      self: !!(chatLogin && (tags['display-name'] || '').toLowerCase() === chatLogin),
    };
    if (msg.id) lastChatMsgId = msg.id;
    lastChatUser = user || lastChatUser;
    renderMsg(msg);
  } else if (cmd === '001' || cmd === '376') {
    onChatReady();
  } else if (cmd === 'RECONNECT') {
    try { chatWs && chatWs.close(); } catch {}
  } else if (cmd === 'CLEARMSG') {
    const targetId = tags['target-msg-id'];
    if (targetId) removeMsg(targetId);
  } else if (cmd === 'CLEARCHAT') {
    $('#chatBody').innerHTML = '';
  } else if (cmd === 'USERSTATE') {
    // свои значки (VIP, саб и т.д.) приходят именно здесь — нужны для отрисовки своих сообщений и шапки
    if (tags['badges'] != null) { myBadges = tags['badges']; updateMeBadge(); }
    const isMod = tags['mod'] === '1' || (tags['badges'] || '').includes('broadcaster');
    if (isMod && !isModOnChannel) {
      isModOnChannel = true;
      $('#modPill').hidden = false;
      $('#noModCard').hidden = true;
      applyModUi();
      document.querySelector('.mod-only').style.display = '';
    }
  } else if (cmd === 'NOTICE') {
    const text = args.replace(/^#\S+ :/, '').replace(/^:tmi\.twitch\.tv /, '');
    if (/authentication failed|improperly formatted auth/i.test(text)) {
      if (chatWs) { const w = chatWs; chatWs = null; w.onclose = null; try { w.close(); } catch {} }
      setChatStatus('ошибка входа — войди заново в Настройках');
      renderSystem('Twitch отклонил токен чата. Нажми «Выйти» и войди снова.');
    } else if (text) renderSystem(text);
  }
}

function renderMsg(msg) {
  const el = document.createElement('div');
  el.className = 'msg' + (msg.self ? ' self' : '');
  el.dataset.id = msg.id;
  el.innerHTML = `
    <span class="badges">${renderBadges(msg.badges)}</span>
    <span class="who" style="color:${msg.color || 'var(--accent-2)'}">${esc(msg.user)}:</span>
    <span class="body">${esc(msg.text)}</span>
    <button class="del" title="Удалить">✕</button>
  `;
  el.querySelector('.del').addEventListener('click', (ev) => {
    ev.stopPropagation();
    askDelete(msg.id, msg.user);
  });
  el.addEventListener('click', () => {
    if (window.innerWidth < 900) askDelete(msg.id, msg.user);
  });
  const body$ = $('#chatBody');
  body$.appendChild(el);
  while (body$.children.length > 400) body$.removeChild(body$.firstChild);
  body$.scrollTop = body$.scrollHeight;
}

function renderBadges(b) {
  if (!b) return '';
  const emo = { broadcaster: '🎥', moderator: '⚔', vip: '💎', subscriber: '⭐', 'twitch-releases-sub-gifter': '🎁' };
  // каждый значок — картинкой из Twitch, а если картинки нет (карта не загрузилась) — эмодзи, чтобы VIP не пропадал
  return b.split(',').map((x) => {
    const u = badgeMap[x];
    if (u) return `<img src="${esc(u)}" alt="" title="${esc(x.split('/')[0])}">`;
    return emo[x.split('/')[0]] || '';
  }).join('');
}
function renderBadgesEmoji(b) {
  if (!b) return '';
  const map = {
    broadcaster: '🎥', moderator: '⚔', vip: '💎', subscriber: '⭐',
    'twitch-releases-sub-gifter': '🎁',
  };
  return b.split(',').map((x) => x.split('/')[0]).map((k) => map[k] || '').join('');
}
function renderSystem(t) {
  const el = document.createElement('div');
  el.className = 'msg';
  el.style.opacity = .65;
  el.innerHTML = `<span class="body" style="font-style:italic">${esc(t)}</span>`;
  $('#chatBody').appendChild(el);
  $('#chatBody').scrollTop = $('#chatBody').scrollHeight;
}
function removeMsg(id) {
  const el = $(`.msg[data-id="${CSS.escape(id)}"]`);
  if (el) el.remove();
}

function sendChat(text) {
  text = String(text || '').trim();
  if (!text) return;
  // слэш-команды Twitch больше не принимает через IRC — они идут через API (кроме /me)
  if (text.startsWith('/') && !/^\/me\s/i.test(text)) {
    window.modhub.chatCommand(currentChannel, text).then((r) => {
      if (!r || !r.ok) toast('⚠ ' + ((r && r.error) || 'команда не выполнена'), 5000);
    });
    return;
  }
  if (!chatWs || chatWs.readyState !== 1) { toast('Чат не подключён'); return; }
  chatWs.send(`PRIVMSG #${currentChannel} :${text}`);
  // Twitch не присылает обратно собственные сообщения — рисуем сами
  renderMsg({ id: '', user: chatLogin, text, color: '', badges: myBadges, self: true });
}

async function askDelete(msgId, user) {
  if (!isModOnChannel) { toast('Ты не модератор здесь'); return; }
  if (window.innerWidth < 900) {
    openSheet(`Действия · ${user}`, [
      { label: '🗑 Удалить сообщение', danger: true, action: () => { sendChat('/delete ' + msgId); logAction('delete', user, '', 0, '/delete ' + msgId); } },
      { label: '⏱ Таймаут 10 минут', action: () => { sendChat(`/timeout ${user} 600`);  logAction('timeout', user, '', 600,  `/timeout ${user} 600`); } },
      { label: '⏱ Таймаут 1 час',   action: () => { sendChat(`/timeout ${user} 3600`); logAction('timeout', user, '', 3600, `/timeout ${user} 3600`); } },
      { label: '🚫 Бан', danger: true, action: () => {
          if (settings.confirmBan !== false && !confirm('Забанить ' + user + '?')) return;
          sendChat(`/ban ${user}`); logAction('ban', user, '', 0, `/ban ${user}`);
        } },
      { label: '💬 Ответить', action: () => { $('#chatText').value = '@' + user + ' '; $('#chatText').focus(); } },
      { label: '📋 В поле ника', action: () => { $('#modNick').value = user; } },
      { label: 'Отмена', cancel: true },
    ]);
  } else {
    sendChat('/delete ' + msgId);
    logAction('delete', user, '', 0, '/delete ' + msgId);
  }
}

// ---------------- MOD ACTIONS ----------------
async function modAction(cmd) {
  if (!currentChannel) return;
  const nick = ($('#modNick').value || lastChatUser).replace(/^@/, '').trim();
  const text = cmd.replace(/\{nick\}/g, nick);
  if (/\{nick\}/.test(cmd) && !nick) { toast('Укажи ник'); return; }
  if (text.startsWith('/ban') && settings.confirmBan !== false && !confirm('Выполнить: ' + text + '?')) return;
  sendChat(text);
  logAction(text.split(' ')[0].slice(1), nick, '', 0, text);
}

function logAction(action, target, reason, duration, command) {
  window.modhub.dbLog({ channel: currentChannel, action, target, reason, duration, command });
  initStats();
  initHistory();
}
function handleHotkey(id) {
  const m = (macrosDraft || []).find((x) => x.id === id);
  if (!m) return;
  let text = m.text.replace(/\{nick\}/g, ($('#modNick').value || lastChatUser).replace(/^@/, ''));
  text = text.replace(/\{msgid\}/g, lastChatMsgId);
  sendChat(text);
  if (isModOnChannel) logAction(text.split(' ')[0].slice(1), ($('#modNick').value || lastChatUser), '', 0, text);
}

// ---------------- MACROS ----------------
async function initMacros() {
  macrosDraft = JSON.parse(JSON.stringify(settings.macros || []));
  renderMacros();
  await window.modhub.registerHotkeys(macrosDraft);
}
function renderMacros() {
  $('#macrosList').innerHTML = macrosDraft.map((m, i) => `
    <div class="macro" data-i="${i}">
      <input class="m-name" placeholder="Название" value="${esc(m.name)}" />
      <input class="m-hk" placeholder="Ctrl+Alt+B" value="${esc(m.hotkey)}" />
      <input class="m-txt" placeholder="текст" value="${esc(m.text)}" />
      <button class="icon-btn sm m-del">✕</button>
    </div>`).join('');
  $$('.macro').forEach((row) => {
    const i = +row.dataset.i;
    row.querySelector('.m-name').addEventListener('input', (e) => { macrosDraft[i].name = e.target.value; });
    row.querySelector('.m-hk').addEventListener('input',   (e) => { macrosDraft[i].hotkey = e.target.value; });
    row.querySelector('.m-txt').addEventListener('input',  (e) => { macrosDraft[i].text = e.target.value; });
    row.querySelector('.m-del').addEventListener('click', () => { macrosDraft.splice(i, 1); renderMacros(); });
  });
}
async function saveMacros() {
  await window.modhub.saveSettings({ macros: macrosDraft });
  const failed = await window.modhub.registerHotkeys(macrosDraft);
  toast(failed.length ? 'Не удалось занять: ' + failed.join(', ') : 'Хоткеи обновлены');
}

// ---------------- STATS / HISTORY / NOTES ----------------
async function initStats() {
  const s = await window.modhub.dbStats();
  const el = $('#statsBox');
  const items = Object.entries(s.today).map(([k, v]) => `<div class="stat"><div class="n">${v}</div><div class="l">${esc(k)}</div></div>`).join('');
  el.innerHTML = (items || `<div class="muted small">Пока ничего.</div>`) +
      `<div class="stat"><div class="n">${s.total}</div><div class="l">всего</div></div>`;
}

async function initHistory() {
  const q = $('#histQuery').value.trim();
  const rows = await window.modhub.dbHistory({ q, limit: 200 });
  $('#histList').innerHTML = rows.length ? rows.map((r) => `
    <div class="hist-item">
      <div>
        <b>${esc(r.action)}</b>${r.target ? ' → ' + esc(r.target) : ''}
        <div class="muted small">${esc(r.channel)}</div>
      </div>
      <div class="t">${new Date(r.ts).toLocaleString()}</div>
    </div>`).join('') : `<div class="muted small">Пусто.</div>`;
}

async function refreshNickMeta() {
  const nick = $('#modNick').value.replace(/^@/, '').trim();
  if (!nick) { $('#nickMeta').textContent = 'Введи ник, чтобы посмотреть.'; return; }
  const m = await window.modhub.dbNick(nick);
  $('#nickMeta').innerHTML = `<b>${esc(nick)}</b><br>действий: <b>${m.actions}</b>${m.last ? ' · последнее: ' + new Date(m.last).toLocaleString() : ''}`;
  $('#nickNote').value = m.note || '';
}
async function saveNote() {
  const nick = $('#modNick').value.replace(/^@/, '').trim();
  if (!nick) return;
  await window.modhub.dbNoteSet(nick, $('#nickNote').value);
  toast('Заметка сохранена');
}

// ---------------- LOGIN ----------------
async function doLogin() {
  const r = await window.modhub.twitchLogin();
  if (!r.ok) { toast('Ошибка: ' + r.error); return; }
  toast('Вошёл, обновляю…', 800);
  if (currentChannel) await window.modhub.saveSettings({ lastChannel: currentChannel });
  setTimeout(() => location.reload(), 500);
}
async function doLogout() { await window.modhub.twitchLogout(); location.reload(); }

// ---------------- ЭКРАН ВХОДА ----------------
let gateBound = false;
function showGate(msg) {
  document.body.classList.add('locked');
  $('#loginGate').hidden = false;
  $('#gateMsg').textContent = msg || '';
  $('#gateClientId').value = (settings && settings.clientId) || '';
  if (gateBound) return;
  gateBound = true;
  const btn = $('#gateLogin');
  btn.addEventListener('click', async () => {
    const cid = $('#gateClientId').value.trim();
    btn.disabled = true;
    btn.textContent = 'Открываю Twitch…';
    $('#gateMsg').textContent = '';
    try {
      if (cid && cid !== settings.clientId) settings = await window.modhub.saveSettings({ clientId: cid });
      const r = await window.modhub.twitchLogin();
      if (!r.ok) throw new Error(r.error || 'вход не выполнен');
      location.reload();
    } catch (e) {
      $('#gateMsg').textContent = 'Не получилось войти: ' + ((e && e.message) || e);
      btn.disabled = false;
      btn.textContent = 'Войти через Twitch';
    }
  });
}

// ---------------- МОИ ПОДПИСКИ (все каналы, на которые подписан) ----------------
async function loadFollowing() {
  followingLoaded = true;
  $('#followList').innerHTML = '<div class="muted small" style="padding:10px">Загружаю…</div>';
  try {
    const r = await window.modhub.following();
    if (r && r.ok) {
      followingAll = r.list || [];
    } else {
      followingLoaded = false;
      $('#followList').innerHTML = `<div class="muted small" style="padding:10px">Не удалось загрузить подписки${r && r.error ? ': ' + esc(r.error) : ''}</div>`;
      return;
    }
  } catch {
    followingLoaded = false;
    return;
  }
  renderFollowing();
}
function renderFollowing() {
  const el = $('#followList');
  const q = ($('#followSearch').value || '').trim().toLowerCase();
  const live = new Set(((me && me.streams) || []).map((s) => s.login));
  // только те, кто сейчас НЕ стримит — стримящие уже показаны выше
  const offline = followingAll.filter((x) => !live.has(x.login));
  const list = offline
      .filter((x) => !q || x.login.includes(q) || String(x.name).toLowerCase().includes(q))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
  $('#followCount').textContent = offline.length;
  if (!list.length) {
    const t = q ? 'Ничего не найдено' : followingAll.length ? 'Все подписки сейчас в эфире' : 'Подписок пока нет';
    el.innerHTML = `<div class="follow-empty">${t}</div>`;
    return;
  }
  const SHOW = 600;
  el.innerHTML = list.slice(0, SHOW).map((x) =>
      `<span class="follow-item${x.login === currentChannel ? ' active' : ''}" data-ch="${esc(x.login)}" title="${esc(x.name)}">${esc(x.name)}</span>`
  ).join('') + (list.length > SHOW ? `<span class="follow-empty">+${list.length - SHOW} — уточни поиск</span>` : '');
}

// ---------------- ADMIN ----------------
async function initAdmin() {
  const st = await window.modhub.adminState();
  if (st.cfg) {
    $('#annId').value = st.cfg.announcement?.id || '';
    $('#annText').value = st.cfg.announcement?.text || '';
    $('#adRules').value = (st.cfg.adPatterns || []).join('\n');
  }
  $('#remoteUrl').value = st.remoteUrl || '';
  $('#remoteUrl').addEventListener('change', (e) => window.modhub.saveSettings({ remoteUrl: e.target.value.trim() }));
  if (st.isAdmin) showAdminPanel();

  $('#btnAdminSetup').addEventListener('click', async () => {
    const pw = $('#adminPw').value;
    const r = await window.modhub.adminSetup(pw);
    $('#adminMsg').textContent = r.ok ? 'Пароль задан, ты разблокирован' : 'Ошибка: ' + r.error;
    if (r.ok) showAdminPanel();
  });
  $('#btnAdminUnlock').addEventListener('click', async () => {
    const pw = $('#adminPw').value;
    const r = await window.modhub.adminUnlock(pw);
    $('#adminMsg').textContent = r.ok ? 'Разблокировано' : 'Ошибка: ' + r.error;
    if (r.ok) showAdminPanel();
  });
  $('#btnSaveCfg').addEventListener('click', async () => {
    const cfg = {
      announcement: { id: $('#annId').value.trim(), text: $('#annText').value.trim() },
      adPatterns: $('#adRules').value.split('\n').map((x) => x.trim()).filter(Boolean),
    };
    const r = await window.modhub.adminSaveCfg(cfg);
    toast(r.ok ? 'Сохранено' : r.error);
  });
  $('#btnExportCfg').addEventListener('click', async () => {
    const r = await window.modhub.adminExportConfig();
    if (r.ok) toast('Файл сохранён: ' + r.path, 5000);
  });
  $('#btnFetchCfg').addEventListener('click', async () => {
    const r = await window.modhub.adminForceFetch();
    $('#remoteStatus').textContent =
        'Объявление: ' + ((r && r.announcement && r.announcement.text) || '—') +
        ' · правил: ' + ((r && r.adPatterns && r.adPatterns.length) || 0);
  });
  $('#btnLockAdmin').addEventListener('click', async () => {
    await window.modhub.adminLock();
    $('#adminPanel').hidden = true;
    $('#adminLocked').hidden = false;
  });
}
function showAdminPanel() {
  $('#adminLocked').hidden = true;
  $('#adminPanel').hidden = false;
}

// ---------------- ПЛЕЕР И ЗАДЕРЖКА ----------------
function mountPlayer(ch) {
  stopLatency();
  twPlayer = null;
  autoLiveOff = false;
  catchupAt = 0;
  $('#latPill').hidden = true;
  const slot = $('#playerSlot');
  slot.innerHTML = '';
  if (window.Twitch && window.Twitch.Player) {
    try {
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;inset:0';
      slot.appendChild(host);
      twPlayer = new window.Twitch.Player(host, {
        channel: ch, parent: ['localhost', '127.0.0.1'], width: '100%', height: '100%', autoplay: true, muted: false,
      });
      twPlayer.addEventListener(window.Twitch.Player.PLAYING, startLatency);
      return;
    } catch { twPlayer = null; slot.innerHTML = ''; }
  }
  // запасной вариант (нет интернета для embed-скрипта) — обычный iframe, без замера задержки
  slot.innerHTML =
    `<iframe allow="autoplay; fullscreen; picture-in-picture; encrypted-media" ` +
    `src="https://player.twitch.tv/?channel=${ch}&parent=127.0.0.1&parent=localhost&muted=false&autoplay=true&controls=true"></iframe>`;
}
function startLatency() {
  if (latencyTimer) return;
  lagHits = 0;
  latencyTimer = setInterval(() => {
    if (!twPlayer) return;
    let st = null;
    try { st = twPlayer.getPlaybackStats(); } catch { return; }
    const lag = st && +st.hlsLatencyBroadcaster;
    if (!(lag > 0)) return;
    showLatency(lag);
    let paused = false;
    try { paused = !!twPlayer.isPaused(); } catch {}
    // телефон/окно в фоне или пауза — не трогаем
    if (paused || document.hidden) { lagHits = 0; return; }
    // после перезапуска проверяем: если задержка не ушла — дальше не мучаем плеер перезапусками
    if (catchupAt && Date.now() - catchupAt > 15000) {
      if (lag > 12) {
        autoLiveOff = true;
        toast('Задержка задаётся настройками Twitch: в шестерёнке плеера → «Дополнительно» → включи «Режим минимальной задержки»', 9000);
      }
      catchupAt = 0;
    }
    if (settings.autoLive !== false && !autoLiveOff && lag > 12) {
      lagHits++;
      if (lagHits >= 3 && Date.now() - lastCatchUp > 60000) {
        lastCatchUp = Date.now();
        lagHits = 0;
        goLive(true);
      }
    } else lagHits = 0;
  }, 4000);
}
function stopLatency() { clearInterval(latencyTimer); latencyTimer = null; }
function showLatency(lag) {
  const p = $('#latPill');
  p.hidden = false;
  $('#latVal').textContent = lag.toFixed(1) + ' с';
  p.classList.toggle('good', lag <= 6);
  p.classList.toggle('warn', lag > 6 && lag <= 12);
  p.classList.toggle('bad', lag > 12);
}
function goLive(auto) {
  if (!currentChannel) return;
  mountPlayer(currentChannel);
  if (auto) catchupAt = Date.now();
  toast(auto ? '⏩ Стрим отставал — догоняю эфир' : '⟳ Плеер перезапущен — прямой эфир', 2200);
  const b = $('#btnLive');
  b.classList.add('btn-live-flash');
  setTimeout(() => b.classList.remove('btn-live-flash'), 2100);
}

// ---------------- ПАНЕЛЬ НАСТРОЕК: открыть / закрыть ----------------
function initPanel() {
  panelOpen = settings.panelOpen !== false;
  applyPanel();
  $('#btnLive').addEventListener('click', () => goLive(false));
  $('#autoLive').checked = settings.autoLive !== false;
  $('#autoClaim').checked = settings.autoClaim !== false;
  $('#autoLive').addEventListener('change', (e) => {
    settings.autoLive = e.target.checked;
    autoLiveOff = false;
    window.modhub.saveSettings({ autoLive: e.target.checked });
  });
  $('#autoClaim').addEventListener('change', async (e) => {
    settings.autoClaim = e.target.checked;
    await window.modhub.saveSettings({ autoClaim: e.target.checked });
    if (currentChannel) startPointsWatch(currentChannel);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#sheet').hidden) closeSheet();
    else if (window.innerWidth > 900 && panelOpen) togglePanel(false);
  });
}
function applyPanel() {
  $('.layout').classList.toggle('panel-off', !panelOpen);
  $('#btnPanel').classList.toggle('on', panelOpen);
}
function selectTab(name) {
  const t = document.querySelector(`.tab[data-tab="${name}"]`);
  if (t) t.click();
}
// ⚙: закрыта → открывает на «Настройках»; открыта на другой вкладке → переключает на настройки; уже на настройках → закрывает. ✕ и Esc — всегда закрывают.
function togglePanel(force) {
  if (window.innerWidth <= 900) {
    const open = $('#colPanel').classList.contains('active');
    if (force === false || (force === undefined && open)) showMobile('player');
    else { showMobile('panel'); if (force === undefined) selectTab('set'); }
    return;
  }
  const onSettings = document.querySelector('.tab[data-tab="set"]').classList.contains('active');
  if (force === false) panelOpen = false;
  else if (force === true) panelOpen = true;
  else if (!panelOpen) { panelOpen = true; selectTab('set'); }
  else if (!onSettings) selectTab('set');
  else panelOpen = false;
  applyPanel();
  window.modhub.saveSettings({ panelOpen });
}

// ---------------- ОФИЦИАЛЬНЫЙ ЧАТ TWITCH (видны баллы и бонусы) ----------------
function initChatMode() {
  applyChatMode(settings.chatMode === 'twitch');
  $('#btnChatMode').addEventListener('click', () => {
    const on = settings.chatMode !== 'twitch';
    settings.chatMode = on ? 'twitch' : 'own';
    window.modhub.saveSettings({ chatMode: settings.chatMode });
    applyChatMode(on);
  });
}
function applyChatMode(on) {
  const emb = $('#chatEmbed');
  $('#chatBody').hidden = on;
  $('#chatForm').hidden = on;
  emb.hidden = !on;
  $('#btnChatMode').textContent = on ? 'Свой чат' : 'Чат Twitch';
  if (on && currentChannel) emb.src = `https://www.twitch.tv/embed/${currentChannel}/chat?parent=localhost&parent=127.0.0.1&darkpopout`;
  if (!on) emb.removeAttribute('src');
}

// ---------------- БЕЙДЖИ И НИК ----------------
async function loadBadgesFor(ch) {
  try { badgeMap = (await window.modhub.badges(ch)) || {}; } catch { badgeMap = {}; }
  if (ch === currentChannel) updateMeBadge();
}
const badgeImg = (key) => {
  const u = badgeMap[key];
  return u ? `<img src="${esc(u)}" alt="" title="${esc(key.split('/')[0])}">` : '';
};
function myLogin() { return ((me && me.me) || chatLogin || '').toLowerCase(); }
function ownChannel() { const l = myLogin(); return !!l && l === currentChannel; }
function updateMeBadge() {
  const login = myLogin();
  if (!login) return;
  const own = ownChannel();
  const img = isModOnChannel ? badgeImg(own ? 'broadcaster/1' : 'moderator/1') : '';
  const vip = /(^|,)vip\//.test(myBadges) ? badgeImg('vip/1') || '💎' : '';
  $('#meLabel').innerHTML = img + vip + '@' + esc(login);
  $('#modBadge').innerHTML = img;
  $('#modNickTxt').textContent = (img ? '' : '🛡 ') + '@' + login + (own ? ' · стример' : ' · модератор');
}
function applyModUi() {
  $('#modPill').hidden = !isModOnChannel;
  $('#noModCard').hidden = isModOnChannel;
  document.querySelector('.mod-only').style.display = isModOnChannel ? '' : 'none';
  $('#bcWrap').hidden = !isModOnChannel;
  const own = ownChannel();
  $('#pollCard').hidden = !own;
  $('#predCard').hidden = !own;
  $('#bcHint').hidden = own || !isModOnChannel;
  updateMeBadge();
  refreshBc();
}

// ---------------- БАЛЛЫ КАНАЛА ----------------
const fmtPts = (n) => { n = +n || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : n.toLocaleString('ru-RU'); };
function showPoints(txt, title) {
  const p = $('#pointsPill');
  $('#pointsVal').textContent = txt;
  p.hidden = false;
  if (title) p.title = title;
}
function startPointsWatch(ch) {
  pointsSeen = false;
  clearTimeout(pointsFallbackT);
  $('#pointsPill').hidden = true;
  if (!settings.loggedIn) { window.modhub.pointsStop(); return; }
  window.modhub.pointsWatch(ch);
  // если через скрытое окно не получилось — пробуем запасной неофициальный запрос
  pointsFallbackT = setTimeout(async () => {
    if (pointsSeen || ch !== currentChannel) return;
    try {
      const g = await window.modhub.points(ch);
      if (g && g.ok && !pointsSeen) showPoints(fmtPts(g.balance), 'Баллы канала #' + ch);
    } catch {}
  }, 15000);
}
function setPoints(p) {
  if (!p || p.channel !== currentChannel) return;
  if (p.balance) {
    pointsSeen = true;
    showPoints(p.balance, 'Баллы канала #' + currentChannel);
  } else if (p.logged === false && !pointsSeen) {
    showPoints('войди', 'Баллы не видны: войди в Twitch (⚙ → Войти)');
  }
  if (p.claimed) toast('🎁 Бонус баллов собран');
}

// ---------------- МУТ/БАН, ОПРОСЫ, СТАВКИ ----------------
function initBroadcast() {
  const nick = () => ($('#modNick').value || lastChatUser).replace(/^@/, '').trim();
  const withNick = (cmd) => { if (!nick()) { toast('Укажи ник'); return; } modAction(cmd); };
  $('#btnMuteDur').addEventListener('click', () => withNick(`/timeout {nick} ${$('#modDur').value}`));
  $('#btnUnmuteDur').addEventListener('click', () => withNick('/untimeout {nick}'));
  $('#btnBanDur').addEventListener('click', () => withNick('/ban {nick}'));
  $('#btnUnbanDur').addEventListener('click', () => withNick('/unban {nick}'));

  const addInput = (box, ph, max) => {
    const n = $$('.pc', box).length;
    if (n >= max) { toast('Максимум ' + max); return; }
    const i = document.createElement('input');
    i.className = 'pc';
    i.maxLength = 25;
    i.placeholder = ph + ' ' + (n + 1);
    box.appendChild(i);
  };
  $('#pollAdd').addEventListener('click', () => addInput($('#pollChoices'), 'Вариант', 5));
  $('#predAdd').addEventListener('click', () => addInput($('#predChoices'), 'Исход', 10));
  const vals = (box) => $$('.pc', box).map((x) => x.value);
  const clear = (box) => $$('.pc', box).forEach((x) => (x.value = ''));

  $('#pollStart').addEventListener('click', async () => {
    const title = $('#pollTitle').value.trim();
    const r = await window.modhub.pollCreate({ channel: currentChannel, title, choices: vals($('#pollChoices')), duration: +$('#pollDur').value });
    if (!r.ok) { toast('⚠ ' + r.error, 7000); return; }
    toast('📊 Опрос запущен');
    logAction('poll', '', title, 0, 'poll: ' + title);
    $('#pollTitle').value = '';
    clear($('#pollChoices'));
    refreshBc();
  });
  $('#predStart').addEventListener('click', async () => {
    const title = $('#predTitle').value.trim();
    const r = await window.modhub.predCreate({ channel: currentChannel, title, outcomes: vals($('#predChoices')), window: +$('#predWin').value });
    if (!r.ok) { toast('⚠ ' + r.error, 7000); return; }
    toast('🎯 Ставка запущена');
    logAction('prediction', '', title, 0, 'prediction: ' + title);
    $('#predTitle').value = '';
    clear($('#predChoices'));
    refreshBc();
  });
  $('#pollLive').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-poll-end]');
    if (!b) return;
    const r = await window.modhub.pollEnd({ channel: currentChannel, pollId: b.dataset.pollEnd });
    toast(r.ok ? 'Опрос завершён' : '⚠ ' + r.error, r.ok ? 2500 : 7000);
    refreshBc();
  });
  $('#predLive').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pred]');
    if (!b) return;
    if (b.dataset.pred === 'RESOLVED' && !confirm('Завершить ставку: победитель «' + b.dataset.title + '»?')) return;
    const r = await window.modhub.predSet({ channel: currentChannel, predId: b.dataset.id, status: b.dataset.pred, outcomeId: b.dataset.out });
    toast(r.ok ? 'Ставка обновлена' : '⚠ ' + r.error, r.ok ? 2500 : 7000);
    refreshBc();
  });
  $('#btnModView').addEventListener('click', () => {
    if (!currentChannel) { toast('Сначала открой канал'); return; }
    window.modhub.openExternal('https://www.twitch.tv/moderator/' + currentChannel);
  });
  // активный опрос/ставку подтягиваем редко и только когда панель видна
  clearInterval(bcTimer);
  bcTimer = setInterval(() => { if (!document.hidden && (panelOpen || window.innerWidth <= 900)) refreshBc(); }, 20000);
}
async function refreshBc() {
  if (!currentChannel || !isModOnChannel || !ownChannel()) { $('#pollLive').hidden = true; $('#predLive').hidden = true; return; }
  const r = await window.modhub.bcState({ channel: currentChannel });
  if (!r || !r.ok) return; // ошибку (нет прав/не Affiliate) покажем, только когда нажмёшь «Запустить»
  renderPoll(r.data.poll);
  renderPred(r.data.pred);
}
function renderPoll(p) {
  const el = $('#pollLive');
  if (!p) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<b>📊 ${esc(p.title)}</b>` +
    (p.choices || []).map((c) => `<div class="bc-opt"><span>${esc(c.title)}</span><span>${c.votes || 0}</span></div>`).join('') +
    `<div class="bc-actions"><button class="danger" data-poll-end="${esc(p.id)}">⏹ Завершить опрос</button></div>`;
}
function renderPred(p) {
  const el = $('#predLive');
  if (!p) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const btn = (st, label, extra = '', cls = '') =>
    `<button class="${cls}" data-pred="${st}" data-id="${esc(p.id)}" ${extra}>${label}</button>`;
  el.innerHTML =
    `<b>🎯 ${esc(p.title)} <small>(${p.status === 'LOCKED' ? 'приём закрыт' : 'идёт приём'})</small></b>` +
    (p.outcomes || []).map((o) => `<div class="bc-opt"><span>${esc(o.title)}</span><span>${o.users || 0} 👤 · ${fmtPts(o.channel_points)}</span></div>`).join('') +
    `<div class="bc-actions">` +
    (p.status === 'ACTIVE' ? btn('LOCKED', '🔒 Закрыть приём') : '') +
    (p.outcomes || []).map((o) => btn('RESOLVED', '🏆 ' + esc(o.title), `data-out="${esc(o.id)}" data-title="${esc(o.title)}"`)).join('') +
    btn('CANCELED', '↩ Отменить (вернуть баллы)', '', 'danger') +
    `</div>`;
}

// ---------------- UTILS ----------------
function setAdCount(n) {
  $('#adCount').textContent = n;
  $('#adStat').textContent = n;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtNum(n) { n = +n || 0; return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
let toastT;
function toast(msg, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), ms);
}
function openSheet(title, items) {
  const card = $('#sheetCard');
  card.innerHTML = `<div class="sheet-title">${esc(title)}</div>` +
      items.map((it, i) => `<button class="sheet-btn${it.danger ? ' danger' : ''}${it.cancel ? ' cancel' : ''}" data-i="${i}">${esc(it.label)}</button>`).join('');
  $$('.sheet-btn', card).forEach((b) => b.addEventListener('click', () => {
    const it = items[+b.dataset.i];
    closeSheet();
    if (it && it.action) it.action();
  }));
  $('#sheet').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; }
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

function onUpdate(d) {
  if (d.state === 'ready') toast('Обновление ' + d.version + ' готово — установится при выходе', 8000);
  else if (d.state === 'downloading') toast('Скачивается обновление ' + d.version, 4000);
}

boot();