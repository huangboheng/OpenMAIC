#!/usr/bin/env bash
# deploy-nginx.sh
#
# OpenMAIC/Philochora 边缘 Nginx 配置部署（deploy/nginx/philochora.conf → VPS）
#   本仓 deploy/nginx/philochora.conf 是 /etc/nginx/sites-available/philochora.conf
#   的唯一事实源（API 面契约见文件头与 docs/adr/0001-nginx-api-allowlist-contract.md）。
#
# 用法：
#   bash scripts/deploy-nginx.sh --dry-run   # 仅输出本地与远端的 diff，不改动
#   bash scripts/deploy-nginx.sh             # 备份远端 → 上传 → nginx -t → reload → 穿透验证
#
# 安全设计：
#   - apply 前在远端生成带时间戳的备份（/etc/nginx/backups/）
#   - nginx -t 失败自动回滚备份，绝不 reload 坏配置
#   - 使用 reload（非 restart），不中断现有连接
#   - apply 后自动执行穿透验证（server-providers 应不再返回 nginx-403）
#
# 环境变量（默认值与 deploy-sync.sh 一致）:
#   DEPLOY_VPS_HOST    VPS 地址（默认读取 .env.vps.local 的 HOSTNAME）
#   DEPLOY_VPS_USER    VPS 用户名（默认 root）
#   DEPLOY_SSH_KEY     SSH 密钥（默认 ~/.ssh/philochora_vps，若存在）
#   DEPLOY_RSYNC_PORT  SSH 端口（默认 22）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

LOCAL_CONF="$PROJECT_ROOT/deploy/nginx/philochora.conf"
REMOTE_PATH="/etc/nginx/sites-available/philochora.conf"
PUBLIC_URL="${DEPLOY_PUBLIC_URL:-https://philochora.com/openmaic}"

DRY_RUN=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="1" ;;
    --help|-h)
      echo "用法: bash scripts/deploy-nginx.sh [--dry-run]"
      exit 0 ;;
    *)
      echo "[ERROR] 未知参数: $arg" >&2
      exit 1 ;;
  esac
done

# ---------- 配置 ----------
: "${DEPLOY_VPS_HOST:=$(grep -m1 '^HOSTNAME=' "$PROJECT_ROOT/.env.vps.local" 2>/dev/null | cut -d= -f2 || echo '')}"
: "${DEPLOY_VPS_USER:=root}"
: "${DEPLOY_RSYNC_PORT:=22}"
if [ -z "${DEPLOY_SSH_KEY:-}" ] && [ -f "$HOME/.ssh/philochora_vps" ]; then
  DEPLOY_SSH_KEY="$HOME/.ssh/philochora_vps"
fi

if [ -z "$DEPLOY_VPS_HOST" ]; then
  echo "[ERROR] DEPLOY_VPS_HOST 未设置，请在 .env.vps.local 中配置 HOSTNAME= 或 export DEPLOY_VPS_HOST=..."
  exit 1
fi
if [ ! -f "$LOCAL_CONF" ]; then
  echo "[ERROR] 本地配置不存在: $LOCAL_CONF"
  exit 1
fi

SSH_OPTS=(-p "$DEPLOY_RSYNC_PORT" -o BatchMode=yes -o ConnectTimeout=15)
SCP_OPTS=(-P "$DEPLOY_RSYNC_PORT" -o BatchMode=yes -o ConnectTimeout=15)
if [ -n "${DEPLOY_SSH_KEY:-}" ]; then
  SSH_OPTS+=(-i "$DEPLOY_SSH_KEY")
  SCP_OPTS+=(-i "$DEPLOY_SSH_KEY")
fi
REMOTE="${DEPLOY_VPS_USER}@${DEPLOY_VPS_HOST}"

ssh_cmd() { ssh "${SSH_OPTS[@]}" "$REMOTE" "$@"; }

echo "========================================"
echo "OpenMAIC Nginx 配置部署"
echo "========================================"
echo "  本地配置: $LOCAL_CONF"
echo "  远端目标: $REMOTE:$REMOTE_PATH"
echo "  公网验证: $PUBLIC_URL"
[ -n "$DRY_RUN" ] && echo "  *** DRY-RUN 模式，不会改动远端 ***"
echo ""

# ---------- 拉取远端当前配置并 diff ----------
TMP_REMOTE="$(mktemp)"
trap 'rm -f "$TMP_REMOTE"' EXIT
ssh_cmd "cat $REMOTE_PATH" > "$TMP_REMOTE"

if diff -u "$TMP_REMOTE" "$LOCAL_CONF"; then
  echo ""
  echo "[OK] 远端配置与本地一致，无需部署。"
  exit 0
fi
echo ""

if [ -n "$DRY_RUN" ]; then
  echo "[DRY-RUN] 以上为远端 → 本地 的差异（- 远端 / + 本地）。不执行任何改动。"
  exit 0
fi

# ---------- apply：备份 → 上传 → 校验 → reload ----------
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_PATH="/etc/nginx/backups/philochora.conf.${TIMESTAMP}.bak"

echo "[1/4] 备份远端配置 → $BACKUP_PATH"
ssh_cmd "mkdir -p /etc/nginx/backups && cp -a $REMOTE_PATH $BACKUP_PATH"

echo "[2/4] 上传本地配置"
scp "${SCP_OPTS[@]}" "$LOCAL_CONF" "$REMOTE:${REMOTE_PATH}.new"
ssh_cmd "mv ${REMOTE_PATH}.new $REMOTE_PATH"

echo "[3/4] nginx -t 语法校验"
if ! ssh_cmd "nginx -t"; then
  echo "[ERROR] nginx -t 失败，回滚备份..." >&2
  ssh_cmd "cp -a $BACKUP_PATH $REMOTE_PATH && nginx -t && systemctl reload nginx"
  echo "[ROLLBACK] 已恢复 $BACKUP_PATH，远端未受影响。"
  exit 1
fi

echo "[4/4] reload（不中断连接）"
ssh_cmd "systemctl reload nginx"

# ---------- 穿透验证 ----------
echo ""
echo "穿透验证（期望：非 nginx-403 拦截页）："
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$PUBLIC_URL/api/server-providers" || echo '000')"
if [ "$HTTP_CODE" = "403" ]; then
  BODY="$(curl -s -m 20 "$PUBLIC_URL/api/server-providers" || true)"
  if echo "$BODY" | grep -qi '<center>nginx</center>'; then
    echo "[FAIL] server-providers 仍被 nginx 拦截（403），请检查配置。" >&2
    exit 1
  fi
fi
echo "[OK] /api/server-providers HTTP $HTTP_CODE（401=到达应用层等待鉴权，属预期）"

HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$PUBLIC_URL/api/health" || echo '000')"
if [ "$HEALTH_CODE" = "200" ]; then
  echo "[OK] /api/health HTTP 200"
else
  echo "[WARN] /api/health HTTP $HEALTH_CODE（非 200，请人工确认）"
fi

echo ""
echo "部署完成。备份位置: $BACKUP_PATH"
