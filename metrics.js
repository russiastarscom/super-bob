/* ============================================================
   SUPER BOB — ТЕЛЕМЕТРИЯ ИГРОКОВ (metrics.js)
   Подробная система метрик для админ-панели (admin.html):
     • ГДЕ игрок остановился   — снапшот состояния каждые 10 с
       (экран, уровень, мир, позиция в уровне %, печати, счёт,
        монеты, жизни, волна арены, кооп-комната);
     • КОГДА ушёл            — момент завершения сессии и причина
       (закрыл вкладку / ушёл из вкладки / бездействовал / обрыв);
     • ВЕРНУЛСЯ ли           — каждый вход помечается «возврат»
       с временем с прошлого визита и номером сессии игрока.
   КАК ПОДКЛЮЧЕНА (index.html НЕ меняется!)
     supabase-config.js в самом конце добавляет на страницу тег
     <script src="metrics.js"> — телеметрия грузится параллельно
     игре. Все события снимаются ПОЛЛИНГОМ живых объектов игры
     через window.__G (отладочный экспорт index.html) раз в секунду
     плюс обёртками открытых методов (Bank.buy*, Prog.record).
   КАК РАБОТАЕТ
     1) Всё складывается в localStorage (история и очередь) —
        админ-панель видит данные даже без интернета (режим «Локально»).
     2) Каждые 30 с (и в момент ухода — fetch keepalive) данные
        летят в Supabase: таблицы player_sessions / player_events
        (схема — supabase-schema.sql). Таблиц нет — игра продолжает
        работать, всё копится локально (та же философия, что у коопа).
   АНОНИМНОСТЬ: ни логинов, ни паролей — только случайный ID
   игрока (bob5_pid), который живёт в localStorage устройства.
   ПАНЕЛЬ АДМИНА: admin.html отдельным файлом и ПОД ПАРОЛЕМ,
   открывается только по прямой ссылке (…/admin.html). Кнопки «АДМИН»
   внутри игры больше нет — игроки панель вообще не видят. Сама панель
   метрики не пишет (admin.html отфильтровывается в начале файла).
   ============================================================ */
window.Metrics = (function () {
  'use strict';

  /* админ-панель (admin.html) метрики не пишет: она не игрок */
  try { if (/(^|\/)admin\.html$/i.test(location.pathname)) return null; } catch (e) {}

  /* ---------- КОНФИГУРАЦИЯ (все числа — только здесь) ---------- */
  const VER       = 1;             // версия формата (для будущих миграций)
  const HEARTBEAT = 10;            // снапшот состояния каждые 10 с
  const FLUSH     = 30;            // выгрузка в Supabase каждые 30 с
  const POLL      = 1;             // частота отлова игровых событий, с
  const IDLE_MS   = 5 * 60000;     // 5 мин без действий → игрок «ушёл» (idle)
  const HIDE_MS   = 2 * 60000;     // вкладка скрыта > 2 мин → сессия завершена
  const CAP_EV    = 800;           // лимит очереди событий (антипереполнение)
  const CAP_HIST  = 400;           // лимит локальной истории сессий
  const CAP_LEV   = 3000;          // лимит локального журнала событий
  const RETRY_MS  = 5 * 60000;     // при ошибке базы повтор через 5 мин
  const ARN_LS    = 'bob5_arena_best';   // ключ рекорда арены (как в игре)

  /* ---------- КЛЮЧИ localStorage ---------- */
  const K_PID  = 'bob5_pid';       // постоянный ID игрока
  const K_N    = 'bob5_m_n';       // номер текущей сессии игрока (1, 2, 3…)
  const K_SESS = 'bob5_m_sess';    // ТЕКУЩАЯ сессия (живой снапшот для админки)
  const K_HIST = 'bob5_m_hist';    // завершённые сессии (локальная история)
  const K_Q    = 'bob5_m_q';       // очередь событий, ждущих выгрузки
  const K_LEV  = 'bob5_m_evt';     // локальный журнал событий (для админки)

  /* ---------- УТИЛИТЫ ---------- */
  const now = () => Date.now();
  const iso = t => new Date(t || now()).toISOString();
  function lsGet(k, def) { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : def; } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function uuid() {                    // ID сессии: uuid4 или псевдослучайный запасной
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    let s = ''; for (let i = 0; i < 36; i++)
      s += i === 8 || i === 13 || i === 18 || i === 23 ? '-' :
           (Math.floor(Math.random() * 16) + (i === 14 ? 0x40 : 0x30)).toString(16);
    return s;
  }
  function shortUA() {                 // краткая подпись устройства (для админки)
    try { return String(navigator.userAgent).slice(0, 110); } catch (e) { return ''; }
  }

  /* ---------- ИГРОК ---------- */
  function makePid() {                 // 24 hex-символа: анонимно, но стабильно
    let s = '';
    try { const a = new Uint8Array(12); crypto.getRandomValues(a);
      for (const b of a) s += b.toString(16).padStart(2, '0'); } catch (e) { s = ''; }
    if (s.length < 24) for (let i = s.length; i < 24; i++)
      s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }
  const PID = (function () { let p = null; try { p = localStorage.getItem(K_PID); } catch (e) {}
    if (!p || !/^[0-9a-f]{24}$/.test(p)) { p = makePid(); try { localStorage.setItem(K_PID, p); } catch (e) {} }
    return p; })();

  /* ---------- СЕТЬ: тот же проект Supabase, что и у кооп-режима ----------
     Прямой REST (PostgREST) без supabase-js: телеметрии нужен только
     fetch, лишний CDN не грузим. Ошибки глушатся — игра не страдает. */
  function cfg() { try { return window.SUPABASE_CFG || {}; } catch (e) { return {}; } }
  function netOk() { const c = cfg(); return !!(c.url && c.key); }
  function dbBase() { const c = cfg(); return (c.dburl || c.url).replace(/\/+$/, '') + '/rest/v1/'; }
  function dbHeaders(upsert) {
    const c = cfg(); const h = { apikey: c.key, Authorization: 'Bearer ' + c.key,
      'Content-Type': 'application/json', Prefer: 'return=minimal' };
    if (upsert) h.Prefer = 'resolution=merge-duplicates,return=minimal';
    return h;
  }
  let dbOk = null;                     // null — ещё не проверяли, true/false — ответ базы
  let retryAt = 0;                     // когда можно снова пробовать после ошибки

  /* строка сессии → колонки таблицы player_sessions */
  function sessRow(s) {
    const p = s.snap || {};
    return { id: s.id, pid: s.pid, n: s.n | 0, is_return: !!s.is_return,
      since_prev_s: s.since_prev_s == null ? null : s.since_prev_s | 0,
      started_at: s.started_at, ended_at: s.ended_at || null,
      duration_s: s.duration_s == null ? null : s.duration_s | 0,
      exit_reason: s.exit_reason || null,
      state: p.state || null, level_idx: p.level_idx == null ? null : p.level_idx | 0,
      level_name: p.level_name || null, world: p.world == null ? null : p.world | 0,
      pos_pct: p.pos_pct == null ? null : p.pos_pct | 0,
      score: p.score | 0, coins: p.coins | 0, lives: p.lives == null ? null : p.lives | 0,
      seals: p.seals || null, wave: p.wave == null ? null : p.wave | 0,
      deaths: p.deaths | 0, time_left: p.time_left == null ? null : p.time_left | 0,
      ua: s.ua || null, ver: VER };
  }
  /* строка события → колонки таблицы player_events */
  function evRow(e) {
    return { pid: e.pid, sid: e.sid, kind: e.kind,
      payload: e.p || {}, created_at: e.t };
  }

  /* ---------- ОЧЕРЕДИ И ЛОКАЛЬНАЯ ИСТОРИЯ ---------- */
  let q = lsGet(K_Q, []);              // события в ожидании выгрузки
  let lev = lsGet(K_LEV, []);          // локальный журнал (админ-панель без сети)
  let hist = lsGet(K_HIST, []);        // локальная история завершённых сессий
  function pushLev(e) { lev.push({ t: e.t, pid: e.pid, sid: e.sid, kind: e.kind, p: e.p });
    if (lev.length > CAP_LEV) lev = lev.slice(-CAP_LEV); lsSet(K_LEV, lev); }

  /* ---------- СЕССИЯ ---------- */
  let sess = null;                     // текущая сессия
  let t0 = 0;                          // ms начала сессии
  let lastAct = 0;                     // ms последнего действия игрока
  let hiddenAt = 0;                    // ms, когда вкладку скрыли
  let ended = false;                   // сессия текущей вкладки уже завершена

  /* СНИМОК «ГДЕ ИГРОК СЕЙЧАС»: читает живые объекты игры через
     window.__G (отладочный экспорт index.html). Ничего не ломает,
     если игра ещё не готова — просто вернёт частичный снапшот. */
  const WORLD_RU = ['Оплаканные Холмы', 'Эхо-Катакомбы', 'Парящие Острова',
                    'Пепловый Вулкан', 'Цитадель Культа', 'Сердце Разлома'];
  function snap() {
    const s = {};
    try {
      const g = window.__G; if (!g) return s;
      const G = g.G; if (!G) return s;
      s.state  = String(G.state || '');
      s.level_idx = G.level | 0;
      s.score  = G.score | 0;
      s.coins  = G.coins | 0;
      s.lives  = G.lives | 0;
      s.seals  = (G.seals || []).map(b => b ? 1 : 0).join('');
      s.deaths = G.lvlDeaths | 0;
      if (typeof G.timeLeft === 'number') s.time_left = Math.max(0, Math.round(G.timeLeft));
      const L = (typeof g.getL === 'function') ? g.getL() : null;
      if (L) {
        s.level_name = L.name || '';
        if (!s.level_name && s.state === 'arena') s.level_name = 'АРЕНА';
        try { const P = g.P;
          if (P && L.W) s.pos_pct = Math.max(0, Math.min(100,
            Math.round(P.x / (L.W * 16) * 100))); } catch (e) {}
      }
      s.world = Math.min(6, Math.floor(s.level_idx / 10) + 1);
      s.world_ru = WORLD_RU[s.world - 1] || '';
      if (s.state === 'arena' && g.ARN) { s.wave = g.ARN.wave | 0; s.score = g.ARN.score | 0; }
      const N = g.NET;
      if (N) { s.net_on = !!N.on; s.net_mode = N.mode || '';
               s.net_code = N.on && N.code ? String(N.code) : ''; }
    } catch (e) {}
    return s;
  }
  /* человеческая строка «где остановился» — для события session_end */
  function whereStr(p) {
    if (!p || !p.state) return '';
    let w = { title: 'В меню', intro: 'Интро истории', select: 'Выбор уровня',
      shop: 'Магазин', about: 'О игре', pause: 'Пауза', play: 'Уровень ' + ((p.level_idx | 0) + 1),
      clear: 'Уровень ' + ((p.level_idx | 0) + 1) + ' пройден', over: 'Игра окончена',
      arenaMenu: 'Лобби арены', arena: 'Арена, волна ' + (p.wave || 1),
      results: 'Итоги', final: 'Финал игры', awaken: 'Сюжет: Пробуждение',
      gameover: 'Игра окончена' }[p.state] || p.state;
    if (p.net_on) w += ' [кооп ' + (p.net_mode === 'host' ? 'хост' : 'гость') +
      (p.net_code ? ' ' + p.net_code : '') + ']';
    return w;
  }

  /* ---------- СОБЫТИЯ ---------- */
  function ev(kind, p) {
    const e = { t: iso(), pid: PID, sid: sess ? sess.id : null, kind, p: p || {} };
    pushLev(e);
    q.push(e);
    if (q.length > CAP_EV) q = q.slice(-CAP_EV);
    lsSet(K_Q, q);
  }
  function startSession() {
    ended = false; t0 = now(); lastAct = t0; hiddenAt = 0;
    const prev = hist.length ? hist[hist.length - 1] : null;   // последняя завершённая
    const isReturn = !!prev;
    const n = (function () { let k = lsGet(K_N, 0) + 1; lsSet(K_N, k); return k; })();
    sess = { id: uuid(), pid: PID, n, is_return: isReturn,
      since_prev_s: prev ? Math.max(0, Math.round((t0 - new Date(prev.ended_at || prev.started_at).getTime()) / 1000)) : null,
      started_at: iso(t0), ended_at: null, duration_s: null,
      exit_reason: null, snap: snap(), ua: shortUA() };
    lsSet(K_SESS, sess);
    ev('session_start', { n, is_return: isReturn, since_prev_s: sess.since_prev_s,
      where: whereStr(sess.snap) });
    flushSoon();
  }
  /* ЗАВЕРШЕНИЕ: причина — 'close' (вкладка закрыта), 'tab_hidden' (ушёл из
     вкладки надолго), 'idle' (бездействовал) — или остаётся без причины
     при жёстком обрыве (в админке это видно как «не завершилась»). */
  function finalize(reason) {
    if (!sess || sess.ended_at) return;
    sess.ended_at = iso();
    sess.duration_s = Math.max(1, Math.round((now() - t0) / 1000));
    sess.exit_reason = reason || null;
    sess.snap = snap();
    ended = true;
    hist.push(sess);
    if (hist.length > CAP_HIST) hist = hist.slice(-CAP_HIST);
    lsSet(K_HIST, hist); lsSet(K_SESS, sess);
    ev('session_end', { reason: sess.exit_reason, dur: sess.duration_s,
      where: whereStr(sess.snap), level: sess.snap.level_idx, state: sess.snap.state });
    flushNow(true);                       // последняя выгрузка — keepalive
  }
  /* возобновление после finalize (вернулся из скрытой вкладки / ожил) */
  function resume() { startSession(); }

  /* ---------- ВЫГРУЗКА В SUPABASE ---------- */
  let flushT = 0;
  function flushSoon() { if (!flushT) flushT = setTimeout(() => { flushT = 0; flushNow(false); }, 5000); }
  function flushNow(keepalive) {
    if (!netOk() || !sess) return;
    if (dbOk === false && now() < retryAt) return;        // база недоступна — ждём
    const c = cfg();
    try {
      const base = dbBase();
      /* 1) сессия — upsert по PK id (снапшоты обновляют ended_at и «где остановился») */
      fetch(base + 'player_sessions?on_conflict=id', { method: 'POST', keepalive: !!keepalive,
        headers: dbHeaders(true), body: JSON.stringify([sessRow(sess)]) })
        .then(r => { if (r.status === 404) { dbOk = false; retryAt = now() + RETRY_MS; }
                     else if (r.ok || r.status === 409) dbOk = true; })
        .catch(() => {});
      /* 2) события — пачкой; после успеха вычёркиваем из очереди */
      if (q.length) {
        const batch = q.slice(0, 200).map(evRow);
        fetch(base + 'player_events', { method: 'POST', keepalive: !!keepalive,
          headers: dbHeaders(false), body: JSON.stringify(batch) })
          .then(r => {
            if (r.status === 404) { dbOk = false; retryAt = now() + RETRY_MS; return; }
            if (r.ok || r.status === 409) { dbOk = true; q = q.slice(batch.length); lsSet(K_Q, q); }
          })
          .catch(() => {});
      }
    } catch (e) {}
  }

  /* ============================================================
     ПОЛЛИНГ ИГРОВЫХ СОБЫТИЙ: раз в секунду сравниваем живое
     состояние игры с предыдущим — все факты становятся событиями.
     Игра остаётся нетронутой: read-only + обёртки методов объектов.
     ============================================================ */
  const pv = { st: '', lv: -1, lives: -1, seals: '', arnOver: false, net: '' };

  function pollGame() {
    try {
      const g = window.__G; if (!g) return;
      const G = g.G; if (!G) return;
      /* смена экрана */
      const st = String(G.state || '');
      if (st !== pv.st) {
        ev('state', { from: pv.st, to: st, where: whereStr(snap()) });
        if (st === 'play') ev('level_start', { level: (G.level | 0) + 1, name: (snap().level_name || '') });
        if (st === 'over') ev('gameover', { level: (G.level | 0) + 1 });
        if (st === 'final') ev('game_won', {});
        if (st === 'arena' && g.ARN) ev('arena_start', { wave: g.ARN.wave | 0 });
        if (pv.st === 'arena' && st !== 'arena' && g.ARN && !g.ARN.over)
          ev('arena_exit', { wave: g.ARN.wave | 0, score: g.ARN.score | 0 });
        pv.st = st;
      }
      /* вход в новый уровень (в т.ч. через «ВЫБОР УРОВНЯ» и warp) */
      const lv = G.level | 0;
      if (lv !== pv.lv) { ev('level_load', { level: lv + 1, name: (snap().level_name || '') }); pv.lv = lv; }
      /* смерть: жизни убывают во время игры */
      const lives = G.lives | 0;
      if (pv.lives >= 0 && lives < pv.lives && st === 'play') ev('death', { lives });
      pv.lives = lives;
      /* печать: в массиве печатей появилась новая единица */
      const seals = (G.seals || []).map(b => b ? 1 : 0).join('');
      if (pv.seals && seals.length === pv.seals.length && seals !== pv.seals) {
        let w = 0; while (w < seals.length && !(seals[w] === '1' && pv.seals[w] === '0')) w++;
        if (w < seals.length) ev('seal_get', { world: w + 1, level: lv + 1 });
      }
      pv.seals = seals;
      /* арена: конец забега (ARN.over взводится один раз) */
      if (g.ARN) {
        const over = !!g.ARN.over;
        if (over && !pv.arnOver) {
          let best = 0; try { best = parseInt(localStorage.getItem(ARN_LS), 10) || 0; } catch (e) {}
          ev('arena_end', { wave: g.ARN.wave | 0, score: g.ARN.score | 0, best });
        }
        pv.arnOver = over;
      }
      /* кооп: включение/выключение сети и смена комнаты */
      const N = g.NET;
      const ck = N && N.on ? (N.mode || '') + ':' + (N.code || '') : '';
      if (ck !== pv.net) { ev('coop', { on: !!(N && N.on), mode: N ? N.mode : '',
        code: N && N.on ? N.code : '' }); pv.net = ck; }
    } catch (e) {}
  }

  /* ---------- ПУЛЬС: полный снапшот каждые 10 с ---------- */
  function tick() {
    try {
      if (sess && !sess.ended_at) {
        sess.snap = snap();
        lsSet(K_SESS, sess);
        const idle = now() - lastAct;
        if (document.hidden && hiddenAt && now() - hiddenAt > HIDE_MS) finalize('tab_hidden');
        else if (idle > IDLE_MS) finalize('idle');
      }
    } catch (e) {}
  }

  /* ---------- ОБЁРТКИ ОТКРЫТЫХ МЕТОДОВ ИГРЫ (без правок index.html) ----------
     Bank.buy/buyAcc/buyArt и Prog.record — свойства объектов, поэтому
     замена свойства честно перехватывает все внутренние вызовы игры:
     покупки в магазине и «уровень пройден» (звёзды, время) летят в журнал. */
  function wrapBank() {
    try {
      const g = window.__G; const B = g && g.Bank;
      if (!B || B.__m) return;
      ['buy', 'buyAcc', 'buyArt'].forEach(k => {
        const orig = B[k]; if (typeof orig !== 'function') return;
        B[k] = function (id) { const ok = orig.apply(this, arguments);
          try { ev('shop_buy', { id: id, ok: !!ok, kind: k }); } catch (e) {}
          return ok; };
      });
      B.__m = true;
    } catch (e) {}
  }
  function wrapProg() {
    try {
      const g = window.__G; const PR = g && g.Prog;
      if (!PR || PR.__m || typeof PR.record !== 'function') return;
      const orig = PR.record;
      PR.record = function (i, stars, time) {
        const rec = orig.apply(this, arguments);
        try { ev('level_clear', { level: (i | 0) + 1, stars: stars | 0,
          time: Math.round(time | 0) }); } catch (e) {}
        return rec;
      };
      PR.__m = true;
    } catch (e) {}
  }
  /* игра может загрузиться позже метрик (script async) — дожидаемся __G */
  function waitGame(fn, tries) {
    if (window.__G) { fn(); return; }
    if (tries > 600) return;                       // ~30 c — дальше не ждём
    setTimeout(() => waitGame(fn, tries + 1), 50);
  }

  /* ---------- АКТИВНОСТЬ: любые нажатия/тапы = игрок жив ---------- */
  function markAct() { lastAct = now();
    if (ended) resume();                          // вернулся после finalize
    if (document.hidden) hiddenAt = 0; }
  ['keydown', 'pointerdown', 'touchstart'].forEach(t =>
    addEventListener(t, markAct, { passive: true }));

  /* ---------- УХОД ИЗ ВКЛАДКИ ---------- */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = now();
      try { if (sess && !sess.ended_at) { sess.snap = snap(); lsSet(K_SESS, sess); } } catch (e) {} }
    else { hiddenAt = 0; markAct(); }
  });
  addEventListener('pagehide', () => finalize('close'));
  addEventListener('beforeunload', () => finalize('close'));

  /* ---------- ПУБЛИЧНЫЙ API (задел для прямых хуков и консоли) ---------- */
  const M = {
    levelLoad(i) { ev('level_load', { level: (i | 0) + 1 }); },
    levelStart() { const s = snap();
      ev('level_start', { level: (s.level_idx | 0) + 1, name: s.level_name || '', world: s.world }); },
    levelClear(o) { ev('level_clear', Object.assign({ level: (snap().level_idx | 0) + 1 }, o || {})); },
    death(o) { ev('death', o || {}); },
    gameover() { ev('gameover', { level: (snap().level_idx | 0) + 1, state: snap().state }); },
    sealGet(w) { ev('seal_get', { world: (w | 0) + 1, level: (snap().level_idx | 0) + 1 }); },
    arenaStart() { ev('arena_start', {}); },
    arenaEnd(o) { ev('arena_end', o || {}); },
    arenaExit(o) { ev('arena_exit', o || {}); },
    ev,
    snap, whereStr,
    info() { return { pid: PID, session: sess, queue: q.length, dbOk: netOk() ? dbOk : 'нет конфига' }; }
  };

  /* ---------- СТАРТ: сессия сразу, игровые хуки — как только игра готова ---------- */
  startSession();
  waitGame(() => { wrapBank(); wrapProg(); pv.lv = (window.__G.G.level | 0); });
  setInterval(pollGame, POLL * 1000);
  setInterval(tick, HEARTBEAT * 1000);
  setInterval(() => { if (!ended) flushNow(false); }, FLUSH * 1000);
  window.Metrics = M;                 // для консоли и будущих прямых хуков
  return M;
})();
