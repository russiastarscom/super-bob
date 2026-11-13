/* ============================================================
   Дамп уровней через НАСТОЯЩИЙ парсер игры (без расхождений).
   Запускает основной скрипт index.html в Node со стабами DOM,
   затем parseLevel(i) для всех карт; результат — шаблоны уровней
   для быстрого пути (умный кеш сборщика).
   Использование: node tools/dump_levels.js <index.html> <maps.js> <out.json>
   ============================================================ */
'use strict';
const fs = require('fs');

const [, , htmlPath, mapsPath, outPath] = process.argv;
const html = fs.readFileSync(htmlPath, 'utf8');
const mapsSrc = fs.readFileSync(mapsPath, 'utf8');

/* ---------- универсальный «магический» стаб: годится как число, объект, функция ---------- */
function magic() {
  const f = function () { return m; };
  const m = new Proxy(f, {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === 'width' || p === 'length') return 0;
      if (p === 'then') return undefined;         // не Promise
      return m;
    },
    set() { return true; },
    apply() { return m; },
    construct() { return m; },
    has() { return true; }
  });
  return m;
}

function mkEl() {
  const el = {
    style: {}, dataset: {}, children: [], width: 512, height: 288, hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { return c; }, removeChild(c) { return c; }, remove() {},
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null,
    querySelector: () => mkEl(), querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 512, bottom: 288, width: 512, height: 288 }),
    focus() {}, click() {}, contains: () => false, insertBefore(c) { return c; },
    getContext: () => magic(), toDataURL: () => '', measureText: () => ({ width: 0 })
  };
  Object.defineProperty(el, 'innerHTML', { get: () => '', set: () => {} });
  Object.defineProperty(el, 'textContent', { get: () => '', set: () => {} });
  Object.defineProperty(el, 'value', { get: () => '', set: () => {} });
  return el;
}

const els = new Map();
const doc = {
  getElementById(id) { if (!els.has(id)) els.set(id, mkEl()); return els.get(id); },
  createElement: () => mkEl(), createTextNode: () => mkEl(),
  addEventListener() {}, removeEventListener() {},
  querySelector: () => mkEl(), querySelectorAll: () => [],
  body: mkEl(), documentElement: mkEl(), head: mkEl(),
  hidden: false, visibilityState: 'visible', title: '',
  write() {}, writeln() {}, open() {}, close() {}
};

/* ---------- глобальные стабы ---------- */
const g = globalThis;
g.window = g;
g.document = doc;
g.location = { search: '', href: 'file:///index.html', protocol: 'file:', pathname: '/index.html', hash: '' };
try { g.navigator = g.navigator || { userAgent: 'node-dump', maxTouchPoints: 0 }; } catch (e) {}
g.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
g.sessionStorage = g.localStorage;
g.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
g.requestAnimationFrame = () => 0;
g.cancelAnimationFrame = () => {};
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.AudioContext = g.webkitAudioContext = function () { return magic(); };
g.Image = function () { return mkEl(); };
g.WebSocket = function () { return magic(); };
g.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
g.alert = () => {};
g.history = { pushState() {}, replaceState() {} };
g.screen = { width: 1280, height: 720 };
g.performance = g.performance || { now: () => Date.now() };
g.innerWidth = 1280; g.innerHeight = 720; g.outerWidth = 1280; g.outerHeight = 720;
g.devicePixelRatio = 1; g.pageXOffset = 0; g.pageYOffset = 0; g.scrollX = 0; g.scrollY = 0;
g.scrollTo = () => {}; g.scroll = () => {};
g.getComputedStyle = () => ({ getPropertyValue: () => '' });
g.open = () => null; g.close = () => {}; g.focus = () => {}; g.blur = () => {};
g.name = ''; g.status = ''; g.frameElement = null; g.frames = g; g.parent = g; g.top = g; g.self = g;

/* ---------- карты: window.GAME_MAPS ---------- */
new Function(mapsSrc)();

const suffix = `
;globalThis.__BOB_DUMP = (function () {
  const out = { n: MAPS.length, lv: [], err: null };
  for (let i = 0; i < MAPS.length; i++) {
    try {
      parseLevel(i);
      const q = []; for (const [k, v] of L.q) q.push([k, v]);
      out.lv.push({
        W: L.W, H: L.H, idx: L.idx, chars: L.chars.join(''),
        grid: b64(L.grid), q,
        coins: L.coins, enemies: L.enemies, plats: L.plats, items: L.items,
        start: L.start, flagX: L.flagX, flagRow: L.flagRow, flagTop: L.flagTop,
        flagBase: L.flagBase, castleX: L.castleX,
        bossIdx: L.boss ? L.enemies.indexOf(L.boss) : -1,
        bossZone: L.bossZone, bossFloor: L.bossFloor === undefined ? null : L.bossFloor,
        checkpoint: L.checkpoint, pal: L.pal, name: L.name, theme: L.theme,
        boxes: L.boxes, plates: L.plates, gates: L.gates, locks: L.locks,
        keys: L.keys, planks: L.planks, coinsTotal: L.coinsTotal, par: L.par
      });
    } catch (e) { out.lv.push(null); out.err = (out.err || []).concat(i + ': ' + (e && e.stack || e)); }
  }
  return out;
  function b64(u8) {
    const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let s = '';
    for (let i = 0; i < u8.length; i += 3) {
      const a = u8[i], b = u8[i + 1], c = u8[i + 2];
      s += CH[a >> 2] + CH[((a & 3) << 4) | ((b === undefined ? 0 : b) >> 4)] +
           (b === undefined ? '=' : CH[((b & 15) << 2) | (c === undefined ? 0 : c) >> 6]) +
           (c === undefined ? '=' : CH[c & 63]);
    }
    return s;
  }
})();`;

/* ---------- inline-скрипты страницы (как в браузере, по порядку) ---------- */
const blocks = [];
{
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
}
if (blocks.length < 2) { console.error('inline-скрипты не найдены'); process.exit(1); }
for (let i = 0; i < blocks.length; i++) {
  const code = i === blocks.length - 1 ? blocks[i] + suffix : blocks[i];
  try { new Function(code)(); }
  catch (e) { console.error(`ОШИБКА inline-скрипта #${i}:`, e.stack); process.exit(1); }
}

try {
  /* скрипты уже исполнены; здесь только проверка, что дамп возможен */
  if (typeof g.__BOB_DUMP === 'undefined') throw new Error('суффикс дампа не был исполнен');
} catch (e) {
  console.error('ОШИБКА ВЫПОЛНЕНИЯ СКРИПТА ИГРЫ:', e.stack);
  process.exit(1);
}

const dump = g.__BOB_DUMP;
if (!dump) { console.error('дамп не создан'); process.exit(1); }
fs.writeFileSync(outPath, JSON.stringify(dump));
const ok = dump.lv.filter(Boolean).length;
console.log(`уровней: ${ok}/${dump.n}, ошибок: ${dump.err ? dump.err.length : 0}`);
if (dump.err) console.log(dump.err.join('\n'));
process.exit(ok === dump.n ? 0 : 2);
