#!/usr/bin/env bash
# Ship the NASA imagery fetched by fetch_textures.sh to the Cloudflare R2
# bucket, so the deployed site can project it onto the globe (same data/code
# split as the weather JSONs: git-ignored locally, served from R2_DATA_ROOT).
#
# Kept separate from upload_data.sh on purpose: these objects are static — one
# 2004 composite per month, the night lights and the elevation map, plus the
# deep-zoom twin of each — so the 6-hourly refresh workflow must never re-upload
# them. Run this by hand, once. The globs below pick the high-res files up on
# their names, so nothing here needed changing when they were added; the volume
# did, and again when the Blue Marble gained its WebP tiers: what is uploaded is now
# ~336 MB (11.8 base + 42.3 mid + 279 masters + 9.5 night + 0.8 elevation).
#
# No brotli here either: JPEG and WebP are both already entropy-coded (measured:
# -q 9 saves 0.4% for ~2 s of CPU per file), and an immutable year-long cache is
# safe because the file names carry the composite's own date — and its grid, so a
# re-encode at a different size lands on a new key rather than behind a year-long
# cache.
#
# The base Blue Marble is WebP and its 5400 JPEG is not uploaded at all: that file
# is only the download NASA serves, from which fetch_textures.sh cuts the .webp the
# browser actually fetches. The 21600 masters stay JPEG (WebP tops out at 16383 px
# per axis) and are still globbed by name.
#
# Environment as in upload_data.sh (locally: set -a && source .env/r2 && set +a):
#
#   R2_ACCOUNT_ID  AWS_ACCESS_KEY_ID  AWS_SECRET_ACCESS_KEY  [R2_BUCKET]
set -euo pipefail

: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"
BUCKET="${R2_BUCKET:-earth-data}"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

cd "$(dirname "$0")/../public/data"
shopt -s nullglob
files=(bluemarble-*.webp blackmarble-*.jpg elevation-*.png bluemarble-*-21600.jpg)
[[ ${#files[@]} -gt 0 ]] || { echo "no textures in public/data — run fetch_textures.sh first" >&2; exit 1; }

for f in "${files[@]}"; do
    # The elevation map is PNG, and mislabelling it would make the browser refuse to
    # decode the one file whose pixel values are read back rather than displayed.
    case "$f" in
        *.png)  type="image/png";;
        *.webp) type="image/webp";;
        *)      type="image/jpeg";;
    esac
    aws s3 cp "$f" "s3://${BUCKET}/${f}" \
        --endpoint-url "$ENDPOINT" \
        --content-type "$type" \
        --cache-control "public, max-age=31536000, immutable" \
        --only-show-errors
    awk -v f="$f" -v n="$(wc -c < "$f")" 'BEGIN {printf "uploaded %-24s %5.1f MB\n", f, n/1048576}'
done
