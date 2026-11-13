/* ============================================================
   ВЕРИФИКАТОР умного кеша уровней: грузит игру + levels_cache.js,
   прогоняет БЫСТРЫЙ путь parseLevel для всех уровней и сверяет
   результат с шаблоном кеша (сетка, символы, спавны, босс).
   Запуск: node tools/verify_cache.js <index.html> <maps.js> <levels_cache.js>
   Код 0 — кеш корректен.
   ============================================================ */
'use strict';
const fs = require('fs');

const [, , htmlPath, mapsPath, cachePath] = process.argv;
const html = fs.readFileSync(htmlPath, 'utf8');
const mapsSrc = fs.readFileSync(mapsPath, 'utf8');
const cacheSrc = fs.readFileSync(cachePath, 'utf8');

function magic() {
  const f = function () { return m; };
  const m = new Proxy(f, {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === 'width' || p === 'length') return 0;
      if (p === 'then') return undefined;
      return m;
    },
    set() { return true; }, apply() { return m; }, construct() { return m; }, has() { return true; }
  });
  return m;
}
function mkEl() {
  const el = {
    style: {}, dataset: {}, children: [], width: 512, height: 288,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { return c; }, remove() {}, addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute: () => null,
    querySelector: () => mkEl(), querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 512, bottom: 288, width: 512, height: 288 }),
    getContext: () => magic(), toDataURL: () => ''
  };
  return el;
}
const els = new Map();
const g = globalThis;
g.window = g;
g.document = {
  getElementById(id) { if (!els.has(id)) els.set(id, mkEl()); return els.get(id); },
  createElement: () => mkEl(), createTextNode: () => mkEl(),
  addEventListener() {}, removeEventListener() {},
  querySelector: () => mkEl(), querySelectorAll: () => [],
  body: mkEl(), documentElement: mkEl(), head: mkEl(),
  hidden: false, visibilityState: 'visible', title: '', write() {}, writeln() {}
};
g.location = { search: '', href: 'file:///index.html', protocol: 'file:', pathname: '/index.html', hash: '' };
g.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
g.sessionStorage = g.localStorage;
g.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, addListener() {} });
g.requestAnimationFrame = () => 0;
g.addEventListener = () => {}; g.removeEventListener = () => {};
g.AudioContext = g.webkitAudioContext = function () { return magic(); };
g.Image = function () { return mkEl(); };
g.innerWidth = 1280; g.innerHeight = 720; g.outerWidth = 1280; g.outerHeight = 720;
g.devicePixelRatio = 1; g.pageXOffset = 0; g.pageYOffset = 0;
g.scrollTo = () => {}; g.getComputedStyle = () => ({ getPropertyValue: () => '' });
try { g.navigator = g.navigator || { userAgent: 'node-verify', maxTouchPoints: 0 }; } catch (e) {}

new Function(mapsSrc)();
new Function(cacheSrc)();          // window.__BOB_LVLC = {...}

const blocks = [];
{ const re = /<script>([\s\S]*?)<\/script>/g; let m; while ((m = re.exec(html)) !== null) blocks.push(m[1]); }
for (let i = 0; i < blocks.length; i++) {
  const code = i === blocks.length - 1
    ? blocks[i] + ';globalThis.__PARSE = parseLevel; globalThis.__GETL = () => L; globalThis.__MAPS = MAPS;'
    : blocks[i];
  try { new Function(code)(); }
  catch (e) { console.error(`ОШИБКА inline-скрипта #${i}:`, e.stack); process.exit(1); }
}

const C = g.__BOB_LVLC, MAPS = g.__MAPS;
if (!C || !C.lv) { console.error('кеш не загружен'); process.exit(1); }

function b64U8(s) {
  const bin = Buffer.from(s, 'base64');
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

let bad = 0;
for (let i = 0; i < MAPS.length; i++) {
  g.__PARSE(i);
  const L = g.__GETL(), t = C.lv[i];
  if (!L._fast) { console.error(`уровень ${i}: БЫСТРЫЙ ПУТЬ НЕ СРАБОТАЛ (сигнатура?)`); bad++; continue; }
  const errs = [];
  if (L.W !== t.W || L.H !== t.H) errs.push('размер');
  const g1 = b64U8(t.grid);
  if (g1.length !== L.grid.length || !g1.every((v, j) => v === L.grid[j])) errs.push('сетка');
  if (L.chars.join('') !== t.chars) errs.push('символы');
  if (L.q.size !== t.q.length) errs.push('q');
  for (const key of ['coins', 'enemies', 'plats', 'items', 'boxes', 'plates', 'gates', 'locks', 'keys', 'planks'])
    if (!eq(L[key], t[key])) errs.push(key);
  if (!!L.boss !== (t.bossIdx >= 0)) errs.push('босс');
  if (L.boss && L.enemies[t.bossIdx] !== L.boss) errs.push('ссылка босса');
  if (L.plankMap.size !== t.planks.length) errs.push('plankMap');
  if (L.coinsTotal !== t.coinsTotal || L.par !== t.par) errs.push('итоги');
  if ((L.start ? [L.start.x, L.start.y] : null) && !eq(L.start, t.start)) errs.push('старт');
  if (errs.length) { console.error(`уровень ${i}: ${errs.join(', ')}`); bad++; }
}
console.log(bad ? `ВЕРИФИКАЦИЯ ПРОВАЛЕНА: плохих уровней ${bad}/${MAPS.length}` : `ВЕРИФИКАЦИЯ OK: все ${MAPS.length} уровней из кеша совпадают с шаблонами`);
process.exit(bad ? 1 : 0);
