/* ============================================================
   SUPER BOB — JS-двойник C++ движков (bobphys + bobfx).
   Побайтово та же семантика, что в engine/bob_engine.cpp:
   тот же layout памяти, те же формулы, то же округление.
   Используется как fallback, если WebAssembly недоступен,
   и как эталон в тестах эквивалентности (tests/).
   ============================================================ */
'use strict';
(function (g) {
  const MAX_GRID = 512 * 256, MAX_BOXES = 256, MAX_PARTS = 240;

  g.BobTwin = function () {
    const GRID = new Uint8Array(MAX_GRID);
    let GW = 0, GH = 0;
    const ENT = new Float64Array(6);            // x y w h vx vy
    const OUT = new Int32Array(8);              // [0]hitWall [1]grounded [2]bumpTx [3]bumpTy [4]fxCount [5]boxCount
    const BOX = new Float64Array(MAX_BOXES * 4);
    let BOXN = 0;
    const PX = new Float64Array(MAX_PARTS), PY = new Float64Array(MAX_PARTS),
          PVX = new Float64Array(MAX_PARTS), PVY = new Float64Array(MAX_PARTS),
          PT = new Float64Array(MAX_PARTS), PLIFE = new Float64Array(MAX_PARTS),
          PSZ = new Float64Array(MAX_PARTS);
    const PCOL = new Uint8Array(MAX_PARTS), PFL = new Uint8Array(MAX_PARTS);
    let PN = 0;

    function tileAt(px, py) {
      const x = Math.floor(px / 16), y = Math.floor(py / 16);
      if (x < 0 || x >= GW) return 1;
      if (y < 0 || y >= GH) return 0;
      return GRID[y * GW + x];
    }
    function solidAt(px, py) {
      if (tileAt(px, py) === 1) return true;
      for (let i = 0; i < BOXN; i++) {
        const o = i * 4;
        if (px >= BOX[o] && px < BOX[o] + BOX[o + 2] && py >= BOX[o + 1] && py < BOX[o + 1] + BOX[o + 3]) return true;
      }
      return false;
    }
    return {
      kind: 'js',
      ready: Promise.resolve(),
      init() { GW = GH = 0; BOXN = 0; PN = 0; OUT.fill(0); },
      setLevel(w, h, gridU8) { GRID.set(gridU8.subarray(0, Math.min(gridU8.length, MAX_GRID))); GW = w; GH = h; },
      setTile(tx, ty, v) { if (tx >= 0 && tx < GW && ty >= 0 && ty < GH) GRID[ty * GW + tx] = v; },
      solid(px, py) { return solidAt(px, py); },
      syncBoxes(list) {
        const n = Math.min(list.length, MAX_BOXES);
        for (let i = 0; i < n; i++) { const b = list[i], o = i * 4; BOX[o] = b.x; BOX[o + 1] = b.y; BOX[o + 2] = b.w; BOX[o + 3] = b.h; }
        BOXN = n; OUT[5] = n;
      },
      moveX(e, dt) {
        ENT[0] = e.x; ENT[1] = e.y; ENT[2] = e.w; ENT[3] = e.h; ENT[4] = e.vx; ENT[5] = e.vy;
        const x = ENT[0] + ENT[4] * dt, y = ENT[1], w = ENT[2], h = ENT[3], vx = ENT[4];
        const y0 = Math.floor((y + 1) / 16), y1 = Math.floor((y + h - 1) / 16);
        if (vx > 0) {
          const tx = Math.floor((x + w) / 16);
          for (let ty = y0; ty <= y1; ty++)
            if (solidAt(tx * 16 + 8, ty * 16 + 8)) { ENT[0] = tx * 16 - w - 0.01; OUT[0] = 1; e.x = ENT[0]; e.hitWall = 1; return; }
        } else if (vx < 0) {
          const tx = Math.floor(x / 16);
          for (let ty = y0; ty <= y1; ty++)
            if (solidAt(tx * 16 + 8, ty * 16 + 8)) { ENT[0] = (tx + 1) * 16 + 0.01; OUT[0] = -1; e.x = ENT[0]; e.hitWall = -1; return; }
        }
        ENT[0] = x; OUT[0] = 0; e.x = ENT[0]; e.hitWall = 0;
      },
      moveY(e, dt) {
        ENT[0] = e.x; ENT[1] = e.y; ENT[2] = e.w; ENT[3] = e.h; ENT[4] = e.vx; ENT[5] = e.vy;
        const y = ENT[1] + ENT[5] * dt, x = ENT[0], w = ENT[2], h = ENT[3], vy = ENT[5];
        OUT[1] = 0; OUT[2] = -1; OUT[3] = -1;
        const x0 = Math.floor((x + 1) / 16), x1 = Math.floor((x + w - 1) / 16);
        if (vy >= 0) {
          const ty = Math.floor((y + h) / 16);
          for (let tx = x0; tx <= x1; tx++)
            if (solidAt(tx * 16 + 8, ty * 16 + 8)) { ENT[1] = ty * 16 - h; ENT[5] = 0; OUT[1] = 1; break; }
        } else {
          const ty = Math.floor(y / 16);
          let bumped = -1, best = 1e9;
          for (let tx = x0; tx <= x1; tx++)
            if (solidAt(tx * 16 + 8, ty * 16 + 8)) {
              const d = Math.abs((tx * 16 + 8) - (x + w / 2));
              if (d < best) { best = d; bumped = tx; }
            }
          if (bumped >= 0) { ENT[1] = (ty + 1) * 16 + 0.01; ENT[5] = 0; OUT[2] = bumped; OUT[3] = ty; }
        }
        if (OUT[2] < 0 && OUT[1] === 0) { ENT[1] = y; ENT[5] = vy; }
        e.y = ENT[1]; e.vy = ENT[5];
        e.grounded = OUT[1];
      },
      out: OUT,
      fxClear() { PN = 0; },
      fxSpawn(x, y, vx, vy, life, s, col, flags) {
        let i;
        if (PN < MAX_PARTS) i = PN++;
        else i = 0;
        PX[i] = x; PY[i] = y; PVX[i] = vx; PVY[i] = vy;
        PT[i] = 0; PLIFE[i] = life; PSZ[i] = s;
        PCOL[i] = col; PFL[i] = flags;
      },
      fxStep(dt) {
        let i = 0;
        while (i < PN) {
          PT[i] += dt;
          if (PFL[i] & 2) { PVY[i] += 700 * dt; PY[i] += PVY[i] * dt; }
          else { PVY[i] += ((PFL[i] & 1) ? 900 : 200) * dt; PX[i] += PVX[i] * dt; PY[i] += PVY[i] * dt; }
          if (PT[i] > PLIFE[i]) {
            const last = --PN;
            if (i !== last) {
              PX[i] = PX[last]; PY[i] = PY[last]; PVX[i] = PVX[last]; PVY[i] = PVY[last];
              PT[i] = PT[last]; PLIFE[i] = PLIFE[last]; PSZ[i] = PSZ[last];
              PCOL[i] = PCOL[last]; PFL[i] = PFL[last];
            }
          } else i++;
        }
        OUT[4] = PN;
        return PN;
      },
      fxCount() { return PN; },
      fxX() { return PX; }, fxY() { return PY; }, fxT() { return PT; },
      fxLife() { return PLIFE; }, fxS() { return PSZ; },
      fxCol() { return PCOL; }, fxFlags() { return PFL; }
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
