// Баллы канала: у Twitch нет официального API для баланса зрителя.
// Поэтому открываем СКРЫТОЕ окно с popout-чатом канала (в той же сессии Twitch, где ты вошёл),
// читаем баланс прямо из страницы и (по желанию) автоматически собираем бонус-сундучок.
const { BrowserWindow } = require('electron');

let w = null;
let timer = null;
let curCh = '';

function stop() {
  clearInterval(timer);
  timer = null;
  curCh = '';
  if (w && !w.isDestroyed()) {
    try { w.destroy(); } catch {}
  }
  w = null;
}

const readCode = (autoClaim) => `(() => {
  const q = (s) => document.querySelector(s);
  const b = q('[data-test-selector="balance-string"]');
  let claimed = false;
  const c = q('.claimable-bonus__icon');
  if (c && ${autoClaim ? 'true' : 'false'}) {
    const btn = c.closest('button');
    if (btn) { btn.click(); claimed = true; }
  }
  return { balance: b ? b.textContent.trim() : '', claimed, logged: !!q('[data-a-target="chat-input"]') };
})()`;

function start(channel, partition, autoClaim, cb) {
  stop();
  curCh = channel;
  w = new BrowserWindow({
    show: false,
    width: 420,
    height: 700,
    webPreferences: { partition, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.webContents.setAudioMuted(true);
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.loadURL(`https://www.twitch.tv/popout/${channel}/chat?popout=`).catch(() => {});
  timer = setInterval(async () => {
    if (!w || w.isDestroyed()) return;
    try {
      const r = await w.webContents.executeJavaScript(readCode(autoClaim));
      cb({ channel: curCh, ...r });
    } catch {}
  }, 5000);
}

module.exports = { start, stop };
