/* ============================================================
   ТЕСТ: эквивалентность WASM-движка и JS-двойника + бенчмарк.
   Запуск:  node tests/test_equiv.js
   Сценарий детерминирован (mulberry32): случайный уровень,
   случайные сущности и частицы; состояния сравниваются побитово.
   ============================================================ */
'use strict';
const path = require('path');
/* страховка: если среда зависла на инстанциации WASM — выходим с кодом 3 */
setTimeout(() => { console.error('ЗАВИСАНИЕ теста (>60 с) — прерывание'); process.exit(3); }, 60000).unref();
const g = globalThis;
require(path.join(__dirname, '..', 'engine', 'bob_twin.js'));
const BobEngWasm = require(path.join(__dirname, '..', 'engine', 'bob_engine.js'));

/* ---------- детерминированный RNG ---------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 96, H = 40;
function buildScenario() {
  const rng = mulberry32(20261113);
  const grid = new Uint8Array(W * H);
  for (let i = 0; i < grid.length; i++) {
    const r = rng();
    grid[i] = r < 0.30 ? 1 : r < 0.34 ? 2 : r < 0.38 ? 3 : r < 0.40 ? 4 : 0;
  }
  for (let x = 0; x < W; x++) grid[(H - 1) * W + x] = 1;      // пол
  const boxes = [];
  for (let i = 0; i < 12; i++) boxes.push({ x: ((rng() * (W - 2) | 0) + 1) * 16, y: ((rng() * (H - 4) | 0) + 1) * 16, w: 16, h: 16 });
  const ents = [];
  for (let i = 0; i < 40; i++) ents.push({ x: rng() * W * 16, y: rng() * (H - 2) * 16, w: 10 + (rng() * 8 | 0), h: 12 + (rng() * 8 | 0), vx: 0, vy: 0, grounded: false, hitWall: 0 });
  return { rng, grid, boxes, ents };
}

function runScenario(ENG, snapEvery) {
  const { rng, grid, boxes, ents } = buildScenario();
  ENG.init(); ENG.setLevel(W, H, grid); ENG.syncBoxes(boxes); ENG.fxClear();
  const dt = 1 / 60;
  const snap = [];
  for (let step = 0; step < 2000; step++) {
    for (const e of ents) {
      e.vx = (rng() - 0.5) * 220; e.vy = (rng() - 0.5) * 280;
      ENG.moveX(e, dt);
      ENG.moveY(e, dt);
    }
    for (let k = 0; k < 3; k++)
      ENG.fxSpawn(rng() * 800, rng() * 400, (rng() - .5) * 120, -40 - rng() * 60, 0.2 + rng() * 0.5, 2 + (rng() * 3 | 0), (rng() * 6) | 0, rng() < 0.3 ? 1 : 0);
    ENG.fxStep(dt);
    if (step % snapEvery === 0) {
      snap.push([
        ...ents.map(e => e.x), ...ents.map(e => e.y),
        ...ents.map(e => e.vy), ...ents.map(e => e.grounded ? 1 : 0), ...ents.map(e => e.hitWall),
        ENG.fxCount()
      ]);
    }
  }
  /* полные состояния пулов и solid-пробы */
  const pool = { n: ENG.fxCount(), x: [...Array(ENG.fxCount())].map((_, i) => ENG.fxX()[i]), y: [...Array(ENG.fxCount())].map((_, i) => ENG.fxY()[i]), t: [...Array(ENG.fxCount())].map((_, i) => ENG.fxT()[i]), life: [...Array(ENG.fxCount())].map((_, i) => ENG.fxLife()[i]), s: [...Array(ENG.fxCount())].map((_, i) => ENG.fxS()[i]), col: [...Array(ENG.fxCount())].map((_, i) => ENG.fxCol()[i]), fl: [...Array(ENG.fxCount())].map((_, i) => ENG.fxFlags()[i]) };
  const rng2 = mulberry32(777);
  const probes = [];
  for (let i = 0; i < 500; i++) probes.push(ENG.solid(rng2() * W * 16, rng2() * H * 16) ? 1 : 0);
  const entsFinal = ents.map(e => [e.x, e.y, e.vx, e.vy, e.grounded ? 1 : 0, e.hitWall]);
  return { snap, pool, probes, entsFinal };
}

function same(a, b, what, log) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) { log.push(`РАСХОЖДЕНИЕ в ${what}: wasm=${sa.slice(0, 300)} js=${sb.slice(0, 300)}`); return false; }
  return true;
}

(async function main() {
  const log = [];
  const M = await BobEngWasm();
  const wasm = g.BobTwin && null; /* placeholder, impl below */
  /* --- wasm impl через минимальную обёртку того же контракта --- */
  const E = M._eng_init ? M : M;
  const heapF = () => M.HEAPF64, heapU = () => M.HEAPU8;
  const gridPtr = E._grid_base(), entPtr = E._ent_base(), outPtr = E._out_base(), boxPtr = E._box_base();
  const OUTW = new Int32Array(M.HEAPF64.buffer, outPtr, 8);
  const wasmImpl = {
    init: () => E._eng_init(),
    setLevel(w_, h_, grid) { M.HEAPU8.set(grid, gridPtr); E._eng_set_level(w_, h_); },
    syncBoxes(list) { const F = M.HEAPF64, base = boxPtr >> 3; for (let i = 0; i < list.length; i++) { const b = list[i], o = base + i * 4; F[o] = b.x; F[o + 1] = b.y; F[o + 2] = b.w; F[o + 3] = b.h; } E._eng_sync_boxes(list.length); },
    moveX(e, dt) { const F = M.HEAPF64, b = entPtr >> 3; F[b] = e.x; F[b + 1] = e.y; F[b + 2] = e.w; F[b + 3] = e.h; F[b + 4] = e.vx; F[b + 5] = e.vy; E._eng_move_x(dt); e.x = F[b]; e.hitWall = OUTW[0]; },
    moveY(e, dt) { const F = M.HEAPF64, b = entPtr >> 3; F[b] = e.x; F[b + 1] = e.y; F[b + 2] = e.w; F[b + 3] = e.h; F[b + 4] = e.vx; F[b + 5] = e.vy; E._eng_move_y(dt); e.y = F[b + 1]; e.vy = F[b + 5]; e.grounded = OUTW[1]; },
    solid: (px, py) => E._eng_solid(px, py) === 1,
    fxClear: () => E._fx_clear(),
    fxSpawn: (...a) => E._fx_spawn(...a),
    fxStep: (dt) => E._fx_step(dt),
    fxCount: () => E._fx_count(),
    fxX: () => { const p = E._fx_x_base(); return M.HEAPF64.subarray(p >> 3, (p >> 3) + 240); },
    fxY: () => { const p = E._fx_y_base(); return M.HEAPF64.subarray(p >> 3, (p >> 3) + 240); },
    fxT: () => { const p = E._fx_t_base(); return M.HEAPF64.subarray(p >> 3, (p >> 3) + 240); },
    fxLife: () => { const p = E._fx_life_base(); return M.HEAPF64.subarray(p >> 3, (p >> 3) + 240); },
    fxS: () => { const p = E._fx_s_base(); return M.HEAPF64.subarray(p >> 3, (p >> 3) + 240); },
    fxCol: () => { const p = E._fx_col_base(); return M.HEAPU8.subarray(p, p + 240); },
    fxFlags: () => { const p = E._fx_flags_base(); return M.HEAPU8.subarray(p, p + 240); }
  };
  const twin = g.BobTwin();

  const rw = runScenario(wasmImpl, 100);
  const rj = runScenario(twin, 100);

  let ok = true;
  ok &= same(rw.snap, rj.snap, 'траектории 2000 шагов', log);
  ok &= same(rw.pool, rj.pool, 'пул частиц', log);
  ok &= same(rw.probes, rj.probes, 'solid-пробы', log);
  ok &= same(rw.entsFinal, rj.entsFinal, 'финальные состояния сущностей', log);

  /* ---------- бенчмарк ---------- */
  function bench(impl, label) {
    const { rng, grid, boxes, ents } = buildScenario();
    impl.init(); impl.setLevel(W, H, grid); impl.syncBoxes(boxes);
    const dt = 1 / 60;
    let t0 = process.hrtime.bigint();
    for (let s = 0; s < 200; s++)
      for (const e of ents) { e.vx = (rng() - .5) * 220; e.vy = (rng() - .5) * 280; impl.moveX(e, dt); impl.moveY(e, dt); }
    const tMove = Number(process.hrtime.bigint() - t0) / 1e6;
    impl.fxClear();
    t0 = process.hrtime.bigint();
    for (let s = 0; s < 1000; s++) {
      for (let k = 0; k < 30; k++) impl.fxSpawn(s * 30 + k, 100, 50, -60, 0.4, 3, 0, 1);
      impl.fxStep(dt);
    }
    const tFx = Number(process.hrtime.bigint() - t0) / 1e6;
    return { label, tMove, tFx, moveMs: tMove / (200 * ents.length), fxMs: tFx / 1000 };
  }
  const bw = bench(wasmImpl, 'WASM (C++)');
  const bj = bench(twin, 'JS-двойник');

  console.log('=== ЭКВИВАЛЕНТНОСТЬ ===');
  console.log(ok ? 'OK: WASM и JS-двойник побитово совпадают по всем сценариям' : 'ПРОВАЛ:\n' + log.join('\n'));
  console.log('=== БЕНЧМАРК (Node x64, 200*40 ходов + 30k частиц) ===');
  for (const b of [bw, bj])
    console.log(`${b.label.padEnd(12)} moveX+moveY: ${b.tMove.toFixed(1)} мс (${(b.moveMs * 1e3).toFixed(2)} мкс/ход) | частицы: ${b.tFx.toFixed(1)} мс (${b.fxMs.toFixed(3)} мс/кадр)`);
  console.log(`Ускорение WASM/JS: физика x${(bj.tMove / bw.tMove).toFixed(2)}, частицы x${(bj.tFx / bw.tFx).toFixed(2)}`);
  process.exit(ok ? 0 : 1);
})();
