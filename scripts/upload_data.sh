#!/usr/bin/env bash
# Upload the refreshed current-* weather datasets from public/data/ to the
# Cloudflare R2 bucket that serves the deployed site (data/code split: the
# JSONs are git-ignored; js/wind.js fetches them from R2_DATA_ROOT when not
# on localhost).
#
# Objects are stored PRE-COMPRESSED with Content-Encoding: br. The r2.dev
# development URL never compresses on the fly (verified 2026-08-17 and again
# 2026-08-21: no Content-Encoding even when the client offers gzip/br/zstd),
# but R2 does serve a stored encoding, and Cloudflare transparently decodes
# for clients that do not accept it. So this buys ~5.9x off the wire today,
# with no custom domain and no change to wind.js — the object KEY keeps the
# plain .json name, so every URL is unchanged.
#
# R2 is S3-compatible, so this uses the AWS CLI (preinstalled on GitHub
# runners; locally: pip install awscli). Required environment:
#
#   R2_ACCOUNT_ID             Cloudflare account id (dashboard sidebar)
#   AWS_ACCESS_KEY_ID         R2 API token key   (R2 → Manage API Tokens)
#   AWS_SECRET_ACCESS_KEY     R2 API token secret
#   R2_BUCKET                 bucket name, default "earth-data"
#
# Locally the three ids can live in the git-ignored .env/r2 (same pattern as
# .env/copernicusmarine):  set -a && source .env/r2 && set +a
set -euo pipefail

: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"
command -v brotli >/dev/null || { echo "brotli not found (apt install brotli)" >&2; exit 1; }
BUCKET="${R2_BUCKET:-earth-data}"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

# q9 is the knee of the curve: measured over all 12 datasets it beats gzip -9
# (17.3 MB vs 18.9 MB total) at a third of the CPU, while q11 costs ~7 s per
# file for another ~7%. Raw total is ~102 MB.
BROTLI_QUALITY="${BROTLI_QUALITY:-9}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$(dirname "$0")/../public/data"
for f in current-*.json; do
    brotli -q "$BROTLI_QUALITY" -c "$f" > "$WORK/$f.br"
    raw=$(wc -c < "$f")
    enc=$(wc -c < "$WORK/$f.br")
    # max-age matches the old vercel.json data header; must-revalidate keeps
    # browsers honest across the 6-hourly refresh cadence.
    aws s3 cp "$WORK/$f.br" "s3://${BUCKET}/${f}" \
        --endpoint-url "$ENDPOINT" \
        --content-type "application/json" \
        --content-encoding "br" \
        --cache-control "public, max-age=1800, must-revalidate" \
        --only-show-errors
    awk -v f="$f" -v r="$raw" -v e="$enc" \
        'BEGIN {printf "uploaded %-46s %5.1f MB -> %4.1f MB  (%.1fx)\n", f, r/1048576, e/1048576, r/e}'
done
