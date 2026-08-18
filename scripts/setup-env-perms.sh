#!/usr/bin/env bash
# scripts/setup-env-perms.sh
# 本地密钥文件权限收紧：把所有 .env* 文件设为 600（仅当前用户可读写）。
# 适用项目：OpenMAIC（Philochora 版见 Philochora/scripts/setup-env-perms.sh）
#
# 用法：
#   bash scripts/setup-env-perms.sh           收紧当前目录的 .env* 权限
#   bash scripts/setup-env-perms.sh --audit   仅审计（不修改权限）
#   bash scripts/setup-env-perms.sh --strict  权限过宽时报错退出（非 0）
#
# 退出码：
#   0 - 全部合规
#   1 - 权限过宽（仅 --strict 模式）
#
# 平台说明：
# - Linux / macOS：chmod 600 生效。
# - Windows NTFS：chmod 在 WSL / git-bash 下不生效（NTFS ACL 由 Windows 系统管理）。
#   Windows 用户请用 PowerShell：`icacls .env.local /inheritance:r /grant:r "$($env:USERNAME):(R,W)"`

set -u

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUDIT_ONLY=0
STRICT=0
WARN_COUNT=0

for arg in "$@"; do
  case "$arg" in
    --audit) AUDIT_ONLY=1 ;;
    --strict) STRICT=1 ;;
    --help|-h)
      echo "Usage: $0 [--audit] [--strict]"
      echo "  --audit   仅审计（不修改权限）"
      echo "  --strict  权限过宽时 exit 1"
      exit 0
      ;;
  esac
done

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; WARN_COUNT=$((WARN_COUNT + 1)); }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

cd "${PROJECT_ROOT}"

# 扫描 .env* 文件（仅当前目录根级别，避免误伤子目录）
info "扫描 ${PROJECT_ROOT} 下的 .env* / server-providers*.yml 文件..."

ENV_FILES=()
while IFS= read -r -d '' f; do
  ENV_FILES+=("$f")
done < <(find . -maxdepth 1 -type f \( -name '.env*' -o -name 'server-providers*.yml' \) -print0 2>/dev/null)

if [ ${#ENV_FILES[@]} -eq 0 ]; then
  info "未发现密钥文件（如 .env.local、.env.vps.local、server-providers.yml 等）"
  exit 0
fi

for f in "${ENV_FILES[@]}"; do
  # 提取权限位（八进制）
  if stat --version >/dev/null 2>&1; then
    # GNU stat（Linux）
    PERM=$(stat -c '%a' "$f")
  else
    # BSD stat（macOS）/ Windows git-bash
    PERM=$(stat -f '%Lp' "$f" 2>/dev/null || echo "000")
  fi

  OWNER_RW=0
  GROUP_OTHER_RW=0
  if [[ "${PERM:2:1}" =~ [2367] ]]; then GROUP_OTHER_RW=1; fi
  if [[ "${PERM:1:1}" =~ [2367] ]]; then GROUP_OTHER_RW=1; fi

  if [ "${PERM}" = "600" ] || [ "${PERM}" = "400" ]; then
    info "  ✓ ${f} (权限 ${PERM})"
  else
    if [ "${AUDIT_ONLY}" = "1" ]; then
      warn "  ⚠ ${f} (权限 ${PERM}) — 应为 600"
    else
      warn "  ⚠ ${f} (权限 ${PERM}) — 自动收紧为 600"
      chmod 600 "$f" 2>/dev/null && info "    已收紧" || err "    收紧失败（请手动执行 chmod 600 ${f}）"
    fi
  fi
done

echo ""
if [ "${WARN_COUNT}" -gt 0 ]; then
  if [ "${STRICT}" = "1" ]; then
    err "审计完成：${WARN_COUNT} 处权限不合规（--strict 模式退出 1）"
    exit 1
  fi
  warn "审计完成：${WARN_COUNT} 处权限需要关注"
else
  info "审计完成：所有密钥文件权限合规"
fi
exit 0
