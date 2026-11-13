#!/usr/bin/env python3
# ============================================================
# ПАТЧЕР index.html игры Super Bob:
#  * подключает C++/WASM-движки (bobphys + bobfx) и JS-двойника,
#  * перепаивает горячие функции (solidPx, moveX/moveY, частицы)
#    на движок ENG через тонкие обёртки — семантика 1:1,
#  * добавляет быстрый путь загрузки уровней из прекешированного
#    шаблона (умный кеш) с проверкой сигнатуры карт.
# Каждый дубль-патч проверяется на точное число вхождений.
# Запуск: python3 tools/patch_index.py  (из корня проекта)
# ============================================================
import io, sys, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(ROOT, "index.html")
TWIN = os.path.join(ROOT, "engine", "bob_twin.js")
GLUE = os.path.join(ROOT, "engine", "bob_glue.js")

def read(p):
    with io.open(p, "r", encoding="utf-8") as f: return f.read()

def write(p, s):
    with io.open(p, "w", encoding="utf-8") as f: f.write(s)

html = read(HTML)
twin = read(TWIN).rstrip()
glue = read(GLUE).rstrip()

fails = []
def rep(old, new, n=1, what=""):
    global html
    c = html.count(old)
    if c != n:
        fails.append(f"«{what}»: ожидалось {n} вхождений, найдено {c}")
        return
    html = html.replace(old, new)

# ---------- E1. Подключение движков (после map/maps.js, до основного скрипта) ----------
anchor = '<script src="map/maps.js"></script>'
eng_block = anchor + """
<!-- ЗАЩИТА ОТ СБОЯ: external-движки опциональны; игра работает и без них -->
<script src="engine/bob_engine.js"></script>
<script src="engine/levels_cache.js"></script>
<script>
/* ================= C++/WASM-ДВИЖКИ SUPER BOB =================
   bobphys — коллизии/физика, bobfx — частицы (SoA, ноль аллокаций).
   Ниже встроен JS-двойник движка (fallback), затем клей ENG.
   Эквивалентность проверяется tests/test_equiv.js. */
""" + twin + "\n</script>\n<script>\n" + glue + "\n</script>"
rep(anchor, eng_block, 1, "подключение движков")

# ---------- E2. solidPx -> движок ----------
rep("""const solidPx = (px,py) => {
  if (tileAt(px,py) === 1) return true;
  for (const b of L.boxes)               // толкаемые камни — тоже твёрдые
    if (px >= b.x && px < b.x+b.w && py >= b.y && py < b.y+b.h) return true;
  return false;
};""",
"""const solidPx = (px,py) => ENG.solid(px,py);   // C++/WASM bobphys (JS-двойник как fallback)""",
1, "solidPx")

# ---------- E3. moveX/moveY -> обёртки движка ----------
rep("""function moveX(e, dt) {                  // общий X-проход с коллизиями
  e.x += e.vx*dt;
  const y0 = Math.floor((e.y+1)/16), y1 = Math.floor((e.y+e.h-1)/16);
  if (e.vx > 0) { const tx = Math.floor((e.x+e.w)/16);
    for (let ty=y0; ty<=y1; ty++) if (solidPx(tx*16+8, ty*16+8)) { e.x = tx*16 - e.w - 0.01; e.hitWall = 1; return; } }
  else if (e.vx < 0) { const tx = Math.floor(e.x/16);
    for (let ty=y0; ty<=y1; ty++) if (solidPx(tx*16+8, ty*16+8)) { e.x = (tx+1)*16 + 0.01; e.hitWall = -1; return; } }
  e.hitWall = 0;
}
function moveY(e, dt) {                  // Y-проход; для игрока — бамп блоков
  e.y += e.vy*dt; e.grounded = false; e.onPlat = null;
  const x0 = Math.floor((e.x+1)/16), x1 = Math.floor((e.x+e.w-1)/16);
  if (e.vy >= 0) { const ty = Math.floor((e.y+e.h)/16);
    for (let tx=x0; tx<=x1; tx++) if (solidPx(tx*16+8, ty*16+8)) {
      e.y = ty*16 - e.h; e.vy = 0; e.grounded = true; return; } }
  else { const ty = Math.floor(e.y/16);
    let bumped = -1, best = 1e9;
    for (let tx=x0; tx<=x1; tx++) if (solidPx(tx*16+8, ty*16+8)) {
      const d = Math.abs((tx*16+8) - (e.x+e.w/2)); if (d < best) { best = d; bumped = tx; } }
    if (bumped >= 0) { e.y = (ty+1)*16 + 0.01; e.vy = 0; if (e.isPlayer) bumpBlock(bumped, ty); } }
}""",
"""function moveX(e, dt) { ENG.moveX(e, dt); }   // X-проход с коллизиями — C++/WASM bobphys
function moveY(e, dt) {                  // Y-проход; бамп блоков — семантика прежняя, тело в движке
  ENG.moveY(e, dt);
  e.onPlat = null;
  if (e.isPlayer && ENG.out[2] >= 0) bumpBlock(ENG.out[2], ENG.out[3]);
}""",
1, "moveX/moveY")

# ---------- E4. Частицы: адаптер L.parts -> движок; хелперы быстрого пути уровней ----------
rep("function parseLevel(idx) {",
"""/* ---------- ЧАСТИЦЫ: пул в движке bobfx (SoA, ноль аллокаций) ----------
   L.parts остаётся точкой записи для всех спавнов игры; обновление
   и рендер идут напрямую по typed-array видам движка. */
const FX_COL = c => c === 'spark' ? 0 : c === 'puff' ? 1 : c === 'brick' ? 2 : c === 'wood' ? 3 : 4;
const FX_FLAGS = p => (p.grav ? 1 : 0) | (p.coinpop ? 2 : 0);
const PARTS = {
  push(p) { ENG.fxSpawn(p.x, p.y, p.vx || 0, p.vy || 0, p.life, p.s || 3, FX_COL(p.col), FX_FLAGS(p)); }
};
/* ---------- УМНЫЙ КЕШ УРОВНЕЙ (сборщик tools/smartcache.py) ----------
   engine/levels_cache.js содержит шаблоны уровней, собранные тем же
   парсером игры. Сигнатура карт защищает от рассинхрона: правили
   карты — кеш сам пересоберётся, иначе игра парсит как раньше. */
let _mapSig = null;
function mapSig() {
  if (_mapSig !== null) return _mapSig;
  let h = 0x811c9dc5;
  const mix = b => { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; };
  const acc = ['BOB-LVLC-1', String(MAPS.length)];
  for (const m of MAPS) {
    acc.push(m.name || '', String(m.theme), (m.rows || []).join(''));
    const p = m.pal || {};
    for (const k in p) acc.push(k, String(p[k]));
  }
  const u = new TextEncoder().encode(acc.join('\x00'));   // одна лента UTF-8
  for (let i = 0; i < u.length; i++) mix(u[i]);
  return _mapSig = h >>> 0;
}
function b64U8(s) {
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function hydrateLevel(t) {                 // быстрый путь: шаблон -> игровой уровень L
  const grid = new Uint8Array(t.W * t.H);
  grid.set(b64U8(t.grid));
  L = { W: t.W, H: t.H, idx: t.idx, grid, chars: t.chars.split(''),
        q: new Map(t.q), coins: JSON.parse(JSON.stringify(t.coins)),
        enemies: JSON.parse(JSON.stringify(t.enemies)),
        plats: JSON.parse(JSON.stringify(t.plats)), parts: PARTS,
        items: JSON.parse(JSON.stringify(t.items)), fireballs: [], amb: [], floats: [],
        start: JSON.parse(JSON.stringify(t.start)), flagX: t.flagX, flagRow: t.flagRow,
        flagTop: t.flagTop, flagBase: t.flagBase, castleX: t.castleX,
        boss: null, bossZone: t.bossZone ? JSON.parse(JSON.stringify(t.bossZone)) : null,
        bossSeen: false, checkpoint: t.checkpoint ? JSON.parse(JSON.stringify(t.checkpoint)) : null,
        pal: t.pal, name: t.name, theme: t.theme,
        boxes: JSON.parse(JSON.stringify(t.boxes)), plates: JSON.parse(JSON.stringify(t.plates)),
        gates: JSON.parse(JSON.stringify(t.gates)), locks: JSON.parse(JSON.stringify(t.locks)),
        keys: JSON.parse(JSON.stringify(t.keys)), gateOpen: false,
        planks: JSON.parse(JSON.stringify(t.planks)), plankMap: new Map(),
        coinsTotal: t.coinsTotal, par: t.par, bossFloor: t.bossFloor };
  for (const pk of L.planks) L.plankMap.set(pk.ty * L.W + pk.tx, pk);
  if (t.bossIdx >= 0) L.boss = L.enemies[t.bossIdx];
  L._fast = true;                          // маркер быстрого пути (для тестов)
}
function parseLevel(idx) {
  const C = typeof window !== 'undefined' ? window.__BOB_LVLC : null;
  if (C && C.lv && C.lv[idx] && C.sig === mapSig()) hydrateLevel(C.lv[idx]);
  else parseLevelSlow(idx);
  finishParse(idx);
}
function parseLevel(idx) {""", 1, "быстрый путь parseLevel")

# после вставки: переименуем оригинальную функцию (второе объявление) в parseLevelSlow
rep("""function parseLevel(idx) {
  const src = MAPS[idx], rows = src.rows;""",
"""function parseLevelSlow(idx) {
  const src = MAPS[idx], rows = src.rows;""", 1, "rename parseLevelSlow")

# ---------- E5. Общий хвост parseLevel -> finishParse (+ синхронизация сетки в движок) ----------
rep("""  // всего монет на уровне (пол + блоки '?') и целевое время для ★★★
  L.coinsTotal = L.coins.length;
  for (const q of L.q.values()) if (q.type === 'coin') L.coinsTotal++;
  L.par = Math.round(clamp(50 + L.W * 0.45, 70, 190)) + (L.boss ? 40 : 0);
  // автосохранение: если в этом уровне уже взята контрольная точка — восстанавливаем
  try { if (L.checkpoint && localStorage.getItem(Save.CPKEY) === String(idx)) L.checkpoint.hit = true; } catch (e) {}
  TILES = buildTiles(L.pal);           // тайлы перекрашиваются под палитру земли
  bakeTiles();                         // статичные тайлы запекаются в слой (один blit на кадр)
  G.timeLeft = CFG.LEVEL_TIME; G.hurry = false; G.bossBannerT = 0;
  G.note = null;                       // подсказки прошлого уровня не тянем дальше
  camX = 0;
}""",
"""}

/* общий хвост загрузки уровня — и для быстрого, и для медленного пути */
function finishParse(idx) {
  G.hasKey = false; G.starT = 0; G.flagT = null;
  G.shieldUsed = false;
  // всего монет на уровне (пол + блоки '?') и целевое время для ★★★
  L.coinsTotal = L.coins.length;
  for (const q of L.q.values()) if (q.type === 'coin') L.coinsTotal++;
  L.par = Math.round(clamp(50 + L.W * 0.45, 70, 190)) + (L.boss ? 40 : 0);
  // автосохранение: если в этом уровне уже взята контрольная точка — восстанавливаем
  try { if (L.checkpoint && localStorage.getItem(Save.CPKEY) === String(idx)) L.checkpoint.hit = true; } catch (e) {}
  TILES = buildTiles(L.pal);           // тайлы перекрашиваются под палитру земли
  bakeTiles();                         // статичные тайлы запекаются в слой (один blit на кадр)
  ENG.setLevel(L.W, L.H, L.grid);      // сетка уровня — в C++/WASM движок
  ENG.fxClear();                       // чистый пул частиц на новый уровень
  G.timeLeft = CFG.LEVEL_TIME; G.hurry = false; G.bossBannerT = 0;
  G.note = null;                       // подсказки прошлого уровня не тянем дальше
  camX = 0;
}""",
1, "finishParse")

# ---------- E6. Арена: parts -> адаптер, сетка -> движок ----------
rep("""        q:new Map(), coins:[], enemies:[], plats:[], parts:[], items:[], fireballs:[],
        amb:[], floats:[], start:{x:240, y:256}, flagX:-1, flagRow:0, flagTop:5, flagBase:0,""",
"""        q:new Map(), coins:[], enemies:[], plats:[], parts: PARTS, items:[], fireballs:[],
        amb:[], floats:[], start:{x:240, y:256}, flagX:-1, flagRow:0, flagTop:5, flagBase:0,""",
1, "арена parts")
rep("""  for (const pl of ARENA_PLATS) L.plats.push({ x:pl.x, y:pl.y, w:pl.w, h:pl.h, dx:0, dy:0 });""",
"""  ENG.setLevel(L.W, L.H, L.grid); ENG.fxClear();   // сетка арены — в движок
  for (const pl of ARENA_PLATS) L.plats.push({ x:pl.x, y:pl.y, w:pl.w, h:pl.h, dx:0, dy:0 });""",
1, "арена сетка")
# у parseLevelSlow поле parts:[] заменим на адаптер (fast path уже ставит PARTS)
rep("""        q:new Map(), coins:[], enemies:[], plats:[], parts:[], items:[], fireballs:[],
        amb:[], floats:[], start:{x:32,y:0}, flagX:-1, flagRow:0, flagTop:5, flagBase:0, castleX:-1, boss:null,""",
"""        q:new Map(), coins:[], enemies:[], plats:[], parts: PARTS, items:[], fireballs:[],
        amb:[], floats:[], start:{x:32,y:0}, flagX:-1, flagRow:0, flagTop:5, flagBase:0, castleX:-1, boss:null,""",
1, "parseLevelSlow parts")

# ---------- E7. Мутации сетки -> зеркалим в движок ----------
rep("""    const i = gt.ty*L.W + gt.tx;
    L.grid[i] = open ? 0 : 1;""",
"""    const i = gt.ty*L.W + gt.tx;
    L.grid[i] = open ? 0 : 1; ENG.setTile(gt.tx, gt.ty, open ? 0 : 1);""",
1, "решётки")
rep("        pk.st = 2; L.grid[pk.ty*L.W + pk.tx] = 0; L.chars[pk.ty*L.W + pk.tx] = '.';",
    "        pk.st = 2; L.grid[pk.ty*L.W + pk.tx] = 0; L.chars[pk.ty*L.W + pk.tx] = '.'; ENG.setTile(pk.tx, pk.ty, 0);",
    1, "мостики")
rep("          L.grid[o.ty*L.W+o.tx] = 0; L.chars[o.ty*L.W+o.tx] = '.';",
    "          L.grid[o.ty*L.W+o.tx] = 0; L.chars[o.ty*L.W+o.tx] = '.'; ENG.setTile(o.tx, o.ty, 0);",
    1, "замки")
rep("if (q.type === 'coin') { q.used = true; L.chars[ty*L.W+tx]='U'; L.grid[ty*L.W+tx]=1;",
    "if (q.type === 'coin') { q.used = true; L.chars[ty*L.W+tx]='U'; L.grid[ty*L.W+tx]=1; ENG.setTile(tx, ty, 1);",
    1, "блок ? монета")
rep("} else if (q.type === 'charm') { q.used = true; L.chars[ty*L.W+tx]='U'; L.grid[ty*L.W+tx]=1;",
    "} else if (q.type === 'charm') { q.used = true; L.chars[ty*L.W+tx]='U'; L.grid[ty*L.W+tx]=1; ENG.setTile(tx, ty, 1);",
    1, "блок ? талисман")
rep("if (P.big) { L.grid[ty*L.W+tx]=0; L.chars[ty*L.W+tx]='.'; L.q.delete(key);",
    "if (P.big) { L.grid[ty*L.W+tx]=0; L.chars[ty*L.W+tx]='.'; L.q.delete(key); ENG.setTile(tx, ty, 0);",
    1, "кирпич большой")

# ---------- E8. Циклы обновления частиц -> ENG.fxStep ----------
world_loop = """  // частицы (потолок 240 — спайк не выведет частоту за 60 FPS)
  if (L.parts.length > 240) L.parts.splice(0, L.parts.length - 240);
  for (let i=L.parts.length-1; i>=0; i--) { const p = L.parts[i]; p.t += dt;
    if (p.coinpop) { p.vy += 700*dt; p.y += p.vy*dt; }
    else { p.vy += (p.grav?900:200)*dt; p.x += p.vx*dt; p.y += p.vy*dt; }
    if (p.t > p.life) L.parts.splice(i,1); }"""
rep(world_loop, "  ENG.fxStep(dt);                       // частицы: C++/WASM bobfx (SoA-пул, ноль аллокаций)", 1, "цикл мира")
arena_loop = """  if (L.parts.length > 240) L.parts.splice(0, L.parts.length - 240);
  for (let i=L.parts.length-1; i>=0; i--) { const p = L.parts[i]; p.t += dt;
    p.vy += (p.grav ? 900 : 200)*dt; p.x += p.vx*dt; p.y += p.vy*dt;
    if (p.t > p.life) L.parts.splice(i,1); }"""
rep(arena_loop, "  ENG.fxStep(dt);                       // частицы: C++/WASM bobfx", 2, "циклы арены")

# ---------- E9. Рендер частиц -> typed-array виды движка ----------
rep("""  for (const p of L.parts) {
    if (p.x < camX-8 || p.x > camX+CFG.VW+8) continue;
    if (p.coinpop) { cv2.drawImage(SPR.coin0, p.x-camX, p.y); continue; }
    cv2.globalAlpha = 1 - p.t/p.life;
    cv2.fillStyle = p.col==='brick' ? pal.brick : p.col==='wood' ? '#8a6234' :
                    p.col==='spark' ? '#ffd800' :
                    p.col==='puff' ? 'rgba(255,255,255,.9)' : '#ff7a2a';
    cv2.fillRect(p.x-camX, p.y, p.s, p.s);
    cv2.globalAlpha = 1;
  }""",
"""  { // частицы из пула движка (bobfx): чтение прямо из памяти WASM
    const n = ENG.fxCount(), fxx = ENG.fxX(), fxy = ENG.fxY(), fxt = ENG.fxT(),
          fxl = ENG.fxLife(), fxs = ENG.fxS(), fxc = ENG.fxCol(), fxf = ENG.fxFlags();
    for (let i=0; i<n; i++) {
      const px = fxx[i]; if (px < camX-8 || px > camX+CFG.VW+8) continue;
      if (fxf[i] & 2) { cv2.drawImage(SPR.coin0, px-camX, fxy[i]); continue; }
      cv2.globalAlpha = 1 - fxt[i]/fxl[i];
      cv2.fillStyle = fxc[i]===2 ? pal.brick : fxc[i]===3 ? '#8a6234' :
                      fxc[i]===0 ? '#ffd800' :
                      fxc[i]===1 ? 'rgba(255,255,255,.9)' : '#ff7a2a';
      cv2.fillRect(px-camX, fxy[i], fxs[i], fxs[i]);
      cv2.globalAlpha = 1;
    }
  }""", 1, "рендер мира")
rep("""  for (const p of L.parts) {
    if (p.coinpop) { cv2.drawImage(SPR.coin0, p.x - camX, p.y); continue; }
    cv2.globalAlpha = 1 - p.t/p.life;
    cv2.fillStyle = p.col === 'spark' ? '#ffd800' : 'rgba(255,255,255,.9)';
    cv2.fillRect(p.x - camX, p.y, p.s, p.s);
    cv2.globalAlpha = 1;
  }""",
"""  { // частицы из пула движка (bobfx)
    const n = ENG.fxCount(), fxx = ENG.fxX(), fxy = ENG.fxY(), fxt = ENG.fxT(),
          fxl = ENG.fxLife(), fxs = ENG.fxS(), fxc = ENG.fxCol(), fxf = ENG.fxFlags();
    for (let i=0; i<n; i++) {
      if (fxf[i] & 2) { cv2.drawImage(SPR.coin0, fxx[i] - camX, fxy[i]); continue; }
      cv2.globalAlpha = 1 - fxt[i]/fxl[i];
      cv2.fillStyle = fxc[i] === 0 ? '#ffd800' : 'rgba(255,255,255,.9)';
      cv2.fillRect(fxx[i] - camX, fxy[i], fxs[i], fxs[i]);
      cv2.globalAlpha = 1;
    }
  }""", 1, "рендер арены")

# ---------- E10. Синхронизация камней в движок ----------
rep("""  updateBoxes(dt);                     // камни оседают до игрока (он в них упирается)
  updatePlayer(dt);""",
"""  updateBoxes(dt);                     // камни оседают до игрока (он в них упирается)
  ENG.syncBoxes(L.boxes);              // позиции камней — в движок (для solid-запросов)
  updatePlayer(dt);""", 1, "syncBoxes в updateWorld")
rep("""      const ty = Math.floor((b.y+b.h)/16);
      for (let tx=x0; tx<=x1; tx++) if (solidPx(tx*16+8, ty*16+8)) { b.y = ty*16 - b.h; b.vy = 0; break; }""",
"""      const ty = Math.floor((b.y+b.h)/16);
      ENG.syncBoxes(L.boxes);          // каждый запрос — по актуальным позициям всех камней
      for (let tx=x0; tx<=x1; tx++) if (solidPx(tx*16+8, ty*16+8)) { b.y = ty*16 - b.h; b.vy = 0; break; }""",
1, "syncBoxes в updateBoxes")
rep("""  if (blocked) { tb.x = oldX; return; }
  if (Math.floor(gTime * 2.5) !== tb.creakT)""",
"""  if (blocked) { tb.x = oldX; return; }
  ENG.syncBoxes(L.boxes);              // камень сдвинут Бобом — обновляем в движке
  if (Math.floor(gTime * 2.5) !== tb.creakT)""",
1, "syncBoxes при толкании")

# ---------- E11. Старт игры ждёт готовности движка ----------
rep("""requestAnimationFrame(frame);

/* ---------- ПОЛНЫЙ ЭКРАН""",
"""(function bootWhenEngReady() {         // первый кадр — после выбора движка (WASM или JS)
  const go = () => requestAnimationFrame(frame);
  (window.ENG && ENG.ready ? ENG.ready.then(go, go) : go());
})();

/* ---------- ПОЛНЫЙ ЭКРАН""",
1, "boot")

if fails:
    print("ПАТЧ ПРОВАЛЕН:"); [print(" -", f) for f in fails]; sys.exit(1)

write(HTML, html)
print(f"OK: index.html запатчен ({len(html)} байт)")
