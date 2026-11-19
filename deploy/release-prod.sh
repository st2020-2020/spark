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
  rollback    Restore previous Web, Worker/API image, and Compose config from backup

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
  --skip-web               Skip Web build and static swap
  --verify-restore         Test pg_restore into a unique temporary scratch DB
  --health-timeout <sec>   Bounded healthcheck timeout in seconds (default: 60)
  --backup-dir <dir>       Completed backup under deploy-dir/backups (required for rollback)
  --dry-run                Run preflight + local immutable build only (deploy)
  -h, --help               Show this help
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
    log "Deployment failed (exit=$rc). Triggering automatic rollback from $PREV_BACKUP_DIR"
    run_rollback "$PREV_BACKUP_DIR" || log "WARNING: automatic rollback encountered an error; inspect target immediately!"
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
  if [[ "$MODE" == "ssh" || "$PROJECT" == "spark-prod" || -n "$RELEASE_TAG" ]]; then
    [[ "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die "production deploy requires a published --tag vX.Y.Z"
    # The peeled ref exists only for annotated tags. Compare its target before contacting the host.
    tag_target="$(git -C "$REPO_ROOT" ls-remote --exit-code origin "refs/tags/${RELEASE_TAG}^{}")" || die "published annotated release tag missing or origin unavailable"
    [[ "${tag_target%%$'\t'*}" == "$COMMIT" ]] || die "published tag $RELEASE_TAG does not identify --commit"
  fi
  if [[ "$SKIP_WEB" != "true" ]]; then
    require_cmd npm
    require_cmd node
  fi
fi

# --- Target preflight ---
log "Running target preflight checks (mode=$MODE, project=$PROJECT, deploy_dir=$DEPLOY_DIR, with_worker=$WITH_WORKER)"
run_target "$DOCKER_CONTEXT" "$DEPLOY_DIR" "$ENV_FILE" "$WITH_WORKER" <<'REMOTE'
set -euo pipefail
DOCKER_CTX="$1"
DEPLOY_DIR="$2"
ENV_FILE="$3"
WITH_WORKER="$4"

dcmd=(docker)
if [[ -n "$DOCKER_CTX" ]]; then
  dcmd+=(--context "$DOCKER_CTX")
fi

command -v docker >/dev/null 2>&1 || { echo "missing docker on target" >&2; exit 1; }
"${dcmd[@]}" compose version >/dev/null 2>&1 || { echo "missing docker compose on target" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "missing env file: $ENV_FILE" >&2; exit 1; }

mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
case "$mode" in
  600|400) ;;
  *) echo "env file $ENV_FILE permissions must be 0600 or 0400 (got $mode)" >&2; exit 1 ;;
esac

for req_key in SPARK_ORIGIN SPARK_DB_PASSWORD SPARK_SECRET SPARK_ENCRYPTION_KEY; do
  val="$(grep -E "^${req_key}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  [[ -n "$val" ]] || { echo "required env key $req_key is empty or missing in $ENV_FILE" >&2; exit 1; }
done

origin="$(grep -E "^SPARK_ORIGIN=" "$ENV_FILE" | tail -n1 | cut -d= -f2-)"
[[ "$origin" == https://* ]] || { echo "SPARK_ORIGIN must start with https:// (got $origin)" >&2; exit 1; }

ai_enabled="$(grep -E "^SPARK_AI_ENABLED=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
if [[ "$WITH_WORKER" == "true" ]]; then
  [[ "$ai_enabled" == "true" ]] || { echo "--with-worker requires SPARK_AI_ENABLED=true in $ENV_FILE" >&2; exit 1; }
  trial_ids="$(grep -E "^SPARK_AI_TRIAL_USER_IDS=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  [[ -n "$trial_ids" ]] || { echo "--with-worker requires non-empty SPARK_AI_TRIAL_USER_IDS in $ENV_FILE" >&2; exit 1; }
  cfg_path="$(grep -E "^SPARK_AI_CONFIG_HOST_PATH=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  key_path="$(grep -E "^SPARK_AI_GATEWAY_KEY_HOST_PATH=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  [[ -n "$cfg_path" ]] || cfg_path="/etc/spark/ai/routes.json"
  [[ -n "$key_path" ]] || key_path="/etc/spark/ai/gateway-key"
  [[ -f "$cfg_path" ]] || sudo -n test -f "$cfg_path" 2>/dev/null || { echo "AI routes file missing: $cfg_path" >&2; exit 1; }
  [[ -f "$key_path" ]] || sudo -n test -f "$key_path" 2>/dev/null || { echo "AI gateway key file missing: $key_path" >&2; exit 1; }
  key_mode="$(stat -c '%a' "$key_path" 2>/dev/null || stat -f '%Lp' "$key_path" 2>/dev/null || sudo -n stat -c '%a' "$key_path")"
  case "$key_mode" in
    400|440|600|640) ;;
    *) echo "AI gateway key $key_path must not be world-accessible (got $key_mode)" >&2; exit 1 ;;
  esac
else
  if [[ "$ai_enabled" == "true" ]]; then
    echo "SPARK_AI_ENABLED=true in $ENV_FILE without --with-worker; pass --with-worker or set SPARK_AI_ENABLED=false" >&2
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
  log "Executing rollback from backup directory: ${bdir:-<latest>}"
  run_target "$DOCKER_CONTEXT" "$PROJECT" "$DEPLOY_DIR" "$ENV_FILE" "$WEB_DIR" "$API_PORT" "$HEALTH_TIMEOUT" "$bdir" "$WITH_WORKER" "$RELEASE_ID" <<'REMOTE'
set -euo pipefail
DOCKER_CTX="$1"
PROJECT="$2"
DEPLOY_DIR="$3"
ENV_FILE="$4"
WEB_DIR="$5"
API_PORT="$6"
HEALTH_TIMEOUT="$7"
BDIR="$8"
WITH_WORKER="$9"
RELEASE_ID="${10}"

[[ -f "$BDIR/complete" && -s "$BDIR/image.id" && -f "$BDIR/compose.prod.yaml" && -d "$BDIR/server" && -d "$BDIR/web" ]] || { echo "incomplete rollback snapshot" >&2; exit 1; }

dcmd=(docker)
if [[ -n "$DOCKER_CTX" ]]; then
  dcmd+=(--context "$DOCKER_CTX")
fi
dc() {
  SPARK_PROD_API_PORT="$API_PORT" "${dcmd[@]}" compose --env-file "$ENV_FILE" -f "${DEPLOY_DIR}/deploy/compose.prod.yaml" -p "$PROJECT" "$@"
}

# Clean up only staging directories belonging to this release id
if [[ -d "${DEPLOY_DIR}/server.staging-${RELEASE_ID}" ]]; then
  mv "${DEPLOY_DIR}/server.staging-${RELEASE_ID}" "${BDIR}/aborted-server-staging"
fi
if [[ -d "${WEB_DIR}.staging-${RELEASE_ID}" ]]; then
  mv "${WEB_DIR}.staging-${RELEASE_ID}" "${BDIR}/aborted-web-staging"
fi
if [[ -f "${DEPLOY_DIR}/deploy/compose.prod.yaml.staging-${RELEASE_ID}" ]]; then
  mv "${DEPLOY_DIR}/deploy/compose.prod.yaml.staging-${RELEASE_ID}" "${BDIR}/aborted-compose-staging"
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

# 2. Stop worker if container exists
if [[ -f "${DEPLOY_DIR}/deploy/compose.prod.yaml" ]] && "${dcmd[@]}" ps -aq --filter "name=^${PROJECT}-worker-1$" | grep -q .; then
  dc --profile ai stop worker >/dev/null
fi

# 3. Restore compose, server, and per-release image snapshot
if [[ -f "${BDIR}/compose.prod.yaml" ]]; then
  mkdir -p "${DEPLOY_DIR}/deploy"
  cp -a "${BDIR}/compose.prod.yaml" "${DEPLOY_DIR}/deploy/compose.prod.yaml"
fi
if [[ -d "${BDIR}/server" ]]; then
  if [[ -d "${DEPLOY_DIR}/server" ]]; then
    mv "${DEPLOY_DIR}/server" "${BDIR}/failed-server-${RELEASE_ID}"
  fi
  cp -a "${BDIR}/server" "${DEPLOY_DIR}/server"
fi

image_id="$(cat "${BDIR}/image.id")"
"${dcmd[@]}" tag "$image_id" spark-api:prod
{
  dc up -d --no-deps --force-recreate --wait --wait-timeout "$HEALTH_TIMEOUT" api
  api_health="$("${dcmd[@]}" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${PROJECT}-api-1" 2>/dev/null || true)"
  [[ "$api_health" == "healthy" ]] || { echo "rollback api health is '${api_health:-unknown}', expected healthy" >&2; exit 1; }
  echo "rollback api healthy"
}

if [[ -f "${BDIR}/worker.was_running" ]]; then
  if [[ -f "${DEPLOY_DIR}/deploy/compose.prod.yaml" ]]; then
    dc --profile ai up -d --no-deps --force-recreate --wait --wait-timeout "$HEALTH_TIMEOUT" worker
    worker_health="$("${dcmd[@]}" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${PROJECT}-worker-1" 2>/dev/null || true)"
    [[ "$worker_health" == "healthy" ]] || { echo "rollback worker health is '${worker_health:-unknown}', expected healthy" >&2; exit 1; }
    echo "rollback worker healthy"
  fi
fi

if [[ -f "${BDIR}/spark.dump" ]]; then
  echo "DB backup preserved at: ${BDIR}/spark.dump (manual pg_restore required if schema rollback needed)"
fi
REMOTE
}

if [[ "$CMD" == "rollback" ]]; then
  acquire_target_lock
  run_rollback "$BACKUP_DIR_ARG"
  log "Rollback complete."
  exit 0
fi

# --- Deploy: Export immutable commit from trusted trunk and build Web locally ---
STAGING_DIR="$(mktemp -d)"
log "Exporting immutable commit $COMMIT (verified ancestor of $TRUSTED_REF) to staging directory"
git -C "$REPO_ROOT" archive "$COMMIT" | tar -x -C "$STAGING_DIR"

[[ -f "${STAGING_DIR}/deploy/compose.prod.yaml" ]] || die "commit $COMMIT missing deploy/compose.prod.yaml"
[[ -d "${STAGING_DIR}/server" ]] || die "commit $COMMIT missing server/"

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
if [[ -f "${DEPLOY_DIR}/deploy/compose.prod.yaml" ]]; then
  cp -a "${DEPLOY_DIR}/deploy/compose.prod.yaml" "${BDIR}/compose.prod.yaml"
fi
if [[ -d "${DEPLOY_DIR}/server" && -n "$(ls -A "${DEPLOY_DIR}/server" 2>/dev/null)" ]]; then
  cp -a "${DEPLOY_DIR}/server" "${BDIR}/server"
fi
running_api_img="$("${dcmd[@]}" inspect --format '{{.Image}}' "${PROJECT}-api-1" 2>/dev/null || true)"
[[ -n "$running_api_img" && -f "$BDIR/compose.prod.yaml" && -d "$BDIR/server" && -d "$BDIR/web" ]] || { echo "release requires an existing deployment and recoverable artifacts" >&2; exit 1; }
if [[ -n "$running_api_img" ]]; then
  printf '%s\n' "$running_api_img" > "${BDIR}/image.id"
  rollback_tag="spark-api:rollback-${RELEASE_ID}"
  "${dcmd[@]}" tag "$running_api_img" "$rollback_tag"
fi
if [[ "$("${dcmd[@]}" inspect --format '{{.State.Running}}' "${PROJECT}-worker-1" 2>/dev/null || true)" == "true" ]]; then
  touch "${BDIR}/worker.was_running"
fi

{
  dc exec -T postgres pg_isready -t 5 -U spark -d spark >/dev/null
  dc exec -T postgres pg_dump -U spark -Fc spark > "${BDIR}/spark.dump"
  chmod 600 "${BDIR}/spark.dump"
  [[ -s "${BDIR}/spark.dump" ]] || { echo "pg_dump produced empty backup" >&2; exit 1; }
  dc exec -T postgres pg_restore --list < "${BDIR}/spark.dump" >/dev/null
  echo "verified pg_dump TOC (${BDIR}/spark.dump)"
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
log "Syncing server/, deploy/compose.prod.yaml, and staged Web to target"
sync_dir_to_empty_target "${STAGING_DIR}/server/" "${DEPLOY_DIR}/server.staging-${RELEASE_ID}/" --exclude='.env' --exclude='.local' --exclude='bin'
sync_file_to_target "${STAGING_DIR}/deploy/compose.prod.yaml" "${DEPLOY_DIR}/deploy/compose.prod.yaml.staging-${RELEASE_ID}"
if [[ "$SKIP_WEB" != "true" ]]; then
  sync_dir_to_empty_target "${STAGING_DIR}/apps/web/dist/" "${WEB_DIR}.staging-${RELEASE_ID}/"
fi

log "Building spark-api:prod, checking v3 DB readiness, and bringing up services"
run_target "$DOCKER_CONTEXT" "$PROJECT" "$DEPLOY_DIR" "$ENV_FILE" "$WEB_DIR" "$API_PORT" "$WITH_WORKER" "$SKIP_WEB" "$RELEASE_ID" "$HEALTH_TIMEOUT" "$GOPROXY_ARG" "$PREV_BACKUP_DIR" <<'REMOTE'
set -euo pipefail
DOCKER_CTX="$1"
PROJECT="$2"
DEPLOY_DIR="$3"
ENV_FILE="$4"
WEB_DIR="$5"
API_PORT="$6"
WITH_WORKER="$7"
SKIP_WEB="$8"
RELEASE_ID="$9"
HEALTH_TIMEOUT="${10}"
GOPROXY_ARG="${11}"
BDIR="${12}"

dcmd=(docker)
if [[ -n "$DOCKER_CTX" ]]; then
  dcmd+=(--context "$DOCKER_CTX")
fi
dc() {
  SPARK_PROD_API_PORT="$API_PORT" "${dcmd[@]}" compose --env-file "$ENV_FILE" -f "${DEPLOY_DIR}/deploy/compose.prod.yaml" -p "$PROJECT" "$@"
}

# Swap staged server/ and compose.prod.yaml (original already copied into $BDIR)
if [[ -d "${DEPLOY_DIR}/server" ]]; then
  mv "${DEPLOY_DIR}/server" "${BDIR}/prev-server-live"
fi
mv "${DEPLOY_DIR}/server.staging-${RELEASE_ID}" "${DEPLOY_DIR}/server"
rm -rf "${BDIR}/prev-server-live"
mv "${DEPLOY_DIR}/deploy/compose.prod.yaml.staging-${RELEASE_ID}" "${DEPLOY_DIR}/deploy/compose.prod.yaml"


if [[ -n "$GOPROXY_ARG" ]]; then
  dc build --build-arg "GOPROXY=${GOPROXY_ARG}" api
else
  dc build api
fi

# Stop worker gracefully before recreating API (if container exists)
if "${dcmd[@]}" ps -aq --filter "name=^${PROJECT}-worker-1$" | grep -q .; then
  dc --profile ai stop worker
fi

# T11 expects existing schema v3 (no auto-init or migration upgrade in release-prod.sh)
expected_version="$(sed -n 's/^const Version = \([0-9][0-9]*\).*/\1/p' "${DEPLOY_DIR}/server/db/migrate.go" | head -n1)"
current_version="$(dc exec -T postgres psql -U spark -d spark -tAc "SELECT coalesce(max(version), 0) FROM schema_migrations;" | tr -d '[:space:]')"
[[ -n "$expected_version" && "$current_version" == "$expected_version" ]] || {
  echo "DB schema version (${current_version:-missing}) != expected (${expected_version:-unknown}); T11 requires existing v3 schema" >&2
  exit 1
}
echo "DB schema v${current_version} verified"

# 1. Start/recreate API and wait for bounded healthcheck
dc up -d --no-deps --force-recreate --wait --wait-timeout "$HEALTH_TIMEOUT" api
api_health="$("${dcmd[@]}" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${PROJECT}-api-1" 2>/dev/null || true)"
[[ "$api_health" == "healthy" ]] || { echo "api health is '${api_health:-unknown}', expected healthy" >&2; exit 1; }
echo "api healthy"

curl -fsS --connect-timeout 5 --max-time 10 "http://127.0.0.1:${API_PORT}/api/v1/health/live" >/dev/null
curl -fsS --connect-timeout 5 --max-time 10 "http://127.0.0.1:${API_PORT}/api/v1/health/ready" >/dev/null
echo "loopback live/ready HTTP 200 verified"

# 2. Start worker if requested
if [[ "$WITH_WORKER" == "true" ]]; then
  dc --profile ai up -d --no-deps --force-recreate --wait --wait-timeout "$HEALTH_TIMEOUT" worker
  worker_health="$("${dcmd[@]}" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${PROJECT}-worker-1" 2>/dev/null || true)"
  [[ "$worker_health" == "healthy" ]] || { echo "worker health is '${worker_health:-unknown}', expected healthy" >&2; exit 1; }
  echo "worker healthy"
fi

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

DEPLOY_ROLLBACK_ARMED="false"
log "Deployment succeeded for commit $COMMIT (backup: $PREV_BACKUP_DIR)"
