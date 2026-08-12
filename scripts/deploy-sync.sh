#!/usr/bin/env bash
# deploy-sync.sh
#
# OpenMAIC 课堂数据 rsync 同步封装
#   将本地 data/classrooms/ 增量同步到 VPS，带校验、备份、预览功能。
#   [FIX 2026-08-12] 目标路径修正为 /var/www/openmaic/data/classrooms/
#   （原 /opt/openmaic/data/classrooms/ 在 VPS 不存在，应用实际读取 /var/www/openmaic）
#
# 用法：
#   bash scripts/deploy-sync.sh                  # 全量同步（实际传输）
#   bash scripts/deploy-sync.sh --dry-run        # 预览差异（不传输）
#   bash scripts/deploy-sync.sh --checksum       # 强制校验和对比（慢但可靠）
#   bash scripts/deploy-sync.sh --verbose        # 打印每个文件
#
# 环境变量（脚本内配置默认值，可通过环境变量覆盖）:
#   DEPLOY_VPS_HOST    VPS 地址（默认读取 .env.vps.local 的 HOSTNAME）
#   DEPLOY_VPS_USER    VPS 用户名（默认 root）
#   DEPLOY_VPS_PATH    VPS 上 classrooms 目录路径（默认 /var/www/openmaic/data/classrooms/）
#   DEPLOY_RSYNC_PORT  SSH 端口（默认 22）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# ---------- 参数 ----------
DRY_RUN=""
CHECKSUM=""
VERBOSE=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="--dry-run" ;;
    --checksum) CHECKSUM="--checksum" ;;
    --verbose) VERBOSE="--verbose" ;;
    --help|-h)
      echo "用法: $0 [--dry-run] [--checksum] [--verbose]"
      echo "  --dry-run   预览差异，不实际传输"
      echo "  --checksum  使用校验和对比（强制全量校验，较慢）"
      echo "  --verbose   打印每个传输文件"
      exit 0 ;;
  esac
done

# ---------- 配置 ----------
: "${DEPLOY_VPS_HOST:=$(grep -m1 '^HOSTNAME=' "$PROJECT_ROOT/.env.vps.local" 2>/dev/null | cut -d= -f2 || echo '')}"
: "${DEPLOY_VPS_USER:=root}"
: "${DEPLOY_VPS_PATH:=/var/www/openmaic/data/classrooms/}"
: "${DEPLOY_RSYNC_PORT:=22}"

if [ -z "$DEPLOY_VPS_HOST" ]; then
  echo "[ERROR] DEPLOY_VPS_HOST 未设置，请在 .env.vps.local 中配置 HOSTNAME= 或 export DEPLOY_VPS_HOST=..."
  exit 1
fi

LOCAL_DIR="$PROJECT_ROOT/data/classrooms/"
REMOTE="${DEPLOY_VPS_USER}@${DEPLOY_VPS_HOST}:${DEPLOY_VPS_PATH}"
EXCLUDE_FILE="$PROJECT_ROOT/.rsync-exclude"
TIMESTAMP="$(date +%s)"
BACKUP_DIR="/tmp/deploy-backup-${TIMESTAMP}"
LOG_FILE="$PROJECT_ROOT/logs/deploy-sync-${TIMESTAMP}.log"

echo "========================================" | tee "$LOG_FILE"
echo "OpenMAIC 课堂数据同步" | tee -a "$LOG_FILE"
echo "========================================" | tee -a "$LOG_FILE"
echo "  本地目录: $LOCAL_DIR" | tee -a "$LOG_FILE"
echo "  远端目标: $REMOTE" | tee -a "$LOG_FILE"
echo "  SSH 端口: $DEPLOY_RSYNC_PORT" | tee -a "$LOG_FILE"
echo "  日志文件: $LOG_FILE" | tee -a "$LOG_FILE"
[ -n "$DRY_RUN" ] && echo "  *** DRY-RUN 模式，不会实际传输 ***" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# ---------- 统计本地数据 ----------
LOCAL_JSON_COUNT=$(find "$LOCAL_DIR" -maxdepth 1 -name '*.json' | wc -l)
LOCAL_MP3_COUNT=$(find "$LOCAL_DIR" -name '*.mp3' | wc -l)
LOCAL_SIZE=$(du -sh "$LOCAL_DIR" 2>/dev/null | cut -f1)
echo "[INFO] 本地: ${LOCAL_JSON_COUNT} JSON, ${LOCAL_MP3_COUNT} MP3, ${LOCAL_SIZE}" | tee -a "$LOG_FILE"

# ---------- 构建 rsync 参数 ----------
RSYNC_OPTS="-avzP"
[ -n "$DRY_RUN" ] && RSYNC_OPTS="$RSYNC_OPTS --dry-run"
[ -n "$CHECKSUM" ] && RSYNC_OPTS="$RSYNC_OPTS --checksum"
[ -n "$VERBOSE" ] && RSYNC_OPTS="$RSYNC_OPTS --verbose"

RSYNC_ARGS=(
  $RSYNC_OPTS
  --delay-updates                  # 原子更新：先传临时目录再 rename
  --delete                         # 删除远端本地不存在的文件（保持完全一致）
  --backup --backup-dir="$BACKUP_DIR"  # 备份被覆盖的文件
  --exclude-from="$EXCLUDE_FILE"
  -e "ssh -p ${DEPLOY_RSYNC_PORT}"
  "$LOCAL_DIR"
  "$REMOTE"
)

# ---------- 执行 ----------
echo "[START] $(date)" | tee -a "$LOG_FILE"
if rsync "${RSYNC_ARGS[@]}" 2>&1 | tee -a "$LOG_FILE"; then
  echo "[OK] rsync 完成 ($(date))" | tee -a "$LOG_FILE"
else
  echo "[FAIL] rsync 失败，退出码: $?" | tee -a "$LOG_FILE"
  echo "[INFO] 备份目录: $BACKUP_DIR （如存在）" | tee -a "$LOG_FILE"
  exit 1
fi

if [ -n "$DRY_RUN" ]; then
  echo "[INFO] dry-run 模式，未做实际变更" | tee -a "$LOG_FILE"
  exit 0
fi

# ---------- 校验远端数据量 ----------
echo "" | tee -a "$LOG_FILE"
echo "[INFO] 校验远端数据量..." | tee -a "$LOG_FILE"
REMOTE_JSON_COUNT=$(ssh -p "$DEPLOY_RSYNC_PORT" "${DEPLOY_VPS_USER}@${DEPLOY_VPS_HOST}" "find ${DEPLOY_VPS_PATH} -maxdepth 1 -name '*.json' | wc -l")
REMOTE_MP3_COUNT=$(ssh -p "$DEPLOY_RSYNC_PORT" "${DEPLOY_VPS_USER}@${DEPLOY_VPS_HOST}" "find ${DEPLOY_VPS_PATH} -name '*.mp3' | wc -l")
echo "[INFO] 远端: ${REMOTE_JSON_COUNT} JSON, ${REMOTE_MP3_COUNT} MP3" | tee -a "$LOG_FILE"

if [ "$LOCAL_JSON_COUNT" = "$REMOTE_JSON_COUNT" ] && [ "$LOCAL_MP3_COUNT" = "$REMOTE_MP3_COUNT" ]; then
  echo "[OK] 远端文件数一致" | tee -a "$LOG_FILE"
else
  echo "[WARN] 文件数不一致: 本地 JSON=${LOCAL_JSON_COUNT}/MP3=${LOCAL_MP3_COUNT} vs 远端 JSON=${REMOTE_JSON_COUNT}/MP3=${REMOTE_MP3_COUNT}" | tee -a "$LOG_FILE"
  echo "[INFO] 可重新运行或使用 --checksum 模式重试" | tee -a "$LOG_FILE"
fi

echo "[DONE] $(date)" | tee -a "$LOG_FILE"
