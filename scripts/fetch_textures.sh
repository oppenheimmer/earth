#!/usr/bin/env bash
# Download the static NASA imagery the RealView layers project onto the globe:
# the twelve Blue Marble Next Generation monthly composites (5400x2700 = 8 km/px),
# the Black Marble 2016 night-lights composite matched to the same grid, and the
# GEBCO elevation map that the relief shading differentiates.
#
# Each also has a deep-zoom twin — Blue Marble at 21600x10800, Black Marble at its
# native 13500x6750, GEBCO at 2700x1350. These are what sunlight.js swaps in past
# DETAIL_ZOOM, and they are fetched lazily by the browser, one window at a time.
#
# The Blue Marble files are re-encoded to WebP, and gain a third tier between the
# other two. Both are about what crosses the wire (measured 2026-08-24):
#
# Means across the twelve months, with the spread, since these vary a good deal by
# season — August is the smallest of them and January/December the largest:
#
#   base   5400x2700   1.78 MB jpeg -> 0.99 MB webp q85 (0.85-1.08), total 21.4 -> 11.8 MB
#   mid   10800x5400                   3.53 MB webp q85 (3.10-3.87), total 42.3 MB   NEW
#   deep  21600x10800 23.27 MB jpeg (21.79-24.49), unchanged — WebP stops at 16383 px
#
# The mid tier matters more than the halved base. 5400 carries 15 px/deg and runs out
# at 2.5x zoom, which is DETAIL_ZOOM; 10800 carries 30 and runs out at 5x. Before this,
# crossing 2.5x pulled a whole ~23 MB master to read one window out of it, so a
# viewer who zoomed a little paid as if they had zoomed all the way. Now they pay
# ~3.5 MB, and only a view past 5x reaches for the master.
#
# The night lights and the elevation map are deliberately NOT re-encoded — see the
# note above each below.
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
#   ./scripts/fetch_textures.sh              # ~365 MB: base set + masters + the two WebP tiers
#   SKIP_HIRES=1 ./scripts/fetch_textures.sh # ~34 MB, base set only (no mid tier either:
#                                            #   it is resampled from the deep-zoom master)
#   FORCE=1 ./scripts/fetch_textures.sh      # re-download everything
#
# Both collections are NASA Earth Observatory imagery, free of copyright.
#
# Needs curl, ffmpeg for the resamples below, and cwebp (libwebp) for the Blue
# Marble encodes.
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
#
# Not re-encoded to WebP, for the same reason this file is not a JPEG re-encode of a
# smaller source: the pixels are read back, not looked at. Running the r-0.6b extraction
# over a WebP of this file (measured 2026-08-24) lifts worst unlit-backdrop leakage from
# 2/255 to 22/255 at q85 and 12/255 even at q95, against the 1.4/255 the extraction can
# absorb — WebP spends its bit budget on the 99.9% of this image that is black, and the
# lights are what it rounds off. Lossless WebP is clean but 3.6 MB against 1.34 MB.
LIGHTS="https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg"
LIGHTS_OUT="blackmarble-2016-5400.jpg"    # name carries the grid: the R2 objects are immutable
LIGHTS_HI="blackmarble-2016-13500.jpg"    # the 3 km file kept as-is, for the deep-zoom crop

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
# Not WebP either, lossy or lossless: same gradient argument as below, and at 0.18 MB
# the file is already too small for the question to be interesting.
#
# PNG, not JPEG, and this is not a preference: JPEG's ringing injects ~28% noise into
# the gradient, measured, which is the exact quantity the shading consumes. Lossless
# costs 0.55 MB instead of 0.15 MB and is worth every byte of it.
DEM="https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73934/gebco_08_rev_elev_21600x10800.png"
DEM_OUT="elevation-gebco-1350.png"
DEM_HI="elevation-gebco-2700.png"         # deep-zoom relief; buildRelief's own cap is 2700

get() {  # get <url> <dest>
    if [[ -s "$2" && -z "${FORCE:-}" ]]; then
        printf "%-24s exists, skipped\n" "$2"
        return
    fi
    curl -fsSL --retry 3 -o "$2.part" "$1"
    mv "$2.part" "$2"
    awk -v f="$2" -v n="$(wc -c < "$2")" 'BEGIN {printf "%-24s %5.1f MB\n", f, n/1048576}'
}

command -v cwebp >/dev/null || { echo "cwebp (libwebp) is required to encode the Blue Marble" >&2; exit 1; }

# q85 by measurement, not by habit: against the source JPEG it scores SSIM 0.985 (q78
# 0.980, q90 0.991) and halves the file. This imagery is only ever sampled as colour, so
# there is no readback to protect the way the night lights and the elevation map have.
BM_QUALITY=85

encode_webp() {  # encode_webp <src> <dest> [resize-w resize-h]
    if [[ -s "$2" && -z "${FORCE:-}" ]]; then
        printf "%-28s exists, skipped\n" "$2"
        return
    fi
    cwebp -quiet -q "$BM_QUALITY" -m 4 ${3:+-resize "$3" "$4"} "$1" -o "$2.part"
    mv "$2.part" "$2"
    awk -v f="$2" -v n="$(wc -c < "$2")" 'BEGIN {printf "%-28s %5.1f MB\n", f, n/1048576}'
}

for m in "${!MONTHS[@]}"; do
    mm=$(printf "%02d" $((m + 1)))
    # The JPEG is an intermediate now, not an output: it is what NASA publishes, and the
    # WebP beside it is what the browser fetches. Kept on disk so a re-run with a changed
    # BM_QUALITY re-encodes without re-downloading 21 MB; delete them to reclaim ~21 MB.
    get "${BMNG}/${MONTHS[m]}/world.topo.2004${mm}.3x5400x2700.jpg" "bluemarble-2004${mm}.jpg"
    encode_webp "bluemarble-2004${mm}.jpg" "bluemarble-2004${mm}.webp"
done

# The deep-zoom masters: same composites on NASA's 21600x10800 grid, 60 px/deg against the
# 5400 file's 15. sunlight.js loads one of these only when the view zooms past DETAIL_ZOOM,
# and reads back only the window on screen — the whole thing is 933 MB as RGBA. 21 MB each,
# ~250 MB for the year, which is why they are a separate loop and not a bigger $BMNG.
# Set SKIP_HIRES=1 to fetch only the base set (the site degrades to the 5400 imagery).
if [[ -z "${SKIP_HIRES:-}" ]]; then
    for m in "${!MONTHS[@]}"; do
        mm=$(printf "%02d" $((m + 1)))
        get "${BMNG}/${MONTHS[m]}/world.topo.2004${mm}.3x21600x10800.jpg" "bluemarble-2004${mm}-21600.jpg"
        # The mid tier, resampled straight out of the master rather than fetched: NASA
        # publishes 5400 and 21600 and nothing between. cwebp's own -resize is used
        # instead of an ffmpeg hop because a 10800x5400 PNG intermediate is ~300 MB;
        # measured SSIM 0.986 against the lanczos route, and slightly smaller with it.
        # Costs ~4.5 s and ~1.6 GB of RSS per month, sequentially, in a one-off script.
        encode_webp "bluemarble-2004${mm}-21600.jpg" "bluemarble-2004${mm}-10800.webp" 10800 5400
    done
fi
if [[ -s "$LIGHTS_OUT" && -s "$LIGHTS_HI" && -z "${FORCE:-}" ]]; then
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
    # The 3 km original is now kept, not deleted: it is the deep-zoom night texture. The
    # argument above for resampling still holds for the *base* layer — no client should
    # decode 91 Mpx to look at a whole globe — but past DETAIL_ZOOM only a crop is read
    # back, and there the extra 2.5x per axis is exactly what stops the lights smudging
    # under a now-sharp daytime coastline.
    mv blackmarble-3km.orig.jpg "$LIGHTS_HI"
    awk -v f="$LIGHTS_OUT" -v n="$(wc -c < "$LIGHTS_OUT")" \
        'BEGIN {printf "%-24s %5.1f MB  (5400x2700, resampled from 3 km)\n", f, n/1048576}'
fi

if [[ -s "$DEM_OUT" && -s "$DEM_HI" && -z "${FORCE:-}" ]]; then
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
    # And the deep-zoom pair. 2700 rather than the master's 21600 because buildRelief caps
    # itself there, and because the +505 ms decode measured above is already the ceiling of
    # what belongs on a layer switch; going further means raising that cap and re-measuring.
    ffmpeg -loglevel error -y -i elevation.orig.png \
        -vf "scale=2700:1350:flags=lanczos,format=gray" -f image2 -c:v png "$DEM_HI.part"
    mv "$DEM_HI.part" "$DEM_HI"
    awk -v f="$DEM_HI" -v n="$(wc -c < "$DEM_HI")" \
        'BEGIN {printf "%-24s %5.1f MB  (2700x1350 grayscale, deep zoom)\n", f, n/1048576}'
    rm -f elevation.orig.png
    awk -v f="$DEM_OUT" -v n="$(wc -c < "$DEM_OUT")" \
        'BEGIN {printf "%-24s %5.1f MB  (1350x675 grayscale, from 21600x10800)\n", f, n/1048576}'
fi
