#!/usr/bin/env bash
set -euo pipefail

# Spark production release & rollback entrypoint.
# Builds strictly from a reviewed 40-hex commit on the trusted trunk (origin/main)
# via `git archive`, enforces target-side mutual exclusion, never uses global
# mutable rollback tags, and never stores or prints production credentials.

usage() {
  cat <<'EOF'
Usage:
  deploy/release-prod.sh <preflight|deploy|rollback> [options]

Commands:
  preflight   Run local and target preflight checks without mutating target
  deploy      Build from --commit, backup, verify, recreate API/Worker, swap Web
  rollback    Restore previous Web and runtime within current capability authorizations

Options:
  --commit <sha40>         Immutable 40-char Git commit SHA on trusted trunk (deploy)
  --tag <vX.Y.Z>           Published annotated release tag for --commit (production deploy)
  --trusted-ref <ref>      Trusted trunk ref for ancestry check (default: origin/main)
  --mode <ssh|local>       Target execution mode (default: ssh)
  --host <user@host>       SSH target host (required for --mode ssh)
  --ssh-key <path>         Optional SSH identity file
  --docker-context <ctx>   Docker context for --mode local (e.g. orbstack)
  --project <name>         Docker Compose project name (default: spark-prod)
  --deploy-dir <dir>       Target deploy root (default: /opt/spark)
  --env-file <path>        Target env file (default: <deploy-dir>/.env)
  --web-dir <dir>          Target static web root (default: <deploy-dir>/web)
  --api-port <port>        Loopback API port on target (default: 8080)
  --health-url <url>       Optional public HTTPS base URL to verify after swap
  --goproxy <url>          Optional GOPROXY build arg for server image build
  --with-worker            Also start/verify AI worker (requires AI preflight)
  --with-oss               Include compose.v0.3-oss.yaml & start/verify asset-worker
  --with-url-extract       Include compose.v0.3-url-extract.yaml & start/verify url-worker
  --with-image-analysis    Include compose.v0.3-image-analysis.yaml & start/verify image-worker (requires --with-oss)
  --with-purge             Include compose.v0.3-purge.yaml (+ purge-oss if --with-oss) & start/verify purge-worker
  --migrate                Allow migration to the schema declared by --commit (e.g. v3 -> v7)
  --restore-db             Manual rollback only: restore spark.dump when rolling back across schema versions
  --skip-web               Skip Web build and static swap
  --verify-restore         Test pg_restore into a unique temporary scratch DB
  --health-timeout <sec>   Bounded healthcheck timeout in seconds (default: 60)
  --backup-dir <dir>       Completed backup under deploy-dir/backups (required for rollback)
  --dry-run                Run preflight + local immutable build only (deploy)
  -h, --help               Show this help

Rollback exits 3 after restoring the runtime with capability differences.
EOF
}

log() {
  printf '[release-prod] %s\n' "$*"
}

die() {
  printf '[release-prod] ERROR: %s\n' "$*" >&2
  exit 1
}

CMD="${1:-}"
if [[ -z "$CMD" || "$CMD" == "-h" || "$CMD" == "--help" ]]; then
  usage
  exit 0
fi
shift

case "$CMD" in
  preflight|deploy|rollback) ;;
  *) die "unknown command: $CMD" ;;
esac

COMMIT=""
RELEASE_TAG=""
TRUSTED_REF="origin/main"
MODE="ssh"
HOST=""
SSH_KEY=""
DOCKER_CONTEXT=""
PROJECT="spark-prod"
DEPLOY_DIR="/opt/spark"
ENV_FILE=""
WEB_DIR=""
API_PORT="8080"
HEALTH_URL=""
GOPROXY_ARG=""
WITH_WORKER="false"
WITH_OSS="false"
WITH_URL_EXTRACT="false"
WITH_IMAGE_ANALYSIS="false"
WITH_PURGE="false"
MIGRATE="false"
RESTORE_DB="false"
SKIP_WEB="false"
VERIFY_RESTORE="false"
HEALTH_TIMEOUT="60"
BACKUP_DIR_ARG=""
DRY_RUN="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit) COMMIT="${2:-}"; shift 2 ;;
    --tag) RELEASE_TAG="${2:-}"; shift 2 ;;
    --trusted-ref) TRUSTED_REF="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --host) HOST="${2:-}"; shift 2 ;;
    --ssh-key) SSH_KEY="${2:-}"; shift 2 ;;
    --docker-context) DOCKER_CONTEXT="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --deploy-dir) DEPLOY_DIR="${2:-}"; shift 2 ;;
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --web-dir) WEB_DIR="${2:-}"; shift 2 ;;
    --api-port) API_PORT="${2:-}"; shift 2 ;;
    --health-url) HEALTH_URL="${2:-}"; shift 2 ;;
    --goproxy) GOPROXY_ARG="${2:-}"; shift 2 ;;
    --with-worker) WITH_WORKER="true"; shift ;;
    --with-oss) WITH_OSS="true"; shift ;;
    --with-url-extract) WITH_URL_EXTRACT="true"; shift ;;
    --with-image-analysis) WITH_IMAGE_ANALYSIS="true"; shift ;;
    --with-purge) WITH_PURGE="true"; shift ;;
    --migrate) MIGRATE="true"; shift ;;
    --restore-db) RESTORE_DB="true"; shift ;;
    --skip-web) SKIP_WEB="true"; shift ;;
    --verify-restore) VERIFY_RESTORE="true"; shift ;;
    --health-timeout) HEALTH_TIMEOUT="${2:-}"; shift 2 ;;
    --backup-dir) BACKUP_DIR_ARG="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

validate_safe_path() {
  local label="$1" p="$2"
  [[ -n "$p" && "$p" == /* ]] || die "$label must be a non-empty absolute path (got: '$p')"
  [[ "$p" =~ ^/[A-Za-z0-9_./-]+$ ]] || die "$label contains unsupported characters"
  case "$p/" in *"/../"*|*"/./"*|*"//"*) die "$label must be canonical" ;; esac
  p="${p%/}"
  case "$p" in
    ""|"/"|"/opt"|"/etc"|"/usr"|"/var"|"/tmp"|"/home"|"/root"|"/Users"|"$HOME")
      die "$label points to unsafe broad directory: $p"
      ;;
  esac
}

[[ "$MODE" == "ssh" || "$MODE" == "local" ]] || die "--mode must be ssh or local"
[[ "$WITH_IMAGE_ANALYSIS" != "true" || "$WITH_OSS" == "true" ]] || die "--with-image-analysis requires --with-oss"
[[ "$MIGRATE" != "true" || "$CMD" == "deploy" ]] || die "--migrate is only valid with deploy"
[[ "$RESTORE_DB" != "true" || "$CMD" == "rollback" ]] || die "--restore-db is only valid with rollback"
[[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ && "$HEALTH_TIMEOUT" -ge 5 ]] || die "--health-timeout must be an integer >= 5"
[[ "$API_PORT" =~ ^[0-9]+$ ]] || die "--api-port must be numeric"
DEPLOY_DIR="${DEPLOY_DIR%/}"
validate_safe_path "--deploy-dir" "$DEPLOY_DIR"
[[ -n "$ENV_FILE" ]] || ENV_FILE="${DEPLOY_DIR}/.env"
[[ -n "$WEB_DIR" ]] || WEB_DIR="${DEPLOY_DIR}/web"
if [[ "$CMD" == "rollback" ]]; then
  [[ -n "$BACKUP_DIR_ARG" && "$(dirname "$BACKUP_DIR_ARG")" == "${DEPLOY_DIR}/backups" ]] || die "rollback requires --backup-dir pointing to a release under $DEPLOY_DIR/backups"
fi
WEB_DIR="${WEB_DIR%/}"
validate_safe_path "--web-dir" "$WEB_DIR"
[[ "$WEB_DIR" == "$DEPLOY_DIR/web" ]] || die "--web-dir must be the web directory under the deployment root"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-${COMMIT:0:7}-$$"
[[ "$CMD" == "deploy" ]] || RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
STAGING_DIR=""
PREV_BACKUP_DIR=""
TARGET_LOCK_HELD="false"
DEPLOY_ROLLBACK_ARMED="false"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required local command: $1"
}

ssh_base_cmd() {
  local parts=(ssh -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10)
  if [[ -n "$SSH_KEY" ]]; then
    parts+=(-i "$SSH_KEY")
  fi
  local out="" part
  for part in "${parts[@]}"; do
    out+="${out:+ }$(printf '%q' "$part")"
  done
  printf '%s' "$out"
}

run_target() {
  local script
  script="$(cat)"
  if [[ "$MODE" == "ssh" ]]; then
    local ssh_opts=(-o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10)
    [[ -z "$SSH_KEY" ]] || ssh_opts+=(-i "$SSH_KEY")
    local cmd="bash -c $(printf '%q' "$script") --"
    local arg
    for arg in "$@"; do
      cmd+=" $(printf '%q' "$arg")"
    done
    ssh "${ssh_opts[@]}" "$HOST" "$cmd" </dev/null
  else
    bash -c "$script" -- "$@" </dev/null
  fi
}

sync_dir_to_empty_target() {
  local src="$1" dst="$2"
  shift 2
  if [[ "$MODE" == "ssh" ]]; then
    local rsh
    rsh="$(ssh_base_cmd)"
    run_target "$dst" <<'REMOTE'
set -euo pipefail
mkdir -p "$1"
REMOTE
    rsync -az "$@" -e "$rsh" "$src" "${HOST}:${dst}" </dev/null
  else
    mkdir -p "$dst"
    rsync -a "$@" "$src" "$dst" </dev/null
  fi
}

sync_file_to_target() {
  local src="$1" dst="$2"
  if [[ "$MODE" == "ssh" ]]; then
    local rsh
    rsh="$(ssh_base_cmd)"
    run_target "$(dirname "$dst")" <<'REMOTE'
set -euo pipefail
mkdir -p "$1"
REMOTE
    rsync -az -e "$rsh" "$src" "${HOST}:${dst}" </dev/null
  else
    mkdir -p "$(dirname "$dst")"
    cp -f "$src" "$dst"
  fi
}

acquire_target_lock() {
  run_target "$DEPLOY_DIR" "$RELEASE_ID" <<'REMOTE'
set -euo pipefail
DEPLOY_DIR="$1"
RELEASE_ID="$2"
mkdir -p "$DEPLOY_DIR"
LOCK_DIR="${DEPLOY_DIR}/.release.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  owner="$(cat "${LOCK_DIR}/owner" 2>/dev/null || echo unknown)"
  echo "another release or rollback is active on ${DEPLOY_DIR} (lock=${LOCK_DIR}, owner=${owner})" >&2
  exit 1
fi
printf 'release_id=%s\npid=%s\nstarted_utc=%s\n' "$RELEASE_ID" "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${LOCK_DIR}/owner"
REMOTE
  TARGET_LOCK_HELD="true"
}

release_target_lock() {
  if [[ "$TARGET_LOCK_HELD" == "true" ]]; then
    run_target "$DEPLOY_DIR" "$RELEASE_ID" <<'REMOTE' || true
set -euo pipefail
LOCK_DIR="${1}/.release.lock"
if [[ -d "$LOCK_DIR" ]] && grep -q "^release_id=${2}$" "${LOCK_DIR}/owner" 2>/dev/null; then
  rm -f "${LOCK_DIR}/owner"
  rmdir "$LOCK_DIR"
fi
REMOTE
    TARGET_LOCK_HELD="false"
  fi
}

cleanup() {
  local rc=$?
  if [[ "$rc" -ne 0 && "$DEPLOY_ROLLBACK_ARMED" == "true" ]]; then
    DEPLOY_ROLLBACK_ARMED="false"
    set +e
    log "Deployment failed (exit=$rc). Checking rollback safety from $PREV_BACKUP_DIR"
    run_rollback "$PREV_BACKUP_DIR" "false" "false"
    local rb_rc=$?
    if [[ "$rb_rc" -eq 2 ]]; then
      rc=2
      log "Automatic cross-version DB rollback refused. Live DB and deletion ledger preserved. Deployment exits 2 for operator recovery."
    elif [[ "$rb_rc" -eq 3 ]]; then
      log "Runtime rollback finished with capability differences. Review the reported disabled capabilities."
    elif [[ "$rb_rc" -ne 0 ]]; then
      log "WARNING: automatic rollback encountered an error (exit=$rb_rc); inspect target immediately!"
    fi
  fi
  if [[ -n "$STAGING_DIR" && -d "$STAGING_DIR" ]]; then
    rm -rf "$STAGING_DIR"
  fi
  release_target_lock
  exit "$rc"
}
trap cleanup EXIT

# --- Local preflight ---
require_cmd git
require_cmd rsync
if [[ "$MODE" == "ssh" ]]; then
  [[ "$HOST" != -* ]] || die "invalid SSH target"
  [[ -n "$HOST" ]] || die "--host is required when --mode ssh"
  [[ "$TRUSTED_REF" == "origin/main" ]] || die "--trusted-ref cannot be overridden in --mode ssh"
  require_cmd ssh
else
  require_cmd docker
fi

if [[ "$CMD" == "deploy" ]]; then
  [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "--commit must be an immutable 40-char lowercase hex SHA (got: '${COMMIT:-<empty>}')"
  git -C "$REPO_ROOT" cat-file -e "${COMMIT}^{commit}" 2>/dev/null || die "commit not found locally: $COMMIT (run git fetch first)"
  git -C "$REPO_ROOT" rev-parse --verify "${TRUSTED_REF}^{commit}" >/dev/null 2>&1 || die "trusted trunk ref not found: $TRUSTED_REF"
  git -C "$REPO_ROOT" merge-base --is-ancestor "$COMMIT" "$TRUSTED_REF" || die "commit $COMMIT is not an ancestor of trusted trunk $TRUSTED_REF"
  [[ "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die "deploy requires a published --tag vX.Y.Z"
  # ls-remote patterns also match ref suffixes. Require the full peeled name and commit on one line.
  peeled_ref="refs/tags/${RELEASE_TAG}^{}"
  tag_refs="$(git -C "$REPO_ROOT" ls-remote --exit-code origin "$peeled_ref")" || die "published annotated release tag missing or origin unavailable"
  grep -Fxq -- "$COMMIT"$'\t'"$peeled_ref" <<< "$tag_refs" || die "published tag $RELEASE_TAG does not identify --commit"
  if [[ "$SKIP_WEB" != "true" ]]; then
    require_cmd npm
    require_cmd node
  fi
fi

# --- Target preflight ---
log "Running target preflight checks (cmd=$CMD, mode=$MODE, project=$PROJECT, deploy_dir=$DEPLOY_DIR, ai=$WITH_WORKER, oss=$WITH_OSS, urls=$WITH_URL_EXTRACT, images=$WITH_IMAGE_ANALYSIS, purge=$WITH_PURGE)"
run_target "$CMD" "$DOCKER_CONTEXT" "$DEPLOY_DIR" "$ENV_FILE" "$WITH_WORKER" "$WITH_OSS" "$WITH_URL_EXTRACT" "$WITH_IMAGE_ANALYSIS" "$WITH_PURGE" <<'REMOTE'
set -euo pipefail
CMD="$1"
DOCKER_CTX="$2"
DEPLOY_DIR="$3"
ENV_FILE="$4"
WITH_WORKER="$5"
WITH_OSS="$6"
WITH_URL_EXTRACT="$7"
WITH_IMAGE_ANALYSIS="$8"
WITH_PURGE="$9"

dcmd=(docker)
if [[ -n "$DOCKER_CTX" ]]; then
  dcmd+=(--context "$DOCKER_CTX")
fi

command -v docker >/dev/null 2>&1 || { echo "missing docker on target" >&2; exit 1; }
"${dcmd[@]}" compose version >/dev/null 2>&1 || { echo "missing docker compose on target" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "missing env file: $ENV_FILE" >&2; exit 1; }

env_val() {
  grep -E "^${1}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true
}

check_file_readable() {
  local label="$1" p="$2"
  [[ -f "$p" ]] || sudo -n test -f "$p" 2>/dev/null || { echo "$label missing: $p" >&2; exit 1; }
}

check_secret_mode() {
  local label="$1" p="$2"
  check_file_readable "$label" "$p"
  local fmode
  fmode="$(stat -c '%a' "$p" 2>/dev/null || stat -f '%Lp' "$p" 2>/dev/null || sudo -n stat -c '%a' "$p")"
  case "$fmode" in
    400|440|600|640) ;;
    *) echo "$label $p must not be world-accessible (got $fmode)" >&2; exit 1 ;;
  esac
}

mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
case "$mode" in
  600|400) ;;
  *) echo "env file $ENV_FILE permissions must be 0600 or 0400 (got $mode)" >&2; exit 1 ;;
esac

for req_key in SPARK_ORIGIN SPARK_DB_PASSWORD SPARK_SECRET SPARK_ENCRYPTION_KEY; do
  val="$(env_val "$req_key")"
  [[ -n "$val" ]] || { echo "required env key $req_key is empty or missing in $ENV_FILE" >&2; exit 1; }
done

origin="$(env_val SPARK_ORIGIN)"
[[ "$origin" == https://* ]] || { echo "SPARK_ORIGIN must start with https:// (got $origin)" >&2; exit 1; }

if [[ "$CMD" != "rollback" ]]; then
  ai_enabled="$(env_val SPARK_AI_ENABLED)"
if [[ "$WITH_WORKER" == "true" ]]; then
  [[ "$ai_enabled" == "true" ]] || { echo "--with-worker requires SPARK_AI_ENABLED=true in $ENV_FILE" >&2; exit 1; }
  trial_ids="$(env_val SPARK_AI_TRIAL_USER_IDS)"
  [[ -n "$trial_ids" ]] || { echo "--with-worker requires non-empty SPARK_AI_TRIAL_USER_IDS in $ENV_FILE" >&2; exit 1; }
  cfg_path="$(env_val SPARK_AI_CONFIG_HOST_PATH)"
  key_path="$(env_val SPARK_AI_GATEWAY_KEY_HOST_PATH)"
  [[ -n "$cfg_path" ]] || cfg_path="/etc/spark/ai/routes.json"
  [[ -n "$key_path" ]] || key_path="/etc/spark/ai/gateway-key"
  check_file_readable "AI routes file" "$cfg_path"
  check_secret_mode "AI gateway key" "$key_path"
elif [[ "$ai_enabled" == "true" ]]; then
  echo "SPARK_AI_ENABLED=true in $ENV_FILE without --with-worker; pass --with-worker or set SPARK_AI_ENABLED=false" >&2
  exit 1
fi

oss_enabled="$(env_val SPARK_OSS_ENABLED)"
if [[ "$WITH_OSS" == "true" ]]; then
  [[ "$oss_enabled" == "true" ]] || { echo "--with-oss requires SPARK_OSS_ENABLED=true in $ENV_FILE" >&2; exit 1; }
  oss_cfg="$(env_val SPARK_OSS_CONFIG_HOST_PATH)"
  oss_cred="$(env_val SPARK_OSS_CREDENTIALS_HOST_PATH)"
  [[ -n "$oss_cfg" ]] || oss_cfg="/etc/spark/oss/config.json"
  [[ -n "$oss_cred" ]] || oss_cred="/etc/spark/oss/credentials.json"
  check_file_readable "OSS config file" "$oss_cfg"
  check_secret_mode "OSS credentials" "$oss_cred"
elif [[ "$oss_enabled" == "true" ]]; then
  echo "SPARK_OSS_ENABLED=true in $ENV_FILE without --with-oss; pass --with-oss or set SPARK_OSS_ENABLED=false" >&2
  exit 1
fi

url_enabled="$(env_val SPARK_URL_EXTRACT_ENABLED)"
if [[ "$WITH_URL_EXTRACT" == "true" ]]; then
  [[ "$url_enabled" == "true" ]] || { echo "--with-url-extract requires SPARK_URL_EXTRACT_ENABLED=true in $ENV_FILE" >&2; exit 1; }
elif [[ "$url_enabled" == "true" ]]; then
  echo "SPARK_URL_EXTRACT_ENABLED=true in $ENV_FILE without --with-url-extract; pass --with-url-extract or set SPARK_URL_EXTRACT_ENABLED=false" >&2
  exit 1
fi

img_enabled="$(env_val SPARK_IMAGE_ANALYSIS_ENABLED)"
if [[ "$WITH_IMAGE_ANALYSIS" == "true" ]]; then
  [[ "$img_enabled" == "true" ]] || { echo "--with-image-analysis requires SPARK_IMAGE_ANALYSIS_ENABLED=true in $ENV_FILE" >&2; exit 1; }
  img_key="$(env_val SPARK_IMAGE_ANALYSIS_KEY_HOST_PATH)"
  [[ -n "$img_key" ]] || img_key="/etc/spark/image-analysis/api-key"
  check_secret_mode "Image analysis API key" "$img_key"
elif [[ "$img_enabled" == "true" ]]; then
  echo "SPARK_IMAGE_ANALYSIS_ENABLED=true in $ENV_FILE without --with-image-analysis; pass --with-image-analysis or set SPARK_IMAGE_ANALYSIS_ENABLED=false" >&2
  exit 1
fi

purge_enabled="$(env_val SPARK_PURGE_ENABLED)"
if [[ "$WITH_PURGE" == "true" ]]; then
  [[ "$purge_enabled" == "true" ]] || { echo "--with-purge requires SPARK_PURGE_ENABLED=true in $ENV_FILE" >&2; exit 1; }
  ledger_dir="$(env_val SPARK_DELETION_LEDGER_HOST_PATH)"
  [[ -n "$ledger_dir" ]] || ledger_dir="/var/lib/spark-deletion-ledger"
  [[ -d "$ledger_dir" ]] || sudo -n test -d "$ledger_dir" 2>/dev/null || { echo "Deletion ledger directory missing: $ledger_dir" >&2; exit 1; }
  ledger_mode="$(stat -c '%a' "$ledger_dir" 2>/dev/null || stat -f '%Lp' "$ledger_dir" 2>/dev/null || sudo -n stat -c '%a' "$ledger_dir")"
  [[ "$ledger_mode" == "700" ]] || { echo "Deletion ledger directory $ledger_dir permissions must be 0700 (got $ledger_mode)" >&2; exit 1; }
elif [[ "$purge_enabled" == "true" ]]; then
  echo "SPARK_PURGE_ENABLED=true in $ENV_FILE without --with-purge; pass --with-purge or set SPARK_PURGE_ENABLED=false" >&2
  exit 1
fi
fi

df_target="$DEPLOY_DIR"
while [[ ! -e "$df_target" && "$df_target" != "/" ]]; do
  df_target="$(dirname "$df_target")"
done
avail_kb="$(df -Pk "$df_target" | awk 'NR==2 {print $4}')"
if [[ -n "$avail_kb" && "$avail_kb" -lt 1048576 ]]; then
  echo "low disk space under $DEPLOY_DIR (<1GB free)" >&2
  exit 1
fi
echo "target preflight ok (avail_kb=${avail_kb:-unknown})"
REMOTE

if [[ "$CMD" == "preflight" ]]; then
  log "Preflight passed."
  exit 0
fi

# --- Rollback helper ---
run_rollback() {
  local bdir="$1"
  local restore_db_arg="${2:-false}"
  local manual_arg="${3:-false}"
  log "Executing rollback from backup directory: ${bdir:-<latest>} (restore_db=$restore_db_arg)"
  run_target "$DOCKER_CONTEXT" "$PROJECT" "$DEPLOY_DIR" "$ENV_FILE" "$WEB_DIR" "$API_PORT" "$HEALTH_TIMEOUT" "$bdir" "$RELEASE_ID" "$restore_db_arg" "$manual_arg" <<'REMOTE'
set -euo pipefail
DOCKER_CTX="$1"
PROJECT="$2"
DEPLOY_DIR="$3"
ENV_FILE="$4"
WEB_DIR="$5"
API_PORT="$6"
HEALTH_TIMEOUT="$7"
BDIR="$8"
RELEASE_ID="$9"
RESTORE_DB="${10}"
MANUAL_ROLLBACK="${11}"
[[ -f "$BDIR/complete" && -s "$BDIR/image.id" && -d "$BDIR/server" && -d "$BDIR/web" ]] || { echo "incomplete rollback snapshot" >&2; exit 1; }
[[ -f "$BDIR/deploy/compose.prod.yaml" || -f "$BDIR/compose.prod.yaml" ]] || { echo "incomplete rollback snapshot: missing compose.prod.yaml" >&2; exit 1; }

dcmd=(docker)
if [[ -n "$DOCKER_CTX" ]]; then
  dcmd+=(--context "$DOCKER_CTX")
fi

# Read-only precheck compose wrapper against postgres before mutating web/, workers, deploy/, or server/
pg_compose_file=""
if [[ -f "${DEPLOY_DIR}/deploy/compose.prod.yaml" ]]; then
  pg_compose_file="${DEPLOY_DIR}/deploy/compose.prod.yaml"
elif [[ -f "${BDIR}/deploy/compose.prod.yaml" ]]; then
  pg_compose_file="${BDIR}/deploy/compose.prod.yaml"
else
  pg_compose_file="${BDIR}/compose.prod.yaml"
fi
pg_dc() {
  SPARK_PROD_API_PORT="$API_PORT" "${dcmd[@]}" compose --env-file "$ENV_FILE" -f "$pg_compose_file" -p "$PROJECT" "$@"
}

# Read-only backup schema resolution: require schema.version or server/db/migrate.go (never assume live_version)
backup_version=""
if [[ -s "${BDIR}/schema.version" ]]; then
  backup_version="$(cat "${BDIR}/schema.version")"
elif [[ -f "${BDIR}/server/db/migrate.go" ]]; then
  backup_version="$(sed -n 's/^const Version = \([0-9][0-9]*\).*/\1/p' "${BDIR}/server/db/migrate.go" | head -n1 | tr -d '[:space:]')"
fi
if [[ ! "$backup_version" =~ ^[0-9]+$ ]]; then
  echo "cannot determine backup schema version from ${BDIR}/schema.version or ${BDIR}/server/db/migrate.go; refusing rollback before modifying target" >&2
  exit 1
fi

live_version="$(pg_dc exec -T postgres psql -U spark -d spark -tAc "SELECT coalesce(max(version), 0) FROM schema_migrations;" | tr -d '[:space:]')"
if [[ ! "$live_version" =~ ^[0-9]+$ ]]; then
  echo "failed to read live DB schema version; refusing rollback before modifying target" >&2
  exit 1
fi

# An online restore starts the old API immediately. It cannot reconcile deletions
# against that database first. Check again after stopping writers to close the race.
require_no_deletions_for_online_restore() {
  (( live_version >= 4 )) || return 0
  local pending mounted configured directory entry
  pending="$(pg_dc exec -T postgres psql -v ON_ERROR_STOP=1 -U spark -d spark -tAc 'SELECT EXISTS (SELECT 1 FROM deletion_ledger)')"
  [[ "$pending" == "f" ]] || { echo "Deletion history requires offline restore and replay before serving traffic." >&2; return 1; }

  mounted="$("${dcmd[@]}" ps -aq --filter "name=^${PROJECT}-purge-worker-1$")"
  if [[ -n "$mounted" ]]; then
    mounted="$("${dcmd[@]}" inspect --format '{{range .Mounts}}{{if eq .Destination "/run/spark-deletion-ledger"}}{{.Source}}{{end}}{{end}}' "$mounted")"
  fi
  configured="$(sed -n 's/^SPARK_DELETION_LEDGER_HOST_PATH=//p' "$ENV_FILE" | tail -n1)"
  for directory in "$mounted" "${configured:-${mounted:-/var/lib/spark-deletion-ledger}}"; do
    [[ -n "$directory" ]] || continue
    if [[ ! -e "$directory" && -z "$mounted" && -z "$configured" ]] && ! grep -qx 'SPARK_PURGE_ENABLED=true' "$ENV_FILE"; then
      continue
    fi
    [[ "$directory" = /* && -d "$directory" ]] || { echo "Cannot verify deletion archive for online restore." >&2; return 1; }
    entry="$(find "$directory/." -maxdepth 1 -name '*.json' -print -quit)" || { echo "Deletion archive inspection failed; use offline recovery." >&2; return 1; }
    [[ -z "$entry" ]] || { echo "Deletion receipts require offline restore and replay before serving traffic." >&2; return 1; }
  done
}

# A lost controller connection can leave migration in progress even while the
# old schema version is still visible. Only a completed pre-start failure is safe.
if [[ "$MANUAL_ROLLBACK" != "true" ]] && {
  [[ "$live_version" != "$backup_version" || -e "$BDIR/migration_started" || -e "$BDIR/live_writes_possible" ]]
}; then
  quiescent=false
  if [[ -e "$BDIR/migration_failed_before_start" && ! -e "$BDIR/live_writes_possible" ]]; then
    services="$("${dcmd[@]}" ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Label "com.docker.compose.service"}}')"
    [[ "$services" == postgres ]] && quiescent=true
  fi
  if [[ "$quiescent" != true ]]; then
    echo "REFUSING automatic cross-version DB rollback. Writer shutdown or migration completion cannot be confirmed." >&2
    echo "Live schema v${live_version}, deletion receipts, and pre-migration snapshot ${BDIR}/spark.dump are preserved." >&2
    echo "Check the active deployment and repair forward. If restoring a backup with deletion history, restore offline and replay receipts before opening traffic (deploy/README.md)." >&2
    exit 2
  fi
fi

if [[ "$live_version" != "$backup_version" ]]; then
  if [[ "$MANUAL_ROLLBACK" == "true" ]]; then
    if [[ "$RESTORE_DB" != "true" ]]; then
      echo "live DB schema v${live_version} != backup schema v${backup_version}; pass --restore-db to restore ${BDIR}/spark.dump (target services, files, and DB were left untouched)" >&2
      exit 1
    fi
    require_no_deletions_for_online_restore
  fi
  [[ -s "${BDIR}/spark.dump" ]] || { echo "missing ${BDIR}/spark.dump for cross-version rollback; refusing before modifying target" >&2; exit 1; }
  pg_dc exec -T postgres pg_restore --list < "${BDIR}/spark.dump" >/dev/null
fi

# Read current authorization with Compose's dotenv parser. The controlled env
# file owns these switches, even if the calling shell exports stale values.
authorizations="$(
  unset SPARK_AI_ENABLED SPARK_OSS_ENABLED SPARK_URL_EXTRACT_ENABLED SPARK_IMAGE_ANALYSIS_ENABLED SPARK_PURGE_ENABLED
  pg_dc config --environment | awk '/^SPARK_(AI|OSS|URL_EXTRACT|IMAGE_ANALYSIS|PURGE)_ENABLED=/'
)"

snapshot_overlays=""
if [[ -f "$BDIR/api.overlays" ]]; then
  snapshot_overlays="$(cat "$BDIR/api.overlays")"
fi
snapshot_ai=false
if grep -qx 'ai=true' <<< "$snapshot_overlays"; then
  snapshot_ai=true
elif ! grep -qx 'ai=false' <<< "$snapshot_overlays" && [[ -f "$BDIR/worker.was_running" ]]; then
  # Older snapshots tracked the text worker without recording the API switch.
  snapshot_ai=true
fi

capability_diff=false
capability_notice() {
  echo "Rollback capability difference: $*" >&2
  capability_diff=true
}

# A capability can return only when its API switch and Worker were active in
# the snapshot and the current operator still authorizes it.
plan_capability() {
  local switch="$1" worker="$2" snapshot="$3" planned="$4" allowed=false
  grep -Fxq "${switch}=true" <<< "$authorizations" && allowed=true
  printf -v "$planned" '%s' false
  if [[ "$snapshot" == true || -f "$BDIR/${worker}.was_running" ]]; then
    if [[ "$allowed" != true ]]; then
      capability_notice "$switch stays off (current authorization disabled)."
    elif [[ "$snapshot" != true || ! -f "$BDIR/${worker}.was_running" ]]; then
      capability_notice "$switch stays off (snapshot has no matching enabled API and running Worker)."
    else
      printf -v "$planned" '%s' true
    fi
  elif [[ "$allowed" == true ]]; then
    capability_notice "$switch stays off (capability absent from snapshot)."
  fi
}

plan_overlay() {
  local switch="$1" worker="$2" overlay="$3" planned="$4" snapshot=false
  grep -Fxq "$overlay" <<< "$snapshot_overlays" && snapshot=true
  plan_capability "$switch" "$worker" "$snapshot" "$planned"
}

plan_capability SPARK_AI_ENABLED worker "$snapshot_ai" RB_AI
plan_overlay SPARK_OSS_ENABLED asset-worker oss RB_OSS
plan_overlay SPARK_URL_EXTRACT_ENABLED url-worker url-extract RB_URL
plan_overlay SPARK_IMAGE_ANALYSIS_ENABLED image-worker image-analysis RB_IMG
plan_overlay SPARK_PURGE_ENABLED purge-worker purge RB_PURGE

if [[ "$RB_OSS" != true ]]; then
  if [[ "$RB_IMG" == true ]]; then
    capability_notice "SPARK_IMAGE_ANALYSIS_ENABLED stays off (OSS unavailable in this rollback)."
    RB_IMG=false
  fi
  if [[ "$RB_PURGE" == true ]] && {
    grep -qx 'oss' <<< "$snapshot_overlays" || grep -qx 'SPARK_OSS_ENABLED=true' <<< "$authorizations"
  }; then
    capability_notice "SPARK_PURGE_ENABLED stays off (OSS-backed cleanup unavailable in this rollback)."
    RB_PURGE=false
  fi
fi

snapshot_compose="${BDIR}/deploy"
compose_files=(-f "${DEPLOY_DIR}/deploy/compose.prod.yaml")
add_overlay() {
  local overlay="compose.v0.3-${1}.yaml"
  [[ -f "$snapshot_compose/$overlay" ]] || { echo "Rollback snapshot missing $overlay" >&2; exit 1; }
  compose_files+=(-f "${DEPLOY_DIR}/deploy/$overlay")
}
if [[ "$RB_OSS" == true ]]; then add_overlay oss; fi
if [[ "$RB_URL" == true ]]; then add_overlay url-extract; fi
if [[ "$RB_IMG" == true ]]; then add_overlay image-analysis; fi
if [[ "$RB_PURGE" == true ]]; then
  add_overlay purge
  if [[ "$RB_OSS" == true ]]; then add_overlay purge-oss; fi
fi

dc() {
  SPARK_PROD_API_PORT="$API_PORT" SPARK_API_IMAGE=spark-api:prod \
    SPARK_AI_ENABLED="$RB_AI" SPARK_OSS_ENABLED="$RB_OSS" SPARK_URL_EXTRACT_ENABLED="$RB_URL" \
    SPARK_IMAGE_ANALYSIS_ENABLED="$RB_IMG" SPARK_PURGE_ENABLED="$RB_PURGE" \
    "${dcmd[@]}" compose --env-file "$ENV_FILE" "${compose_files[@]}" -p "$PROJECT" "$@"
}

# Prechecks passed: clean up staging directories belonging to this release id and execute rollback
if [[ -d "${DEPLOY_DIR}/server.staging-${RELEASE_ID}" ]]; then
  mv "${DEPLOY_DIR}/server.staging-${RELEASE_ID}" "${BDIR}/aborted-server-staging"
fi
if [[ -d "${WEB_DIR}.staging-${RELEASE_ID}" ]]; then
  mv "${WEB_DIR}.staging-${RELEASE_ID}" "${BDIR}/aborted-web-staging"
fi
if [[ -d "${DEPLOY_DIR}/deploy.staging-${RELEASE_ID}" ]]; then
  mv "${DEPLOY_DIR}/deploy.staging-${RELEASE_ID}" "${BDIR}/aborted-deploy-staging"
fi
if [[ -f "${DEPLOY_DIR}/deploy/compose.prod.yaml.staging-${RELEASE_ID}" ]]; then
  mv "${DEPLOY_DIR}/deploy/compose.prod.yaml.staging-${RELEASE_ID}" "${BDIR}/aborted-compose-staging"
fi

stop_running_workers() {
  local svc ids id
  for svc in worker asset-worker url-worker image-worker purge-worker; do
    ids="$("${dcmd[@]}" ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$svc")"
    for id in $ids; do
      "${dcmd[@]}" stop -t 30 "$id" >/dev/null
    done
  done
}

stop_running_api() {
  pg_dc stop -t 15 api
}

if [[ "$MANUAL_ROLLBACK" == "true" && "$live_version" != "$backup_version" ]]; then
  stop_running_workers
  stop_running_api
  require_no_deletions_for_online_restore
fi

# 1. Restore Web first (compatible with older API)
if [[ -d "${BDIR}/web" ]]; then
  cp -a "${BDIR}/web" "${WEB_DIR}.rollback-${RELEASE_ID}"
  if [[ -d "$WEB_DIR" ]]; then
    mv "$WEB_DIR" "${BDIR}/failed-web-${RELEASE_ID}"
  fi
  mv "${WEB_DIR}.rollback-${RELEASE_ID}" "$WEB_DIR"
  echo "restored web from ${BDIR}/web"
fi

# 2. Stop any running workers cleanly before restoring runtime/schema
stop_running_workers

# 3. Restore compose files, server/, and per-release image snapshot
mkdir -p "${DEPLOY_DIR}/deploy"
if [[ -d "${BDIR}/deploy" ]]; then
  rm -f "${DEPLOY_DIR}/deploy"/compose*.yaml
  cp -a "${BDIR}/deploy"/compose*.yaml "${DEPLOY_DIR}/deploy/"
elif [[ -f "${BDIR}/compose.prod.yaml" ]]; then
  cp -a "${BDIR}/compose.prod.yaml" "${DEPLOY_DIR}/deploy/compose.prod.yaml"
fi

if [[ -d "${BDIR}/server" ]]; then
  if [[ -d "${DEPLOY_DIR}/server" ]]; then
    mv "${DEPLOY_DIR}/server" "${BDIR}/failed-server-${RELEASE_ID}"
  fi
  cp -a "${BDIR}/server" "${DEPLOY_DIR}/server"
fi

# 4. Restore DB snapshot when rolling back across schema versions (prechecked above)
if [[ "$live_version" != "$backup_version" ]]; then
  stop_running_api
  if [[ "$MANUAL_ROLLBACK" == "true" ]]; then
    dc exec -T postgres pg_dump -U spark -Fc spark > "${BDIR}/pre-rollback-${RELEASE_ID}.dump"
    chmod 600 "${BDIR}/pre-rollback-${RELEASE_ID}.dump"
    echo "saved pre-rollback safety dump at ${BDIR}/pre-rollback-${RELEASE_ID}.dump"
  fi
  dc exec -T postgres psql -U spark -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='spark' AND pid <> pg_backend_pid();" >/dev/null
  dc exec -T postgres dropdb --if-exists -U spark spark
  dc exec -T postgres createdb -U spark spark
  dc exec -T postgres pg_restore -U spark -d spark < "${BDIR}/spark.dump"
  restored_version="$(dc exec -T postgres psql -U spark -d spark -tAc "SELECT coalesce(max(version), 0) FROM schema_migrations;" | tr -d '[:space:]')"
  [[ "$restored_version" == "$backup_version" ]] || { echo "restored DB schema v${restored_version} != expected v${backup_version}" >&2; exit 1; }
  echo "restored DB schema to v${restored_version} from ${BDIR}/spark.dump"
fi

# 5. Restore API image and recreate API + any previously-running workers
image_id="$(cat "${BDIR}/image.id")"
"${dcmd[@]}" tag "$image_id" spark-api:prod
dc up -d --no-deps --force-recreate --wait --wait-timeout "$HEALTH_TIMEOUT" api
api_health="$("${dcmd[@]}" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${PROJECT}-api-1" 2>/dev/null || true)"
[[ "$api_health" == "healthy" ]] || { echo "rollback api health is '${api_health:-unknown}', expected healthy" >&2; exit 1; }
echo "rollback api healthy"

restore_worker() {
  local enabled="$1" svc="$2" prof="$3" ids id
  if [[ "$enabled" != true ]]; then
    ids="$("${dcmd[@]}" ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$svc")"
    for id in $ids; do
      "${dcmd[@]}" rm "$id" >/dev/null
    done
    return 0
  fi
  if [[ -n "$prof" ]]; then
    dc --profile "$prof" up -d --no-deps --force-recreate --wait --wait-timeout "$HEALTH_TIMEOUT" "$svc"
  else
    dc up -d --no-deps --force-recreate --wait --wait-timeout "$HEALTH_TIMEOUT" "$svc"
  fi
  local wh
  wh="$("${dcmd[@]}" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${PROJECT}-${svc}-1" 2>/dev/null || true)"
  [[ "$wh" == "healthy" ]] || { echo "rollback $svc health is '${wh:-unknown}', expected healthy" >&2; exit 1; }
  echo "rollback $svc healthy"
}

restore_worker "$RB_AI" worker ai
restore_worker "$RB_OSS" asset-worker ""
restore_worker "$RB_URL" url-worker url-extract
restore_worker "$RB_IMG" image-worker image-analysis
restore_worker "$RB_PURGE" purge-worker purge

if [[ "$live_version" == "$backup_version" && -f "${BDIR}/spark.dump" ]]; then
  echo "DB backup preserved at: ${BDIR}/spark.dump (manual pg_restore required if data rollback needed)"
fi

if [[ "$capability_diff" == true ]]; then
  echo "Runtime restored with capability differences. Review the capabilities left off above." >&2
  exit 3
fi
REMOTE
}

if [[ "$CMD" == "rollback" ]]; then
  acquire_target_lock
  run_rollback "$BACKUP_DIR_ARG" "$RESTORE_DB" "true"
  log "Rollback complete."
  exit 0
fi

# --- Deploy: Export immutable commit from trusted trunk and build Web locally ---
STAGING_DIR="$(mktemp -d)"
log "Exporting immutable commit $COMMIT (verified ancestor of $TRUSTED_REF) to staging directory"
git -C "$REPO_ROOT" archive "$COMMIT" | tar -x -C "$STAGING_DIR"

[[ -f "${STAGING_DIR}/deploy/compose.prod.yaml" ]] || die "commit $COMMIT missing deploy/compose.prod.yaml"
[[ -d "${STAGING_DIR}/server" ]] || die "commit $COMMIT missing server/"
EXPECTED_SCHEMA_VERSION="$(sed -n 's/^const Version = \([0-9][0-9]*\)[[:space:]]*$/\1/p' "${STAGING_DIR}/server/db/migrate.go")"
[[ "$EXPECTED_SCHEMA_VERSION" =~ ^[0-9]+$ ]] || die "cannot determine server schema Version from server/db/migrate.go"

if [[ "$WITH_OSS" == "true" && ! -f "${STAGING_DIR}/deploy/compose.v0.3-oss.yaml" ]]; then
  die "commit $COMMIT missing deploy/compose.v0.3-oss.yaml"
fi
if [[ "$WITH_URL_EXTRACT" == "true" && ! -f "${STAGING_DIR}/deploy/compose.v0.3-url-extract.yaml" ]]; then
  die "commit $COMMIT missing deploy/compose.v0.3-url-extract.yaml"
fi
if [[ "$WITH_IMAGE_ANALYSIS" == "true" && ! -f "${STAGING_DIR}/deploy/compose.v0.3-image-analysis.yaml" ]]; then
  die "commit $COMMIT missing deploy/compose.v0.3-image-analysis.yaml"
fi
if [[ "$WITH_PURGE" == "true" && ! -f "${STAGING_DIR}/deploy/compose.v0.3-purge.yaml" ]]; then
  die "commit $COMMIT missing deploy/compose.v0.3-purge.yaml"
fi
if [[ "$WITH_PURGE" == "true" && "$WITH_OSS" == "true" && ! -f "${STAGING_DIR}/deploy/compose.v0.3-purge-oss.yaml" ]]; then
  die "commit $COMMIT missing deploy/compose.v0.3-purge-oss.yaml"
fi

if [[ "$SKIP_WEB" != "true" ]]; then
  log "Building Web static bundle from commit $COMMIT"
  (
    cd "${STAGING_DIR}/apps/web"
    npm ci --no-audit --no-fund
    npm run build
  )
  if grep -rnq "test-adapter\|createTestAdapter" "${STAGING_DIR}/apps/web/dist"; then
    die "production web bundle unexpectedly references test-adapter"
  fi
fi

if [[ "$DRY_RUN" == "true" ]]; then
  log "Dry-run complete: preflight passed and commit $COMMIT built cleanly (no target mutations performed)."
  exit 0
fi

# Check live schema compatibility before acquiring backup/cutover mutation
log "Checking target DB schema version against commit $COMMIT (expected v${EXPECTED_SCHEMA_VERSION}, migrate=${MIGRATE})"
run_target "$DOCKER_CONTEXT" "$PROJECT" "$DEPLOY_DIR" "$ENV_FILE" "$API_PORT" "$EXPECTED_SCHEMA_VERSION" "$MIGRATE" <<'REMOTE'
set -euo pipefail
DOCKER_CTX="$1"
PROJECT="$2"
DEPLOY_DIR="$3"
ENV_FILE="$4"
API_PORT="$5"
EXPECTED_VERSION="$6"
MIGRATE="$7"

dcmd=(docker)
[[ -n "$DOCKER_CTX" ]] && dcmd+=(--context "$DOCKER_CTX")
dc() {
  SPARK_PROD_API_PORT="$API_PORT" "${dcmd[@]}" compose --env-file "$ENV_FILE" -f "${DEPLOY_DIR}/deploy/compose.prod.yaml" -p "$PROJECT" "$@"
}
dc exec -T postgres pg_isready -t 5 -U spark -d spark >/dev/null
current_version="$(dc exec -T postgres psql -U spark -d spark -tAc "SELECT coalesce(max(version), 0) FROM schema_migrations;" | tr -d '[:space:]')"
[[ "$current_version" =~ ^[0-9]+$ ]] || { echo "could not read live schema_migrations version" >&2; exit 1; }
if (( current_version > EXPECTED_VERSION )); then
  echo "live DB schema v${current_version} > release expected v${EXPECTED_VERSION}; refusing implicit downgrade" >&2
  exit 1
fi
if (( current_version < EXPECTED_VERSION )) && [[ "$MIGRATE" != "true" ]]; then
  echo "live DB schema v${current_version} < release expected v${EXPECTED_VERSION}; re-run with --migrate after verifying backups" >&2
  exit 1
fi
echo "target DB schema precheck ok (live=v${current_version}, expected=v${EXPECTED_VERSION})"
REMOTE

# Acquire target mutual exclusion lock for the entire deploy (+ any failure rollback)
acquire_target_lock

# --- Backup target DB and previous runtime artifacts ---
PREV_BACKUP_DIR="${DEPLOY_DIR}/backups/${RELEASE_ID}"
log "Creating pre-release backup at $PREV_BACKUP_DIR"
run_target "$DOCKER_CONTEXT" "$PROJECT" "$DEPLOY_DIR" "$ENV_FILE" "$WEB_DIR" "$API_PORT" "$PREV_BACKUP_DIR" "$VERIFY_RESTORE" "$RELEASE_ID" <<'REMOTE'
set -euo pipefail
DOCKER_CTX="$1"
PROJECT="$2"
DEPLOY_DIR="$3"
ENV_FILE="$4"
WEB_DIR="$5"
API_PORT="$6"
BDIR="$7"
VERIFY_RESTORE="$8"
RELEASE_ID="$9"

dcmd=(docker)
if [[ -n "$DOCKER_CTX" ]]; then
  dcmd+=(--context "$DOCKER_CTX")
fi
dc() {
  SPARK_PROD_API_PORT="$API_PORT" "${dcmd[@]}" compose --env-file "$ENV_FILE" -f "${DEPLOY_DIR}/deploy/compose.prod.yaml" -p "$PROJECT" "$@"
}

mkdir -p -m 700 "${DEPLOY_DIR}/backups"
mkdir -m 700 "$BDIR"
mkdir -p "${DEPLOY_DIR}/deploy" "${DEPLOY_DIR}/server"

if [[ -d "$WEB_DIR" ]]; then
  cp -a "$WEB_DIR" "${BDIR}/web"
fi
mkdir -p "${BDIR}/deploy"
for cf in "${DEPLOY_DIR}/deploy"/compose*.yaml; do
  [[ -e "$cf" ]] && cp -a "$cf" "${BDIR}/deploy/"
done
if [[ -f "${DEPLOY_DIR}/deploy/compose.prod.yaml" ]]; then
  cp -a "${DEPLOY_DIR}/deploy/compose.prod.yaml" "${BDIR}/compose.prod.yaml"
fi
if [[ -d "${DEPLOY_DIR}/server" && -n "$(ls -A "${DEPLOY_DIR}/server" 2>/dev/null)" ]]; then
  cp -a "${DEPLOY_DIR}/server" "${BDIR}/server"
fi
running_api_img="$("${dcmd[@]}" inspect --format '{{.Image}}' "${PROJECT}-api-1" 2>/dev/null || true)"
[[ -n "$running_api_img" && -f "${BDIR}/compose.prod.yaml" && -d "${BDIR}/server" && -d "${BDIR}/web" ]] || { echo "release requires an existing deployment and recoverable artifacts" >&2; exit 1; }
printf '%s\n' "$running_api_img" > "${BDIR}/image.id"
rollback_tag="spark-api:rollback-${RELEASE_ID}"
"${dcmd[@]}" tag "$running_api_img" "$rollback_tag"

# Record running workers and non-secret API feature switches for rollback
for svc in worker asset-worker url-worker image-worker purge-worker; do
  if [[ "$("${dcmd[@]}" inspect --format '{{.State.Running}}' "${PROJECT}-${svc}-1" 2>/dev/null || true)" == "true" ]]; then
    touch "${BDIR}/${svc}.was_running"
  fi
done
: > "${BDIR}/api.overlays"
api_env="$("${dcmd[@]}" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${PROJECT}-api-1" |
  awk '/^SPARK_(AI|OSS|URL_EXTRACT|IMAGE_ANALYSIS|PURGE)_ENABLED=/')"
if grep -qx "SPARK_AI_ENABLED=true" <<< "$api_env"; then
  echo "ai=true" >> "${BDIR}/api.overlays"
else
  echo "ai=false" >> "${BDIR}/api.overlays"
fi
grep -qx "SPARK_OSS_ENABLED=true" <<< "$api_env" && echo "oss" >> "${BDIR}/api.overlays" || true
grep -qx "SPARK_URL_EXTRACT_ENABLED=true" <<< "$api_env" && echo "url-extract" >> "${BDIR}/api.overlays" || true
grep -qx "SPARK_IMAGE_ANALYSIS_ENABLED=true" <<< "$api_env" && echo "image-analysis" >> "${BDIR}/api.overlays" || true
grep -qx "SPARK_PURGE_ENABLED=true" <<< "$api_env" && echo "purge" >> "${BDIR}/api.overlays" || true

{
  dc exec -T postgres pg_isready -t 5 -U spark -d spark >/dev/null
  dc exec -T postgres psql -U spark -d spark -tAc "SELECT coalesce(max(version), 0) FROM schema_migrations;" | tr -d '[:space:]' > "${BDIR}/schema.version"
  dc exec -T postgres pg_dump -U spark -Fc spark > "${BDIR}/spark.dump"
  chmod 600 "${BDIR}/spark.dump"
  [[ -s "${BDIR}/spark.dump" ]] || { echo "pg_dump produced empty backup" >&2; exit 1; }
  dc exec -T postgres pg_restore --list < "${BDIR}/spark.dump" >/dev/null
  echo "verified pg_dump TOC (${BDIR}/spark.dump, schema v$(cat "${BDIR}/schema.version"))"
  if [[ "$VERIFY_RESTORE" == "true" ]]; then
    safe_suffix="$(printf '%s' "$RELEASE_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_')"
    verify_db="spark_restore_verify_${safe_suffix}"
    cleanup_verify_db() {
      dc exec -T postgres dropdb --if-exists -U spark "$verify_db" >/dev/null 2>&1 || true
    }
    dc exec -T postgres createdb -U spark "$verify_db"
    trap cleanup_verify_db EXIT
    dc exec -T postgres pg_restore -U spark -d "$verify_db" < "${BDIR}/spark.dump"
    dc exec -T postgres psql -U spark -d "$verify_db" -tAc "SELECT coalesce(max(version),0) FROM schema_migrations;" >/dev/null
    cleanup_verify_db
    trap - EXIT
    echo "verified full scratch pg_restore ($verify_db)"
  fi
}
touch "$BDIR/complete"
REMOTE

# Arm automatic rollback (handled in EXIT trap) before any upload or live target mutation
DEPLOY_ROLLBACK_ARMED="true"

# --- Sync release artifacts into empty release-scoped staging dirs ---
log "Syncing server/, deploy/compose*.yaml, and staged Web to target"
sync_dir_to_empty_target "${STAGING_DIR}/server/" "${DEPLOY_DIR}/server.staging-${RELEASE_ID}/" --exclude='.env' --exclude='.local' --exclude='bin'
sync_dir_to_empty_target "${STAGING_DIR}/deploy/" "${DEPLOY_DIR}/deploy.staging-${RELEASE_ID}/" --include='compose*.yaml' --exclude='*'
if [[ "$SKIP_WEB" != "true" ]]; then
  sync_dir_to_empty_target "${STAGING_DIR}/apps/web/dist/" "${WEB_DIR}.staging-${RELEASE_ID}/"
fi

log "Building spark-api:prod, checking/migrating DB schema, and bringing up services"
run_target "$DOCKER_CONTEXT" "$PROJECT" "$DEPLOY_DIR" "$ENV_FILE" "$WEB_DIR" "$API_PORT" "$WITH_WORKER" "$WITH_OSS" "$WITH_URL_EXTRACT" "$WITH_IMAGE_ANALYSIS" "$WITH_PURGE" "$MIGRATE" "$SKIP_WEB" "$VERIFY_RESTORE" "$RELEASE_ID" "$HEALTH_TIMEOUT" "$GOPROXY_ARG" "$PREV_BACKUP_DIR" "$EXPECTED_SCHEMA_VERSION" <<'REMOTE'
set -euo pipefail
DOCKER_CTX="$1"
PROJECT="$2"
DEPLOY_DIR="$3"
ENV_FILE="$4"
WEB_DIR="$5"
API_PORT="$6"
WITH_WORKER="$7"
WITH_OSS="$8"
WITH_URL_EXTRACT="$9"
WITH_IMAGE_ANALYSIS="${10}"
WITH_PURGE="${11}"
MIGRATE="${12}"
SKIP_WEB="${13}"
VERIFY_RESTORE="${14}"
RELEASE_ID="${15}"
HEALTH_TIMEOUT="${16}"
GOPROXY_ARG="${17}"
BDIR="${18}"
expected_version="${19}"

dcmd=(docker)
if [[ -n "$DOCKER_CTX" ]]; then
  dcmd+=(--context "$DOCKER_CTX")
fi

compose_files=(-f "${DEPLOY_DIR}/deploy/compose.prod.yaml")
[[ "$WITH_OSS" == "true" ]] && compose_files+=(-f "${DEPLOY_DIR}/deploy/compose.v0.3-oss.yaml")
[[ "$WITH_URL_EXTRACT" == "true" ]] && compose_files+=(-f "${DEPLOY_DIR}/deploy/compose.v0.3-url-extract.yaml")
[[ "$WITH_IMAGE_ANALYSIS" == "true" ]] && compose_files+=(-f "${DEPLOY_DIR}/deploy/compose.v0.3-image-analysis.yaml")
if [[ "$WITH_PURGE" == "true" ]]; then
  compose_files+=(-f "${DEPLOY_DIR}/deploy/compose.v0.3-purge.yaml")
  [[ "$WITH_OSS" == "true" ]] && compose_files+=(-f "${DEPLOY_DIR}/deploy/compose.v0.3-purge-oss.yaml")
fi

dc() {
  SPARK_PROD_API_PORT="$API_PORT" "${dcmd[@]}" compose --env-file "$ENV_FILE" "${compose_files[@]}" -p "$PROJECT" "$@"
}

stop_running_workers() {
  local svc ids id
  for svc in worker asset-worker url-worker image-worker purge-worker; do
    ids="$("${dcmd[@]}" ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$svc")"
    for id in $ids; do
      "${dcmd[@]}" stop -t 30 "$id" >/dev/null
    done
  done
}

# Swap staged server/ and deploy/compose*.yaml (originals already backed up into $BDIR)
if [[ -d "${DEPLOY_DIR}/server" ]]; then
  mv "${DEPLOY_DIR}/server" "${BDIR}/prev-server-live"
fi
mv "${DEPLOY_DIR}/server.staging-${RELEASE_ID}" "${DEPLOY_DIR}/server"
rm -rf "${BDIR}/prev-server-live"

rm -f "${DEPLOY_DIR}/deploy"/compose*.yaml
mv "${DEPLOY_DIR}/deploy.staging-${RELEASE_ID}"/compose*.yaml "${DEPLOY_DIR}/deploy/"
rmdir "${DEPLOY_DIR}/deploy.staging-${RELEASE_ID}"

if [[ -n "$GOPROXY_ARG" ]]; then
  dc build --build-arg "GOPROXY=${GOPROXY_ARG}" api
else
  dc build api
fi

# Stop any running workers gracefully before schema migration or API replacement
stop_running_workers

# Verify or explicitly upgrade DB schema
current_version="$(dc exec -T postgres psql -U spark -d spark -tAc "SELECT coalesce(max(version), 0) FROM schema_migrations;" | tr -d '[:space:]')"
[[ "$current_version" =~ ^[0-9]+$ ]] || { echo "could not read live schema_migrations version" >&2; exit 1; }
if (( current_version > expected_version )); then
  echo "DB schema version (${current_version}) > expected (${expected_version}); refusing downgrade" >&2
  exit 1
fi
if (( current_version < expected_version )); then
  [[ "$MIGRATE" == "true" ]] || {
    echo "DB schema version (${current_version}) != expected (${expected_version}); apply migration or pass --migrate" >&2
    exit 1
  }
  echo "Stopping API for quiescent pg_dump and explicit schema migration (v${current_version} -> v${expected_version})"
  dc stop -t 15 api
  dc exec -T postgres pg_dump -U spark -Fc spark > "${BDIR}/spark.dump.pending"
  chmod 600 "${BDIR}/spark.dump.pending"
  [[ -s "${BDIR}/spark.dump.pending" ]] || { echo "quiescent pg_dump produced empty backup" >&2; exit 1; }
  dc exec -T postgres pg_restore --list < "${BDIR}/spark.dump.pending" >/dev/null
  if [[ "$VERIFY_RESTORE" == "true" ]]; then
    safe_suffix="$(printf '%s' "$RELEASE_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_')_q"
    verify_db="spark_restore_verify_${safe_suffix}"
    cleanup_q_db() { dc exec -T postgres dropdb --if-exists -U spark "$verify_db" >/dev/null 2>&1 || true; }
    dc exec -T postgres createdb -U spark "$verify_db"
    trap cleanup_q_db EXIT
    dc exec -T postgres pg_restore -U spark -d "$verify_db" < "${BDIR}/spark.dump.pending"
    cleanup_q_db
    trap - EXIT
  fi
  mv "${BDIR}/spark.dump.pending" "${BDIR}/spark.dump"
  # Only the target process can confirm it exited before starting a writer.
  # A lost SSH response while migration is still running is insufficient.
  touch "${BDIR}/migration_started"
  trap 'touch "${BDIR}/migration_failed_before_start"' EXIT
  dc run --rm -T tools migrate
  current_version="$(dc exec -T postgres psql -U spark -d spark -tAc "SELECT coalesce(max(version), 0) FROM schema_migrations;" | tr -d '[:space:]')"
  [[ "$current_version" == "$expected_version" ]] || { echo "post-migrate schema version (${current_version}) != expected (${expected_version})" >&2; exit 1; }
  trap - EXIT
  touch "${BDIR}/live_writes_possible"
  echo "migrated DB schema to v${current_version}"
else
  echo "DB schema v${current_version} verified"
fi

# 1. Start/recreate API and wait for bounded healthcheck
dc up -d --no-deps --force-recreate --wait --wait-timeout "$HEALTH_TIMEOUT" api
api_health="$("${dcmd[@]}" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${PROJECT}-api-1" 2>/dev/null || true)"
[[ "$api_health" == "healthy" ]] || { echo "api health is '${api_health:-unknown}', expected healthy" >&2; exit 1; }
echo "api healthy"

curl -fsS --connect-timeout 5 --max-time 10 "http://127.0.0.1:${API_PORT}/api/v1/health/live" >/dev/null
curl -fsS --connect-timeout 5 --max-time 10 "http://127.0.0.1:${API_PORT}/api/v1/health/ready" >/dev/null
echo "loopback live/ready HTTP 200 verified"

# 2. Start and verify enabled optional workers
start_worker() {
  local enabled="$1" svc="$2" prof="$3"
  [[ "$enabled" == "true" ]] || return 0
  if [[ -n "$prof" ]]; then
    dc --profile "$prof" up -d --no-deps --force-recreate --wait --wait-timeout "$HEALTH_TIMEOUT" "$svc"
  else
    dc up -d --no-deps --force-recreate --wait --wait-timeout "$HEALTH_TIMEOUT" "$svc"
  fi
  local wh
  wh="$("${dcmd[@]}" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${PROJECT}-${svc}-1" 2>/dev/null || true)"
  [[ "$wh" == "healthy" ]] || { echo "$svc health is '${wh:-unknown}', expected healthy" >&2; exit 1; }
  echo "$svc healthy"
}

start_worker "$WITH_WORKER" worker ai
start_worker "$WITH_OSS" asset-worker ""
start_worker "$WITH_URL_EXTRACT" url-worker url-extract
start_worker "$WITH_IMAGE_ANALYSIS" image-worker image-analysis
start_worker "$WITH_PURGE" purge-worker purge

# 3. Preserve immediately preceding hashed assets (for in-flight browser tabs) & swap Web
if [[ "$SKIP_WEB" != "true" ]]; then
  if [[ -f "${BDIR}/web/index.html" && -d "${BDIR}/web/assets" ]]; then
    mkdir -p "${WEB_DIR}.staging-${RELEASE_ID}/assets"
    for ref in $(grep -oE 'assets/[A-Za-z0-9._-]+' "${BDIR}/web/index.html" | sort -u || true); do
      if [[ -f "${BDIR}/web/${ref}" && ! -e "${WEB_DIR}.staging-${RELEASE_ID}/${ref}" ]]; then
        cp -a "${BDIR}/web/${ref}" "${WEB_DIR}.staging-${RELEASE_ID}/${ref}"
      fi
    done
  fi
  if [[ -d "$WEB_DIR" ]]; then
    mv "$WEB_DIR" "${BDIR}/prev-web-live"
  fi
  mv "${WEB_DIR}.staging-${RELEASE_ID}" "$WEB_DIR"
  rm -rf "${BDIR}/prev-web-live"
  echo "swapped static web root at $WEB_DIR"
fi
REMOTE

if [[ -n "$HEALTH_URL" ]]; then
  log "Checking public health URL: $HEALTH_URL"
  deadline=$((SECONDS + HEALTH_TIMEOUT))
  public_ok() {
    local remaining=$((deadline - SECONDS)) code
    ((remaining > 0)) || return 1
    code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --connect-timeout 5 --max-time "$remaining" "$1")" && [[ "$code" == "200" ]]
  }
  ok="false"
  while ((SECONDS < deadline)); do
    if public_ok "${HEALTH_URL%/}/api/v1/health/ready" && { [[ "$SKIP_WEB" == "true" ]] || public_ok "${HEALTH_URL%/}/"; }; then
      log "Public endpoint check passed"
      ok="true"
      break
    fi
    sleep 1
  done
  if [[ "$ok" != "true" ]]; then
    log "Public endpoint check failed within ${HEALTH_TIMEOUT}s"
    exit 1
  fi
fi

# Check target markers to avoid leaving cutover/write markers armed after successful deploy
run_target "$PREV_BACKUP_DIR" <<'REMOTE'
set -euo pipefail
if [[ -f "${1}/live_writes_possible" ]]; then
  mv "${1}/live_writes_possible" "${1}/migrated"
fi
REMOTE
DEPLOY_ROLLBACK_ARMED="false"
log "Deployment succeeded for commit $COMMIT (backup: $PREV_BACKUP_DIR)"
