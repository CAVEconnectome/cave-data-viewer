#!/usr/bin/env bash
#
# Bootstrap a GCS bucket for the cdv L2 cache, scoped for local development.
#
# Idempotent: safe to re-run. Creates the bucket if it doesn't exist, and
# (re)applies the two lifecycle rules on every run so the retention policy
# matches the script's intent regardless of the bucket's prior state.
#
# Two lifecycle rules:
#   - `dev-<user>/cache/default/` aged out after --default-age-days
#     (default 2). Matches CAVE's typical materialization lifetime.
#   - `dev-<user>/cache/longlived/` aged out after --longlived-age-days
#     (default 730 = 2 years). For public-release versions that the
#     `cdv-warm-cache` script will mark as long-lived.
#   - `dev-<user>/cache/info/` is intentionally NOT matched — marker
#     files (longlived-versions registry) live there and should never
#     be swept by lifecycle.
#   - `dev-<user>/cache/userdata/` is intentionally NOT matched — per-user
#     YAML state (personal recipes) lives there and represents user data
#     that must persist indefinitely. WARNING: widening the matchesPrefix
#     above to `["dev-<user>/cache/"]` or `["**"]` would silently delete
#     every user's recipes after --default-age-days. The exact-prefix
#     matching below is load-bearing for user-data preservation.
#
# Auth: uses your active gcloud identity (`gcloud auth list`). The
# bucket-create + lifecycle calls require `roles/storage.admin` on the
# project. The cdv API itself uses ADC at runtime —
# `gcloud auth application-default login` covers that and is independent
# of this script's auth.
#
# Usage:
#   scripts/setup_local_cache_bucket.sh \
#     --project my-gcp-project \
#     --bucket cdv-dev-cache-myname \
#     --user myname
#
#   # Optional flags:
#   #   --region us-central1            (default: us-central1)
#   #   --default-age-days 2            (default: 2)
#   #   --longlived-age-days 730        (default: 730)
#
# After it runs, copy the printed `export` lines into your shell. Then
# `gcloud auth application-default login` (one-time) and start the API:
#   CDV_DEV_AUTH_BYPASS=1 CDV_PORT=5001 uv run python run_api.py

set -euo pipefail

PROJECT=""
BUCKET=""
USER_NS=""
REGION="us-central1"
DEFAULT_AGE_DAYS="2"
LONGLIVED_AGE_DAYS="730"

usage() {
  # Strip leading "# " from comment lines, skip the shebang.
  sed -n '2,40s/^# \{0,1\}//p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)             PROJECT="$2"; shift 2 ;;
    --bucket)              BUCKET="$2"; shift 2 ;;
    --user)                USER_NS="$2"; shift 2 ;;
    --region)              REGION="$2"; shift 2 ;;
    --default-age-days)    DEFAULT_AGE_DAYS="$2"; shift 2 ;;
    --longlived-age-days)  LONGLIVED_AGE_DAYS="$2"; shift 2 ;;
    # Backwards-compat: --age-days maps to --default-age-days for the
    # benefit of any operator notes / shell history from before the
    # split.
    --age-days)            DEFAULT_AGE_DAYS="$2"; shift 2 ;;
    -h|--help)             usage 0 ;;
    *) echo "unknown arg: $1" >&2; usage 1 ;;
  esac
done

[[ -n "$PROJECT" && -n "$BUCKET" && -n "$USER_NS" ]] || {
  echo "error: --project, --bucket, --user are required" >&2
  usage 1
}

# Sanity: gcloud / gsutil installed and authenticated.
command -v gcloud  >/dev/null || { echo "gcloud not found on PATH" >&2; exit 2; }
command -v gsutil  >/dev/null || { echo "gsutil not found on PATH" >&2; exit 2; }

ACTIVE_ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
[[ -n "$ACTIVE_ACCOUNT" ]] || {
  echo "error: no active gcloud account. Run \`gcloud auth login\` first." >&2
  exit 2
}

echo "Using gcloud account:           $ACTIVE_ACCOUNT"
echo "Project:                        $PROJECT"
echo "Bucket:                         gs://$BUCKET"
echo "Region:                         $REGION"
echo "Default-class age (days):       $DEFAULT_AGE_DAYS"
echo "Longlived-class age (days):     $LONGLIVED_AGE_DAYS"
echo "Cache prefix:                   dev-$USER_NS/cache/"
echo

# 1. Create the bucket if it doesn't exist. `gcloud storage buckets create`
#    fails on existing buckets; the existence probe keeps the script
#    idempotent. We deliberately don't try to detect "exists in another
#    project" here — gcloud will surface that error if it happens.
if gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT" >/dev/null 2>&1; then
  echo "[skip] bucket gs://$BUCKET already exists; not recreating"
else
  echo "[create] gs://$BUCKET in $REGION"
  gcloud storage buckets create "gs://$BUCKET" \
    --project="$PROJECT" \
    --location="$REGION" \
    --uniform-bucket-level-access \
    --public-access-prevention \
    --default-storage-class=STANDARD
fi

# 2. Apply lifecycle rules. Always re-applied so the retention policy is
#    deterministic from the script's flags. Rules scope to the per-
#    developer prefix only — a shared dev bucket between two developers
#    can have multiple rule sets side-by-side without interference.
#
#    `cache/info/` and `cache/userdata/` are deliberately NOT matched:
#    marker files (the longlived-versions registry) live in info/ and
#    per-user state (personal recipes) lives in userdata/. Both must
#    persist indefinitely.
LIFECYCLE_JSON="$(mktemp)"
trap 'rm -f "$LIFECYCLE_JSON"' EXIT

cat >"$LIFECYCLE_JSON" <<EOF
{
  "lifecycle": {
    "rule": [
      {
        "action": { "type": "Delete" },
        "condition": {
          "age": $DEFAULT_AGE_DAYS,
          "matchesPrefix": ["dev-$USER_NS/cache/default/"]
        }
      },
      {
        "action": { "type": "Delete" },
        "condition": {
          "age": $LONGLIVED_AGE_DAYS,
          "matchesPrefix": ["dev-$USER_NS/cache/longlived/"]
        }
      }
    ]
  }
}
EOF

echo "[apply] lifecycle rules:"
echo "  - dev-$USER_NS/cache/default/   age $DEFAULT_AGE_DAYS days"
echo "  - dev-$USER_NS/cache/longlived/ age $LONGLIVED_AGE_DAYS days"
echo "  - dev-$USER_NS/cache/info/      not matched (marker files persist)"
echo "  - dev-$USER_NS/cache/userdata/  not matched (user recipes persist)"
gcloud storage buckets update "gs://$BUCKET" \
  --project="$PROJECT" \
  --lifecycle-file="$LIFECYCLE_JSON"

# 3. Print the env-var snippet. Heredoc-style for clean copy-paste.
cat <<EOF

[done] Bucket ready.

Add to your shell (or your project's .envrc):

  export CDV_GCS_CACHE_BUCKET=$BUCKET
  export CDV_GCS_CACHE_PREFIX=dev-$USER_NS/cache/
  export CDV_GCS_CACHE_PROJECT=$PROJECT

If you haven't yet:

  gcloud auth application-default login

Then start the API as usual:

  CDV_DEV_AUTH_BYPASS=1 CDV_PORT=5001 uv run python run_api.py

To inspect the cache while running:

  gsutil ls -lh gs://$BUCKET/dev-$USER_NS/cache/

To wipe your dev cache between sessions:

  gsutil -m rm -r gs://$BUCKET/dev-$USER_NS/cache/default/ \\
                  gs://$BUCKET/dev-$USER_NS/cache/longlived/

  # NOTE: this skips userdata/ — wiping it deletes everyone's recipes.

To inspect user-saved recipes:

  gsutil ls -lh gs://$BUCKET/dev-$USER_NS/cache/userdata/<user_id>/

To wipe one user's recipes (use with care):

  gsutil -m rm -r gs://$BUCKET/dev-$USER_NS/cache/userdata/<user_id>/

EOF
