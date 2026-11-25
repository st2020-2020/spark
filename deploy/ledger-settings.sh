#!/usr/bin/env bash
# Shared by recovery and the target-side release scripts.

read_ledger_environment() (
  local env_file="$1"
  shift
  unset "${!SPARK_DELETION_LEDGER_@}" SPARK_PURGE_EXPIRY_START_AT SPARK_OSS_CREDENTIALS_HOST_PATH
  "$@" compose --env-file "$env_file" -p spark-ledger-preflight -f - config --environment \
    <<<'services: {check: {image: scratch}}' |
    awk '/^SPARK_(PURGE_EXPIRY_START_AT|OSS_CREDENTIALS_HOST_PATH|DELETION_LEDGER_(BACKEND|HOST_PATH|OSS_(CONFIG|CREDENTIALS|READ_CREDENTIALS|BINDING)_HOST_PATH))=/'
)

ledger_val() {
  sed -n "s/^$1=//p" <<< "$ledger_env"
}

read_oss_ledger_binding() {
  local file="$1" extra=
  if [[ ! -f "$file" || -L "$file" ]] || ! {
    IFS= read -r ledger_probe_id &&
    IFS= read -r ledger_namespace &&
    ! IFS= read -r extra && [[ -z "$extra" ]]
  } < "$file" || [[ ! "$ledger_probe_id" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ||
    "$ledger_probe_id" == 00000000-0000-0000-0000-000000000000 || -z "$ledger_namespace" ]]; then
    echo "A verified OSS deletion ledger binding with a known probe UUID is required." >&2
    return 1
  fi
}

ledger_file_stat() {
  local path="$1" linux_format="$2" bsd_format="$3"
  stat -Lc "$linux_format" -- "$path" 2>/dev/null ||
    stat -Lf "$bsd_format" -- "$path" 2>/dev/null ||
    sudo -n stat -Lc "$linux_format" -- "$path" 2>/dev/null
}

check_oss_ledger_files() {
  local config="$1" credentials="$2" metadata
  [[ "$config" = /* && "$credentials" = /* && "$config$credentials" != *:* ]] &&
    { [[ -f "$config" ]] || sudo -n test -f "$config" 2>/dev/null; } &&
    { [[ -f "$credentials" ]] || sudo -n test -f "$credentials" 2>/dev/null; } ||
    { echo "OSS deletion ledger requires absolute paths to its configuration and dedicated credential files." >&2; return 1; }
  metadata="$(ledger_file_stat "$credentials" '%u:%g:%a' '%u:%g:%Lp')" || return 1
  case "$metadata" in
    0:65532:440|65532:*:400) ;;
    *) echo "OSS deletion ledger credentials require root:65532 0440 or UID 65532 0400." >&2; return 1 ;;
  esac
}
