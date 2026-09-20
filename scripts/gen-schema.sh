#!/usr/bin/env bash
# 生成并冻结 app-server 协议 schema 与 TypeScript 绑定。
#
# 产物入库（schemas/ 与 src/types/protocol/），使协议变更在 PR diff 中可见——
# 这是应对 app-server 被官方标记为实验性、字段可能变化的第一道防线。
#
# 用法：
#   bash scripts/gen-schema.sh           # 生成到 schemas/ 与 src/types/protocol/
#   bash scripts/gen-schema.sh --check   # 只校验是否有漂移，不写文件（CI 用）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA_OUT="$ROOT/schemas"
TS_OUT="$ROOT/src/types/protocol"
CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1

find_binary() {
  local candidates=(
    "$ROOT/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"
    "$ROOT/node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex"
    "$ROOT/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"
    "$ROOT/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex"
  )
  local c
  for c in "${candidates[@]}"; do [[ -f "$c" ]] && { echo "$c"; return 0; }; done
  return 1
}

BIN="$(find_binary)" || { echo "✗ 未找到 codex 二进制，请先 npm install" >&2; exit 2; }
VERSION="$("$BIN" --version | awk '{print $NF}')"
echo "codex $VERSION"

if [[ "$CHECK" == "1" ]]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  "$BIN" app-server generate-json-schema --out "$TMP/schema" >/dev/null
  "$BIN" app-server generate-ts --out "$TMP/ts" >/dev/null 2>&1 || true

  DRIFT=0
  # GENERATED_FROM.json 是本脚本自己写的溯源元数据，不属于 codex 的生成产物，比对时排除。
  if ! diff -rq --exclude='GENERATED_FROM.json' "$SCHEMA_OUT" "$TMP/schema" >/dev/null 2>&1; then
    echo "✗ schema 相对仓库内冻结版本发生漂移：" >&2
    diff -rq --exclude='GENERATED_FROM.json' "$SCHEMA_OUT" "$TMP/schema" 2>&1 | head -30 >&2
    DRIFT=1
  else
    echo "✓ schema 无漂移"
  fi
  if [[ -d "$TS_OUT" ]] && [[ -d "$TMP/ts" ]]; then
    if ! diff -rq "$TS_OUT" "$TMP/ts" >/dev/null 2>&1; then
      echo "⚠ TypeScript 绑定发生漂移：" >&2
      diff -rq "$TS_OUT" "$TMP/ts" 2>&1 | head -20 >&2
      DRIFT=1
    else
      echo "✓ TypeScript 绑定无漂移"
    fi
  fi
  exit $DRIFT
fi

mkdir -p "$SCHEMA_OUT" "$TS_OUT"
rm -rf "$SCHEMA_OUT"/* "$TS_OUT"/*
"$BIN" app-server generate-json-schema --out "$SCHEMA_OUT"
"$BIN" app-server generate-ts --out "$TS_OUT" 2>/dev/null || \
  echo "⚠ generate-ts 未产出（该子命令依赖 prettier 可选参数，可忽略）"

# 记录生成来源，便于追溯
cat > "$SCHEMA_OUT/GENERATED_FROM.json" <<EOF
{
  "generator": "codex app-server generate-json-schema",
  "codexVersion": "$VERSION",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "note": "此目录由 scripts/gen-schema.sh 生成，请勿手工编辑。协议漂移由 CI 通过 --check 检测。"
}
EOF

echo "✓ schema  → $SCHEMA_OUT ($(find "$SCHEMA_OUT" -type f | wc -l | tr -d ' ') 个文件)"
[[ -d "$TS_OUT" ]] && echo "✓ TS 绑定 → $TS_OUT ($(find "$TS_OUT" -type f 2>/dev/null | wc -l | tr -d ' ') 个文件)"
