/* ============================================================
   SUPER BOB — клей между игрой и движками (C++/WASM или JS).
   Игра общается только с window.ENG; реализации взаимозаменяемы
   и побайтово эквивалентны (проверяется tests/test_equiv.js).
   Порядок подключения: bob_twin.js (fallback) -> bob_engine.js
   (WASM, опционально) -> этот файл. Готовность: ENG.ready.
   ============================================================ */
'use strict';
(function (g) {
  const js = g.BobTwin();
  let impl = js;
  const ENG = {
    mode: 'js',
    ready: null,
    out: js.out,          // Int32Array: [0]hitWall [1]grounded [2]bumpTx [3]bumpTy [4]fxCount
    /* --- физика --- */
    init: () => impl.init(),
    setLevel: (w, h, grid) => impl.setLevel(w, h, grid),
    setTile: (tx, ty, v) => impl.setTile(tx, ty, v),
    solid: (px, py) => impl.solid(px, py),
    syncBoxes: (list) => impl.syncBoxes(list),
    moveX: (e, dt) => impl.moveX(e, dt),
    moveY: (e, dt) => impl.moveY(e, dt),
    /* --- частицы (bobfx) --- */
    fxClear: () => impl.fxClear(),
    fxSpawn: (x, y, vx, vy, life, s, col, flags) => impl.fxSpawn(x, y, vx, vy, life, s, col, flags),
    fxStep: (dt) => impl.fxStep(dt),
    fxCount: () => impl.fxCount(),
    fxX: () => impl.fxX(), fxY: () => impl.fxY(), fxT: () => impl.fxT(),
    fxLife: () => impl.fxLife(), fxS: () => impl.fxS(),
    fxCol: () => impl.fxCol(), fxFlags: () => impl.fxFlags()
  };

  let resolveReady;
  ENG.ready = new Promise(r => { resolveReady = r; });

  function adoptWasm(M) {
    const exports = M._eng_init ? M : M.moduleExports || M;
    const heapF64 = () => M.HEAPF64, heapU8 = () => M.HEAPU8;
    const gridPtr = exports._grid_base(), entPtr = exports._ent_base(),
          outPtr = exports._out_base(), boxPtr = exports._box_base();
    const fxP = {
      x: exports._fx_x_base(), y: exports._fx_y_base(), t: exports._fx_t_base(),
      life: exports._fx_life_base(), s: exports._fx_s_base()
    };
    const colP = exports._fx_col_base(), flgP = exports._fx_flags_base();
    const F64 = heapF64(), U8 = heapU8();
    const OUTW = new Int32Array(F64.buffer, outPtr, 8);
    const V = {
      x: F64.subarray(fxP.x >> 3, (fxP.x >> 3) + 240),
      y: F64.subarray(fxP.y >> 3, (fxP.y >> 3) + 240),
      t: F64.subarray(fxP.t >> 3, (fxP.t >> 3) + 240),
      life: F64.subarray(fxP.life >> 3, (fxP.life >> 3) + 240),
      s: F64.subarray(fxP.s >> 3, (fxP.s >> 3) + 240),
      col: U8.subarray(colP, colP + 240),
      flags: U8.subarray(flgP, flgP + 240)
    };
    const w = {
      kind: 'wasm',
      init: () => exports._eng_init(),
      setLevel(w_, h_, grid) {
        U8.set(grid.subarray(0, Math.min(grid.length, 512 * 256)), gridPtr);
        exports._eng_set_level(w_, h_);
      },
      setTile: (tx, ty, v) => exports._eng_set_tile(tx, ty, v),
      solid: (px, py) => exports._eng_solid(px, py) === 1,
      syncBoxes(list) {
        const n = Math.min(list.length, 256), base = boxPtr >> 3;
        const F = heapF64();
        for (let i = 0; i < n; i++) {
          const b = list[i], o = base + i * 4;
          F[o] = b.x; F[o + 1] = b.y; F[o + 2] = b.w; F[o + 3] = b.h;
        }
        exports._eng_sync_boxes(n);
      },
      moveX(e, dt) {
        const E = heapF64(), base = entPtr >> 3;
        E[base] = e.x; E[base + 1] = e.y; E[base + 2] = e.w; E[base + 3] = e.h; E[base + 4] = e.vx; E[base + 5] = e.vy;
        exports._eng_move_x(dt);
        e.x = E[base]; e.hitWall = OUTW[0];
      },
      moveY(e, dt) {
        const E = heapF64(), base = entPtr >> 3;
        E[base] = e.x; E[base + 1] = e.y; E[base + 2] = e.w; E[base + 3] = e.h; E[base + 4] = e.vx; E[base + 5] = e.vy;
        exports._eng_move_y(dt);
        e.y = E[base + 1]; e.vy = E[base + 5]; e.grounded = OUTW[1];
      },
      out: OUTW,
      fxClear: () => exports._fx_clear(),
      fxSpawn: (x, y, vx, vy, life, s, col, flags) => exports._fx_spawn(x, y, vx, vy, life, s, col, flags),
      fxStep: (dt) => exports._fx_step(dt),
      fxCount: () => exports._fx_count(),
      fxX: () => V.x, fxY: () => V.y, fxT: () => V.t,
      fxLife: () => V.life, fxS: () => V.s,
      fxCol: () => V.col, fxFlags: () => V.flags
    };
    return w;
  }

  function tryWasm() {
    return new Promise(res => {
      if (typeof g.BobEngWasm !== 'function') return res(false);
      let M;
      try { M = g.BobEngWasm(); } catch (e) { return res(false); }
      M.then(m => {
        try {
          const w = adoptWasm(m);
          w.init();
          impl = w; ENG.mode = 'wasm'; ENG.out = w.out;
          res(true);
        } catch (e) { res(false); }
      }, () => res(false));
    });
  }

  ENG.ready = tryWasm().then(ok => { if (!ok) impl.init(); resolveReady(ok ? 'wasm' : 'js'); return ENG.mode; });
  g.ENG = ENG;
})(typeof window !== 'undefined' ? window : globalThis);
