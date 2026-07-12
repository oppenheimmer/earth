#!/usr/bin/env bash
# Upload the refreshed current-* weather datasets from public/data/ to the
# Cloudflare R2 bucket that serves the deployed site (data/code split: the
# JSONs are git-ignored; js/wind.js fetches them from R2_DATA_ROOT when not
# on localhost).
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
BUCKET="${R2_BUCKET:-earth-data}"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

cd "$(dirname "$0")/../public/data"
for f in current-*.json; do
    # max-age matches the old vercel.json data header; must-revalidate keeps
    # browsers honest across the 6-hourly refresh cadence.
    aws s3 cp "$f" "s3://${BUCKET}/${f}" \
        --endpoint-url "$ENDPOINT" \
        --content-type "application/json" \
        --cache-control "public, max-age=1800, must-revalidate" \
        --only-show-errors
    echo "uploaded ${f}"
done
