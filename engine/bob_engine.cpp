/* ============================================================
   SUPER BOB — КАСТОМНЫЕ C++ ДВИЖКИ ДЛЯ WASM (телефон/браузер)
   ------------------------------------------------------------
   bobphys — движок коллизий и физики:
     * сетка тайлов уровня в линейной памяти WASM (без GC),
     * толкаемые камни (boxes) — SoA-массив, синхронизируется из JS,
     * solid-запросы и проходы moveX/moveY — побайтово та же
       семантика, что в JS-версии игры (то же округление, те же
       0.01-отступы, тот же выбор тайла для бампа),
     * вся горячая арифметика — в double, как Number в JS.
   bobfx — движок частиц (Structure-of-Arrays, ноль аллокаций):
     * фиксированный пул на 240 частиц (как потолок L.parts),
     * спавн через экспорт, шаг — один вызов fx_step(dt),
     * рендер читает typed-array вид прямо из памяти WASM.
   Сборка: engine/build.sh (emcc -> engine/bob_engine.js, single-file)
   ============================================================ */
#include <stdint.h>
#include <math.h>
#include <string.h>

#define VERSION 1

/* ---------------- ПАМЯТЬ ДВИЖКА (статическая, без malloc) ---------------- */
#define MAX_GRID   (512u * 256u)          /* 128 КиБ — сетка уровня       */
#define MAX_BOXES  256                   /* толкаемые камни              */
#define MAX_PARTS  240                    /* потолок частиц, как в игре   */

static uint8_t  GRID[MAX_GRID];
static uint32_t GW = 0, GH = 0;                       /* размер уровня     */

/* scratch одной сущности: x y w h vx vy (JS пишет перед вызовом) */
static double ENT[6];
/* результаты: [0]=hitWall [1]=grounded [2]=bumpTx [3]=bumpTy [4]=fxCount [5]=boxCount */
static int32_t OUT[8];

static double   BOX[MAX_BOXES * 4];                   /* x y w h            */
static int32_t  BOXN = 0;

/* ---- bobfx: пул частиц, SoA ---- */
static double  PX_[MAX_PARTS], PY_[MAX_PARTS], PVX_[MAX_PARTS], PVY_[MAX_PARTS];
static double  PT_[MAX_PARTS], PLIFE_[MAX_PARTS], PSZ_[MAX_PARTS];
static uint8_t PCOL_[MAX_PARTS];    /* 0 spark 1 puff 2 brick 3 wood 4 fire 5 coin */
static uint8_t PFL_[MAX_PARTS];     /* бит0: grav, бит1: coinpop                   */
static int32_t PN = 0;

/* ---------------- bobphys: сетка ---------------- */
extern "C" {

void  eng_init(void) { GW = GH = 0; BOXN = 0; PN = 0; OUT[0]=OUT[1]=OUT[2]=OUT[3]=OUT[4]=OUT[5]=0; }

uint8_t* grid_base(void) { return GRID; }
double*  ent_base(void)  { return ENT;  }
int32_t* out_base(void)  { return OUT;  }
double*  box_base(void)  { return BOX;  }

/* JS копирует сетку в GRID, затем вызывает set_level */
void eng_set_level(uint32_t w, uint32_t h) {
  GW = w; GH = h;
  if (GW * GH > MAX_GRID) { GW = GH = 0; }
}

void eng_set_tile(uint32_t tx, uint32_t ty, uint32_t v) {
  if (tx < GW && ty < GH) GRID[ty * GW + tx] = (uint8_t)v;
}

/* JS записал n коробок в BOX (x,y,w,h), вызывает синхронизацию счётчика */
void eng_sync_boxes(int32_t n) { BOXN = (n > MAX_BOXES) ? MAX_BOXES : (n < 0 ? 0 : n); OUT[5] = BOXN; }

/* tileAt: тайл в пиксельной точке — как в игре */
static inline int tile_at(double px, double py) {
  int x = (int)floor(px / 16.0), y = (int)floor(py / 16.0);
  if (x < 0 || x >= (int)GW) return 1;      /* края уровня — стены */
  if (y < 0 || y >= (int)GH) return 0;
  return GRID[(uint32_t)y * GW + (uint32_t)x];
}

/* solidPx: сетка + толкаемые камни */
static inline int solid_at(double px, double py) {
  if (tile_at(px, py) == 1) return 1;
  for (int i = 0; i < BOXN; i++) {
    const double *b = &BOX[i * 4];
    if (px >= b[0] && px < b[0] + b[2] && py >= b[1] && py < b[1] + b[3]) return 1;
  }
  return 0;
}

int32_t eng_solid(double px, double py) { return solid_at(px, py); }

/* moveX: X-проход с коллизиями — семантика 1:1 с JS */
void eng_move_x(double dt) {
  double x = ENT[0] + ENT[4] * dt;           /* e.x += e.vx*dt */
  const double y = ENT[1], w = ENT[2], h = ENT[3], vx = ENT[4];
  int y0 = (int)floor((y + 1.0) / 16.0), y1 = (int)floor((y + h - 1.0) / 16.0);
  if (vx > 0.0) {
    int tx = (int)floor((x + w) / 16.0);
    for (int ty = y0; ty <= y1; ty++)
      if (solid_at(tx * 16.0 + 8.0, ty * 16.0 + 8.0)) {
        ENT[0] = tx * 16.0 - w - 0.01; OUT[0] = 1; return;
      }
  } else if (vx < 0.0) {
    int tx = (int)floor(x / 16.0);
    for (int ty = y0; ty <= y1; ty++)
      if (solid_at(tx * 16.0 + 8.0, ty * 16.0 + 8.0)) {
        ENT[0] = (tx + 1) * 16.0 + 0.01; OUT[0] = -1; return;
      }
  }
  ENT[0] = x; OUT[0] = 0;
}

/* moveY: Y-проход; бамп блока для игрока — семантика 1:1 с JS */
void eng_move_y(double dt) {
  double y = ENT[1] + ENT[5] * dt;           /* e.y += e.vy*dt */
  const double x = ENT[0], w = ENT[2], h = ENT[3], vy = ENT[5];
  OUT[1] = 0;                                 /* grounded = false */
  OUT[2] = -1; OUT[3] = -1;                   /* bumped = none    */
  int x0 = (int)floor((x + 1.0) / 16.0), x1 = (int)floor((x + w - 1.0) / 16.0);
  if (vy >= 0.0) {
    int ty = (int)floor((y + h) / 16.0);
    for (int tx = x0; tx <= x1; tx++)
      if (solid_at(tx * 16.0 + 8.0, ty * 16.0 + 8.0)) {
        ENT[1] = ty * 16.0 - h; ENT[5] = 0.0; OUT[1] = 1; return;
      }
  } else {
    int ty = (int)floor(y / 16.0);
    int bumped = -1; double best = 1e9;
    for (int tx = x0; tx <= x1; tx++)
      if (solid_at(tx * 16.0 + 8.0, ty * 16.0 + 8.0)) {
        double d = fabs((tx * 16.0 + 8.0) - (x + w / 2.0));
        if (d < best) { best = d; bumped = tx; }
      }
    if (bumped >= 0) {
      ENT[1] = (ty + 1) * 16.0 + 0.01; ENT[5] = 0.0;
      OUT[2] = bumped; OUT[3] = ty;
      return;
    }
  }
  ENT[1] = y; ENT[5] = vy;                    /* без столкновения — просто интеграция */
}

/* ---------------- bobfx: частицы ---------------- */

uint8_t* fx_col_base(void)   { return PCOL_; }
uint8_t* fx_flags_base(void) { return PFL_; }
double*  fx_x_base(void)     { return PX_;   }
double*  fx_y_base(void)     { return PY_;   }
double*  fx_t_base(void)     { return PT_;   }
double*  fx_life_base(void)  { return PLIFE_; }
double*  fx_s_base(void)     { return PSZ_;  }

void fx_clear(void) { PN = 0; }

void fx_spawn(double x, double y, double vx, double vy, double life, double s,
              int32_t col, int32_t flags) {
  int i;
  if (PN < MAX_PARTS) i = PN++;
  else i = 0;                       /* пул полон: заменяем слот 0 (в игре старые всё равно срезались) */
  PX_[i] = x; PY_[i] = y; PVX_[i] = vx; PVY_[i] = vy;
  PT_[i] = 0.0; PLIFE_[i] = life; PSZ_[i] = s;
  PCOL_[i] = (uint8_t)col; PFL_[i] = (uint8_t)flags;
}

int32_t fx_step(double dt) {
  int i = 0;
  while (i < PN) {
    PT_[i] += dt;                                   /* p.t += dt   */
    if (PFL_[i] & 2) {                              /* coinpop     */
      PVY_[i] += 700.0 * dt; PY_[i] += PVY_[i] * dt;
    } else {
      PVY_[i] += ((PFL_[i] & 1) ? 900.0 : 200.0) * dt;
      PX_[i] += PVX_[i] * dt; PY_[i] += PVY_[i] * dt;
    }
    if (PT_[i] > PLIFE_[i]) {                       /* смерть: swap-remove */
      int last = --PN;
      if (i != last) {
        PX_[i] = PX_[last]; PY_[i] = PY_[last]; PVX_[i] = PVX_[last]; PVY_[i] = PVY_[last];
        PT_[i] = PT_[last]; PLIFE_[i] = PLIFE_[last]; PSZ_[i] = PSZ_[last];
        PCOL_[i] = PCOL_[last]; PFL_[i] = PFL_[last];
      }
      /* i не двигаем: обработаем переставленную частицу */
    } else i++;
  }
  OUT[4] = PN;
  return PN;
}

int32_t fx_count(void) { return PN; }

} /* extern "C" */
