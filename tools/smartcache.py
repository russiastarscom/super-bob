#!/usr/bin/env python3
# ============================================================
# УМНЫЙ КЕШ СБОРКИ SUPER BOB (tools/smartcache.py)
# ------------------------------------------------------------
# Каждая дорогая стадия сборки кешируется по SHA-256 входов:
#   1) wasm    — сборка C++-движков emcc -> engine/bob_engine.js
#   2) levels  — прекомпиляция всех уровней НАСТОЯЩИМ парсером
#                игры (Node-харнес) -> engine/levels_cache.js
#   3) verify  — верификация кеша уровней (быстрый путь == шаблон)
#   4) bench   — тест эквивалентности WASM/JS + бенчмарк
#   5) fast    — сборка index.fast.html: WASM и кеш уровней
#                встроены в файл (одна страница, ноль запросов)
# Повторный запуск при неизменных входах — миллисекунды.
#
#   python3 tools/smartcache.py            # полная сборка
#   python3 tools/smartcache.py --clean    # сбросить кеш
# ============================================================
import hashlib, io, json, os, shutil, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".bobcache")
EMSDK_ENV = os.environ.get("EMSDK_ENV", "/home/z/my-project/work/emsdk/emsdk_env.sh")

STAGE_TIMES = {}
def stage(name, key_files, fn, out_ok):
    """Стадия с кешем по sha256 входов. out_ok(dst) — выход уже на месте."""
    h = hashlib.sha256()
    for f in key_files:
        h.update(f.encode())
        h.update(b"\0")
        if os.path.exists(f):
            h.update(open(f, "rb").read())
        h.update(b"\0")
    key = h.hexdigest()[:24]
    dst = os.path.join(CACHE, f"{name}_{key}")
    os.makedirs(CACHE, exist_ok=True)
    t0 = time.perf_counter()
    if out_ok(dst):
        dt = time.perf_counter() - t0
        print(f"  [{name}] кеш-ПОПАДАНИЕ {key} ({dt*1000:.1f} мс)")
        STAGE_TIMES[name] = (True, dt)
        return True
    fn(dst)
    dt = time.perf_counter() - t0
    print(f"  [{name}] собрано заново {key} ({dt:.2f} с)")
    STAGE_TIMES[name] = (False, dt)
    return False

def sh(cmd, env=None):
    r = subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True, timeout=300,
                       env={**os.environ, **(env or {})})
    if r.returncode != 0:
        print(r.stdout[-2000:]); print(r.stderr[-2000:])
        sys.exit(f"стадия провалилась: {cmd}")
    return r.stdout

def build_wasm(dst):
    src = sh("bash engine/build.sh", env={"PATH": os.environ["PATH"]})
    shutil.copyfile(os.path.join(ROOT, "engine", "bob_engine.js"), dst)

def wasm_out():
    return os.path.join(ROOT, "engine", "bob_engine.js")

def build_levels(dst):
    tmp = dst + ".tmp.json"
    sh(f'node tools/dump_levels.js index.html map/maps.js "{tmp}"')
    dump = json.load(io.open(tmp, encoding="utf-8"))
    sig = fnv1a_js(dump)
    with io.open(os.path.join(ROOT, "engine", "levels_cache.js"), "w", encoding="utf-8") as f:
        f.write("/* УМНЫЙ КЕШ УРОВНЕЙ Super Bob — сгенерирован tools/smartcache.py.\n")
        f.write("   Шаблоны собраны НАСТОЯЩИМ парсером игры; сигнатура защищает от рассинхрона. */\n")
        f.write("(function(){ window.__BOB_LVLC = { sig: " + str(sig) + ", n: " + str(dump["n"]) + ", lv: ")
        f.write(json.dumps(dump["lv"], ensure_ascii=False, separators=(",", ":")))
        f.write(" }; })();\n")
    shutil.copyfile(os.path.join(ROOT, "engine", "levels_cache.js"), dst + ".lvl")
    os.remove(tmp)

def levels_out():
    return os.path.join(ROOT, "engine", "levels_cache.js")

def fnv1a_js(dump):
    """Сигнатура карт — в точности как mapSig() в игре:
    одна UTF-8-лента полей через разделитель \\x00, FNV-1a 32."""
    acc = ["BOB-LVLC-1", str(dump["n"])]
    for lv in dump["lv"]:
        acc.append(lv["name"] or "")
        acc.append(str(lv["theme"]))
        acc.append(lv["chars"])                 # строки карты одной лентой (rows.join(''))
        p = lv["pal"]
        for k in p:
            acc.append(k); acc.append(str(p[k]))
    h = 0x811c9dc5
    for b in "\x00".join(acc).encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h

def run_verify_store(dst):
    out = sh("node tools/verify_cache.js index.html map/maps.js engine/levels_cache.js")
    print("  " + out.strip().splitlines()[-1])
    open(dst, "w").write("ok")

def run_bench_store(dst):
    out = sh("node tests/test_equiv.js")
    open(dst, "w").write(out)
    for line in out.strip().splitlines()[-4:]:
        print("  " + line)

def build_fast(dst):
    html = io.open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    eng = io.open(os.path.join(ROOT, "engine", "bob_engine.js"), encoding="utf-8").read()
    lvl = io.open(os.path.join(ROOT, "engine", "levels_cache.js"), encoding="utf-8").read()
    a = '<script src="engine/bob_engine.js"></script>'
    b = '<script src="engine/levels_cache.js"></script>'
    assert a in html and b in html, "теги движков не найдены в index.html"
    html = html.replace(a, "<script>\n/* WASM-движки (bobphys+bobfx), встроено smartcache.py */\n" + eng + "\n</script>")
    html = html.replace(b, "<script>\n" + lvl + "</script>")
    io.open(os.path.join(ROOT, "index.fast.html"), "w", encoding="utf-8").write(html)
    shutil.copyfile(os.path.join(ROOT, "index.fast.html"), dst)

def fast_out():
    return os.path.join(ROOT, "index.fast.html")

def main():
    if "--clean" in sys.argv:
        shutil.rmtree(CACHE, ignore_errors=True)
        print("кеш сброшен")
    if not os.path.exists(os.path.join(ROOT, "engine")):
        os.makedirs(os.path.join(ROOT, "engine"))
    print("=== УМНЫЙ КЕШ СБОРКИ SUPER BOB ===")
    stage("wasm",   [os.path.join(ROOT, "engine", "bob_engine.cpp"),
                     os.path.join(ROOT, "engine", "build.sh")], build_wasm,
          lambda dst: os.path.exists(dst) and os.path.exists(wasm_out()))
    stage("levels", [os.path.join(ROOT, "index.html"),
                     os.path.join(ROOT, "map", "maps.js"),
                     os.path.join(ROOT, "tools", "dump_levels.js")], build_levels,
          lambda dst: os.path.exists(dst) and os.path.exists(levels_out()))
    stage("verify", [os.path.join(ROOT, "index.html"),
                     os.path.join(ROOT, "map", "maps.js"),
                     os.path.join(ROOT, "engine", "levels_cache.js"),
                     os.path.join(ROOT, "tools", "verify_cache.js")],
          run_verify_store,
          lambda dst: os.path.exists(dst))
    stage("bench",  [os.path.join(ROOT, "engine", "bob_engine.js"),
                     os.path.join(ROOT, "engine", "bob_twin.js"),
                     os.path.join(ROOT, "tests", "test_equiv.js")], run_bench_store,
          lambda dst: os.path.exists(dst))
    stage("fast",   [os.path.join(ROOT, "index.html"),
                     os.path.join(ROOT, "engine", "bob_engine.js"),
                     os.path.join(ROOT, "engine", "levels_cache.js")], build_fast,
          lambda dst: os.path.exists(dst) and os.path.exists(fast_out()))
    hits = sum(1 for h, _ in STAGE_TIMES.values() if h)
    total = sum(dt for _, dt in STAGE_TIMES.values())
    print(f"=== ИТОГ: {hits}/{len(STAGE_TIMES)} стадий из кеша, {total:.2f} с ===")
    print(f"index.html          : {os.path.getsize(os.path.join(ROOT, 'index.html'))} байт")
    print(f"index.fast.html     : {os.path.getsize(os.path.join(ROOT, 'index.fast.html'))} байт (WASM + кеш уровней внутри)")
    print(f"engine/bob_engine.js: {os.path.getsize(os.path.join(ROOT, 'engine', 'bob_engine.js'))} байт (wasm внутри, single-file)")

if __name__ == "__main__":
    main()
