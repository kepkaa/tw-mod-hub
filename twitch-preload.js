// Прелоад для webview с плеером Twitch (player.twitch.tv открывается напрямую, не в iframe).
// Подменяет тип плеера в запросе токена — Twitch отдаёт поток без рекламных вставок.
// Если Twitch это закроет, достаточно поменять PT ниже или выключить «Режим без рекламы» в настройках.
const { webFrame } = require('electron');

const CODE = `(() => {
  if (window.__mhAd) return; window.__mhAd = 1;
  const PT = 'picture-by-picture';
  const of = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('gql.twitch.tv/gql') > -1 && init && typeof init.body === 'string' && init.body.indexOf('PlaybackAccessToken') > -1) {
        const b = JSON.parse(init.body);
        const fix = (o) => { if (o && o.variables && 'playerType' in o.variables) o.variables.playerType = PT; };
        Array.isArray(b) ? b.forEach(fix) : fix(b);
        init = Object.assign({}, init, { body: JSON.stringify(b) });
      }
    } catch (e) {}
    return of.call(this, input, init);
  };
  const css = document.createElement('style');
  css.textContent = '[data-a-target="video-ad-label"],[data-a-target="player-overlay-ad"],[data-test-selector="ad-banner-default-text"],[class*="ad-banner"],.consent-banner{display:none!important}';
  (document.head || document.documentElement).appendChild(css);
})();`;

try {
  webFrame.executeJavaScript(CODE);
} catch {}
