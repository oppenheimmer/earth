#!/usr/bin/env bash
# Download the static NASA imagery the RealView layers project onto the globe:
# the twelve Blue Marble Next Generation monthly composites (5400x2700 = 8 km/px),
# the Black Marble 2016 night-lights composite matched to the same grid, and the
# GEBCO elevation map that the relief shading differentiates.
#
# Of BMNG's three relief variants this takes "world.topo" — land topography only.
# The "world.topo.bathy" sibling adds bathymetric shading, which lifts the deep
# ocean to a mid blue and draws the mid-ocean ridges; the plain composite keeps
# MODIS' near-black water with true-colour shallows, which is what a lit globe
# photographed from space looks like. Swapping is a one-word edit to $BMNG.
#
# Unlike the weather datasets these never change, so this is a one-off, not a
# refresh: run it once for local dev (public/data/ is git-ignored), then ship
# the files to R2 with scripts/upload_textures.sh. Already-downloaded files are
# skipped unless FORCE=1.
#
#   ./scripts/fetch_textures.sh          # ~22 MB, the twelve months + lights + relief
#   FORCE=1 ./scripts/fetch_textures.sh  # re-download everything
#
# Both collections are NASA Earth Observatory imagery, free of copyright.
#
# Needs curl, and ffmpeg for the one downscale below.
set -euo pipefail

cd "$(dirname "$0")/../public/data"

# assets.science.nasa.gov is the current home of the Earth Observatory's BMNG
# files; the old eoimages.gsfc.nasa.gov paths have one image record id per
# month, which is far less predictable than the month name.
BMNG="https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography"
MONTHS=(january february march april may june july august september october november december)
# Night lights: fetched at 3 km and downscaled here to the Blue Marble's own grid.
# NASA publishes this composite at 0.1 deg (3600x2700) and at 3 km (13500x6750). The
# 0.1 deg file is 1.5x coarser per axis than the day imagery, which shows as a smudge
# under the sharp daytime coastline once the globe is zoomed past country level. The
# 3 km file fixes that but is 91 Mpx — ~364 MB as RGBA — and every client would decode
# it in full only for buildTexture() to throw 92% of it away at TEXTURE_MAX_WIDTH. So
# the resample happens once, here, where the imagery is already known to be static:
# the browser downloads 1.3 MB and decodes exactly the 5400x2700 it keeps.
#
# lanczos over area/bilinear: measured on a north-India crop it retains the most
# pixel-to-pixel detail (17.3 vs 15.4), and its ringing costs nothing that matters —
# worst unlit-backdrop leakage through the r-0.6b light extraction rises to 1.4/255,
# still eight times below the dimmest settlement the extraction has to keep.
LIGHTS="https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg"
LIGHTS_OUT="blackmarble-2016-5400.jpg"    # name carries the grid: the R2 objects are immutable

# Elevation: NASA's GEBCO-derived global relief, land only (ocean is a flat code 3).
# A quarter of the colour grid on purpose. Relief shading consumes the *gradient* of
# this map and mountains are large features, so it downsamples far better than a
# photograph does — and the cost of not downsampling is not the file size, it is the
# decode. Measured in Chromium against the 2700x1350 version:
#
#     2700x1350   decode 502 ms  read 197 ms  gradients 269 ms   +505 ms on layer load
#     1350x675    decode 387 ms  read  47 ms  gradients  57 ms   +113 ms on layer load
#
# and 1 MB of retained heap against 38 MB. At RELIEF_STRENGTH 0.05 the two are hard to
# tell apart on the globe. Change the scale below and the name in sunlight.js together
# if a sharper one is ever wanted.
#
# PNG, not JPEG, and this is not a preference: JPEG's ringing injects ~28% noise into
# the gradient, measured, which is the exact quantity the shading consumes. Lossless
# costs 0.55 MB instead of 0.15 MB and is worth every byte of it.
DEM="https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73934/gebco_08_rev_elev_21600x10800.png"
DEM_OUT="elevation-gebco-1350.png"

get() {  # get <url> <dest>
    if [[ -s "$2" && -z "${FORCE:-}" ]]; then
        printf "%-24s exists, skipped\n" "$2"
        return
    fi
    curl -fsSL --retry 3 -o "$2.part" "$1"
    mv "$2.part" "$2"
    awk -v f="$2" -v n="$(wc -c < "$2")" 'BEGIN {printf "%-24s %5.1f MB\n", f, n/1048576}'
}

for m in "${!MONTHS[@]}"; do
    mm=$(printf "%02d" $((m + 1)))
    get "${BMNG}/${MONTHS[m]}/world.topo.2004${mm}.3x5400x2700.jpg" "bluemarble-2004${mm}.jpg"
done
if [[ -s "$LIGHTS_OUT" && -z "${FORCE:-}" ]]; then
    printf "%-24s exists, skipped\n" "$LIGHTS_OUT"
else
    command -v ffmpeg >/dev/null || { echo "ffmpeg is required to resample the night lights" >&2; exit 1; }
    get "$LIGHTS" "blackmarble-3km.orig.jpg"
    # Both -f and -c:v are spelled out because the output goes through a ".part"
    # temporary: ffmpeg infers muxer *and* codec from the extension, ".part" tells it
    # nothing, and the image2 muxer's silent default codec is MJPEG. Fine here, where
    # JPEG is what we want — fatal for the elevation map below, so neither is left
    # implicit.
    ffmpeg -loglevel error -y -i blackmarble-3km.orig.jpg \
        -vf "scale=5400:2700:flags=lanczos" -q:v 2 -f image2 -c:v mjpeg "$LIGHTS_OUT.part"
    mv "$LIGHTS_OUT.part" "$LIGHTS_OUT"
    rm -f blackmarble-3km.orig.jpg
    awk -v f="$LIGHTS_OUT" -v n="$(wc -c < "$LIGHTS_OUT")" \
        'BEGIN {printf "%-24s %5.1f MB  (5400x2700, resampled from 3 km)\n", f, n/1048576}'
fi

if [[ -s "$DEM_OUT" && -z "${FORCE:-}" ]]; then
    printf "%-24s exists, skipped\n" "$DEM_OUT"
else
    command -v ffmpeg >/dev/null || { echo "ffmpeg is required to resample the elevation map" >&2; exit 1; }
    get "$DEM" "elevation.orig.png"
    # -c:v png is load-bearing: without it the image2 muxer defaults to MJPEG and
    # silently writes a lossy JPEG under a .png name — measured at up to 35 code levels
    # of error, into the one file whose gradient must be clean.
    ffmpeg -loglevel error -y -i elevation.orig.png \
        -vf "scale=1350:675:flags=lanczos,format=gray" -f image2 -c:v png "$DEM_OUT.part"
    mv "$DEM_OUT.part" "$DEM_OUT"
    rm -f elevation.orig.png
    awk -v f="$DEM_OUT" -v n="$(wc -c < "$DEM_OUT")" \
        'BEGIN {printf "%-24s %5.1f MB  (1350x675 grayscale, from 21600x10800)\n", f, n/1048576}'
fi
