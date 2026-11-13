#!/usr/bin/env bash
# ============================================================
# Сборка C++-движков Super Bob в WebAssembly (single-file JS:
# .wasm встроен base64 — игра остаётся офлайн, без внешних файлов).
# Требуется Emscripten (emsdk). Результат: engine/bob_engine.js
# ============================================================
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
EMCC="${EMCC:-emcc}"
if ! command -v "$EMCC" >/dev/null 2>&1; then
  for c in "$DIR/../../emsdk/upstream/emscripten/emcc" \
           /opt/emsdk/upstream/emscripten/emcc; do
    [ -x "$c" ] && EMCC="$c" && break
  done
fi
command -v "$EMCC" >/dev/null 2>&1 || { echo "emcc не найден: установи emsdk (https://emscripten.org)"; exit 1; }

"$EMCC" "$DIR/bob_engine.cpp" -O3 -flto \
  -sMODULARIZE=1 -sEXPORT_NAME=BobEngWasm -sSINGLE_FILE=1 \
  -sENVIRONMENT=web,node -sALLOW_MEMORY_GROWTH=0 -sINVOKE_RUN=0 \
  -sEXPORTED_RUNTIME_METHODS=HEAPF64,HEAPU8 \
  -sEXPORTED_FUNCTIONS=_eng_init,_eng_set_level,_eng_set_tile,_eng_solid,_eng_sync_boxes,_eng_move_x,_eng_move_y,_grid_base,_ent_base,_out_base,_box_base,_fx_clear,_fx_spawn,_fx_step,_fx_count,_fx_x_base,_fx_y_base,_fx_t_base,_fx_life_base,_fx_s_base,_fx_col_base,_fx_flags_base \
  --no-entry \
  -o "$DIR/bob_engine.js"
echo "OK: $DIR/bob_engine.js ($(wc -c < "$DIR/bob_engine.js") байт)"
