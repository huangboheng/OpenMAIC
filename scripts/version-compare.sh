#!/usr/bin/env bash
# ============================================================
# version-compare.sh — 本地与远端版本对比
#
# 对比本地仓库 VERSION 文件与 VPS 部署目录的 .deploy-version 记录，
# 输出版本差异，帮助判断是否需要部署。
#
# 用法:
#   bash scripts/version-compare.sh              # 对比两个项目
#   bash scripts/version-compare.sh philochora   # 仅对比 Philochora
#   bash scripts/version-compare.sh openmaic     # 仅对比 OpenMAIC
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# ── 读取本地版本 ─────────────────────────────────────────
read_local_version() {
  local repo_dir="$1"
  local version_file="${repo_dir}/VERSION"
  if [[ -f "$version_file" ]]; then
    cat "$version_file" | tr -d '[:space:]'
  else
    echo ""
  fi
}

# ── 读取远端版本（通过 SSH）──────────────────────────────
read_remote_version() {
  local host="$1"
  local deploy_dir="$2"
  local version_file="${deploy_dir}/.deploy-version"
  ssh "root@${host}" "cat '${version_file}' 2>/dev/null || echo '{}'" 2>/dev/null | \
    grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | \
    sed 's/.*"\([^"]*\)".*/\1/' || echo ""
}

# ── 读取 VPS 主机名 ──────────────────────────────────────
read_vps_host() {
  local env_file="${PROJECT_ROOT}/.env.vps.local"
  if [[ -f "$env_file" ]]; then
    grep -m1 '^HOSTNAME=' "$env_file" | cut -d= -f2 || echo ""
  else
    echo ""
  fi
}

# ── 对比单个项目 ─────────────────────────────────────────
compare_project() {
  local name="$1"
  local local_dir="$2"
  local remote_dir="$3"
  local host="$4"

  echo ""
  echo "=== ${name} ==="

  local local_version
  local_version=$(read_local_version "$local_dir")
  if [[ -z "$local_version" ]]; then
    echo "  本地版本: (未找到 VERSION 文件)"
    return
  fi
  echo "  本地版本: ${local_version}"

  if [[ -z "$host" ]]; then
    echo "  远端版本: (无法读取 VPS 主机名)"
    return
  fi

  local remote_version
  remote_version=$(read_remote_version "$host" "$remote_dir")
  if [[ -z "$remote_version" ]]; then
    echo "  远端版本: (未部署或无可用的 .deploy-version)"
    echo "  状态: 本地 ${local_version} → 远端未记录"
    return
  fi
  echo "  远端版本: ${remote_version}"

  if [[ "$local_version" == "$remote_version" ]]; then
    echo "  状态: 版本一致"
  else
    echo "  状态: 需要部署 (本地 ${local_version} ≠ 远端 ${remote_version})"
  fi
}

# ── 主流程 ───────────────────────────────────────────────
main() {
  local target="${1:-all}"
  local host
  host=$(read_vps_host)

  echo "========================================"
  echo "  版本对比"
  echo "========================================"
  echo "  VPS 主机: ${host:-(未配置)}"
  echo "  对比项目: ${target}"

  if [[ "$target" == "all" || "$target" == "philochora" ]]; then
    # Philochora 与 OpenMAIC 为同级目录
    local philo_root="$(dirname "$PROJECT_ROOT")/Philochora"
    if [[ ! -d "$philo_root" ]]; then
      philo_root="$(dirname "$PROJECT_ROOT")/philochora"
    fi
    compare_project "Philochora" "$philo_root" "/var/www/philochora" "$host"
  fi

  if [[ "$target" == "all" || "$target" == "openmaic" ]]; then
    compare_project "OpenMAIC" "$PROJECT_ROOT" "/var/www/openmaic" "$host"
  fi

  echo ""
  echo "========================================"
}

main "$@"
