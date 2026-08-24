#!/usr/bin/env bash
# Upload the refreshed current-* weather datasets from public/data/ to the
# Cloudflare R2 bucket that serves the deployed site (data/code split: the
# JSONs are git-ignored; js/wind.js fetches them from R2_DATA_ROOT when not
# on localhost).
#
# Objects are stored UNCOMPRESSED, and the edge compresses them. This reverses
# the earlier design, for a reason that only appeared once a CDN went in front.
#
# Storing pre-compressed bodies with Content-Encoding: br existed because the
# r2.dev URL never compresses on the fly (verified 2026-08-17 and 2026-08-21),
# so it was the only way to get anything off the wire. The Worker in worker/
# removes that premise, and keeping both fought the platform: three deploys and
# three distinct failure modes, all measured against the live Worker, ending
# with the edge stripping Content-Encoding and clients receiving brotli bytes
# labelled application/json. The Workers runtime has no brotli decompressor, so
# a Worker cannot hand the edge something it will re-encode itself.
#
# Plain JSON is what the platform wants: the edge negotiates br, zstd or gzip
# per client and caches a variant for each. It costs bytes — the edge compresses
# at a lower level than brotli -q 9 did, measured 722 KB against 543 KB on the
# wave-height file, about +33% — and it is worth it, because the same change
# takes TTFB from 300-800 ms on r2.dev to 70-130 ms on a cache hit, which
# dominates for a file this size. Storage goes from ~20 MB to ~119 MB, which
# costs pennies.
#
# Nothing about the object KEYS changes, so no URL moves and wind.js is
# unaffected. brotli is no longer needed on PATH.
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
    # max-age matches the vercel.json data header; must-revalidate keeps browsers
    # honest across the 6-hourly refresh cadence. No content-encoding: the object
    # is plain JSON and the edge encodes it per request.
    aws s3 cp "$f" "s3://${BUCKET}/${f}" \
        --endpoint-url "$ENDPOINT" \
        --content-type "application/json" \
        --cache-control "public, max-age=1800, must-revalidate" \
        --only-show-errors
    awk -v f="$f" -v r="$(wc -c < "$f")" \
        'BEGIN {printf "uploaded %-46s %5.1f MB\n", f, r/1048576}'
done
