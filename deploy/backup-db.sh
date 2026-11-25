#!/usr/bin/env bash
set -euo pipefail
umask 077
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/ledger-settings.sh"

usage() {
  cat <<'EOF'
Usage:
  backup-db.sh backup <source-project> <recipient-file> <private-output-dir> [source-database]
  backup-db.sh restore <spark-restore-project> <encrypted-dump> <recovery-keyring-dir> <recovery-env-file>

Use DOCKER_CONTEXT to select a Docker context. Backup is read-only and defaults
to the spark database. For optional off-host upload, set SPARK_BACKUP_REMOTE
and SPARK_BACKUP_RCLONE_CONFIG to an authorized remote prefix and private config.
Restore requires an empty project started with
compose.recovery.yaml. A schema v8+ restore also requires the matching tool
image loaded on the recovery host. OSS ledger restores verify the known probe
with a read-only identity before import and replay receipts before finishing.
EOF
}

die() { printf 'backup-db: %s\n' "$*" >&2; exit 1; }
file_mode() { stat -c %a -- "$1" 2>/dev/null || stat -f %Lp -- "$1"; }

[[ $# -gt 0 ]] || { usage >&2; exit 2; }
command="$1"
shift
if [[ "$command" == -h || "$command" == --help ]]; then usage; exit 0; fi
command -v docker >/dev/null || die "docker is required"
command -v gpg >/dev/null || die "gpg is required"
scratch=
trap '[[ -z "$scratch" ]] || rm -rf -- "$scratch"' EXIT

project="${1:-}"
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "invalid Compose project"

postgres_container() {
  local container
  container="$(docker ps -q --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=postgres")" || return 1
  [[ "$container" =~ ^[a-f0-9]+$ ]] || return 1
  printf '%s\n' "$container"
}

case "$command" in
  backup)
    [[ $# == 3 || $# == 4 ]] || { usage >&2; exit 2; }
    recipient="$2"
    output_dir="$3"
    database="${4:-spark}"
    [[ "$database" =~ ^[a-z][a-z0-9_]*$ ]] || die "invalid PostgreSQL database name"
    [[ -f "$recipient" && -s "$recipient" ]] || die "backup public recipient file is required"
    [[ -d "$output_dir" && ! -L "$output_dir" ]] || die "backup output directory must already exist"
    dir_mode="$(file_mode "$output_dir")"
    [[ "$dir_mode" == 700 ]] || die "backup output directory must have mode 0700"
    remote="${SPARK_BACKUP_REMOTE:-}"
    remote_config="${SPARK_BACKUP_RCLONE_CONFIG:-}"
    if [[ -n "$remote" || -n "$remote_config" ]]; then
      command -v rclone >/dev/null || die "rclone is required for off-host backup"
      [[ "$remote" =~ ^[A-Za-z0-9_-]+:[^:]+$ && -f "$remote_config" && ! -L "$remote_config" ]] ||
        die "configure an authorized rclone remote prefix and config file"
      config_mode="$(file_mode "$remote_config")"
      [[ "$config_mode" == 600 || "$config_mode" == 400 ]] || die "rclone config must have mode 0600 or 0400"
    fi
    postgres="$(postgres_container)" || die "expected exactly one running PostgreSQL container for source project"
    scratch="$(mktemp -d "${output_dir%/}/.spark-backup.XXXXXXXX")"
    mkdir -m 0700 "$scratch/keyring"
    snapshot_time="$(date -u +%Y%m%dT%H%M%SZ)"
    encrypted="$scratch/spark.dump.gpg"
    if ! docker exec "$postgres" pg_dump --format=custom --lock-wait-timeout=5s -U spark -d "$database" 2>/dev/null |
      gpg --homedir "$scratch/keyring" --batch --no-tty --recipient-file "$recipient" \
        --encrypt --output "$encrypted" 2>/dev/null; then
      die "database dump or encryption failed"
    fi
    [[ -s "$encrypted" ]] || die "encrypted dump is empty"
    chmod 0600 "$encrypted"
    archive="${output_dir%/}/spark-$snapshot_time-${scratch##*.}.dump.gpg"
    ln -- "$encrypted" "$archive" || die "could not publish a new encrypted backup without overwriting"
    printf '%s\n' "$archive"
    if [[ -n "$remote" ]]; then
      rclone --config "$remote_config" copyto --immutable --s3-no-check-bucket \
        "$archive" "${remote%/}/${archive##*/}" >/dev/null 2>&1 ||
        die "off-host upload failed, encrypted local archive retained"
      printf 'Off-host upload complete.\n' >&2
    fi
    ;;
  restore)
    [[ $# == 4 ]] || { usage >&2; exit 2; }
    [[ "$project" =~ ^spark-restore-[a-z0-9][a-z0-9_-]*$ ]] || die "restore requires a dedicated spark-restore-* project"
    archive="$2"
    keyring="$3"
    env_file="$4"
    [[ -f "$archive" && -s "$archive" && -d "$keyring" && -f "$env_file" ]] ||
      die "encrypted backup, recovery keyring and recovery env file are required"
    env_mode="$(file_mode "$env_file")"
    [[ "$env_mode" == 600 || "$env_mode" == 400 ]] || die "recovery env file must have mode 0600 or 0400"
    [[ "$(file_mode "$keyring")" == 700 ]] || die "recovery keyring must have mode 0700"
    postgres="$(postgres_container)" || die "expected exactly one running PostgreSQL container for recovery project"
    network="${project}_offline"
    [[ "$(docker network inspect -f '{{.Internal}} {{len .Containers}}' "$network")" == 'true 1' &&
       "$(docker inspect -f '{{.HostConfig.NetworkMode}} {{len .HostConfig.PortBindings}}' "$postgres")" == "$network 0" ]] ||
      die "restore requires the dedicated internal network with only PostgreSQL and no published ports"
    psql() { docker exec -i "$postgres" psql --no-psqlrc -U spark -d spark -v ON_ERROR_STOP=1 "$@"; }
    [[ "$(psql -Atqc "SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('information_schema','public'))
      AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')")" == t ]] ||
      die "recovery database is not empty"

    ledger_env="$(read_ledger_environment "$env_file" docker)" || die "could not resolve ledger settings"
    ledger_backend="$(ledger_val SPARK_DELETION_LEDGER_BACKEND)"
    binding="$(ledger_val SPARK_DELETION_LEDGER_OSS_BINDING_HOST_PATH)"
    recovery_compose=(-f "$script_dir/compose.recovery.yaml")
    case "${ledger_backend:-file}" in
      oss)
        [[ "$binding" = /* ]] && read_oss_ledger_binding "$binding" ||
          die "restore requires the verified OSS binding from the deployment"
        ledger_config="$(ledger_val SPARK_DELETION_LEDGER_OSS_CONFIG_HOST_PATH)"
        ledger_credentials="$(ledger_val SPARK_DELETION_LEDGER_OSS_READ_CREDENTIALS_HOST_PATH)"
        check_oss_ledger_files "${ledger_config:-/etc/spark/deletion-receipts/oss.json}" \
          "${ledger_credentials:-/etc/spark/deletion-receipts/reader.json}" ||
          die "OSS recovery requires the dedicated reader identity"
        recovery_compose+=(-f "$script_dir/compose.recovery-ledger-oss.yaml")
        ;;
      file)
        [[ -z "$binding" && -z "$(ledger_val SPARK_DELETION_LEDGER_OSS_CONFIG_HOST_PATH)" &&
           -z "$(ledger_val SPARK_DELETION_LEDGER_OSS_READ_CREDENTIALS_HOST_PATH)" ]] ||
          die "OSS recovery settings require SPARK_DELETION_LEDGER_BACKEND=oss"
        ;;
      *) die "unknown deletion ledger backend" ;;
    esac
    recovery_tool() (
      unset SPARK_RECOVERY_DB_PASSWORD SPARK_RECOVERY_IMAGE "${!SPARK_DELETION_LEDGER_@}"
      docker compose --env-file "$env_file" "${recovery_compose[@]}" -p "$project" \
        run --rm --no-deps -T tools "$@" </dev/null
    )
    if [[ "$ledger_backend" == oss ]]; then
      verified_namespace="$(recovery_tool verify-deletion-ledger "$ledger_probe_id")" &&
        [[ "$verified_namespace" == "$ledger_namespace" ]] ||
        die "OSS receipt namespace or known probe could not be verified; database left empty"
    fi

    scratch="$(mktemp -d "${TMPDIR:-/tmp}/spark-recovery.XXXXXXXX")"
    if ! gpg --homedir "$keyring" --batch --no-tty --decrypt --output "$scratch/spark.dump" "$archive" 2>/dev/null; then
      die "could not decrypt backup or verify its ciphertext integrity"
    fi
    if ! docker exec -i "$postgres" pg_restore --exit-on-error --single-transaction --no-owner --no-privileges \
      -U spark -d spark < "$scratch/spark.dump" >/dev/null 2>&1; then
      die "database restore failed"
    fi
    schema="$(psql -Atqc 'SELECT max(version) FROM schema_migrations')"
    [[ "$schema" =~ ^[1-9][0-9]*$ ]] || die "restored database has no Spark schema version"
    if (( schema >= 8 )); then
      recovery_tool invalidate-restored-mail || die "mail invalidation failed, keep recovery offline"
    else
      psql -q <<'SQL'
BEGIN;
UPDATE email_challenges SET consumed_at=now() WHERE consumed_at IS NULL;
UPDATE mail_outbox SET encrypted_payload=NULL WHERE encrypted_payload IS NOT NULL;
COMMIT;
SQL
    fi
    psql -q -c 'UPDATE sessions SET revoked_at=now() WHERE revoked_at IS NULL;'
    if [[ "$ledger_backend" == oss ]]; then
      recovery_tool replay-deletions || die "OSS receipt replay failed; keep the restored database offline"
      printf 'OSS receipt replay complete. Verify pending object cleanup before opening traffic.\n'
    fi
    printf 'Restored schema v%s. Sessions and mail challenges invalidated. Recovery remains offline.\n' "$schema"
    ;;
  *) usage >&2; exit 2 ;;
esac
