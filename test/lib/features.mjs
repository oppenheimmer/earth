// The feature hierarchy used by the pre-release browser checks.
const wind = "current-wind-surface-level-gfs-0.25.json";
const currents = "current-ocean-currents-cmems-0.25.json";
const day = "bluemarble-200408.webp"; // probes/harness.js pins the clock to August.

export const FEATURES = {
    wind: {
        title: "Wind displays",
        layers: [
            {id: "surface", category: "Wind vectors", title: "Wind @ Surface", files: [wind], scale: "0 – 360 km/h", readout: "18 km/h"},
            ...["1000hpa", "500hpa", "10hpa"].map(id => ({
                id, category: "Wind vectors", title: `Wind @ ${id.replace("hpa", " hPa")}`,
                files: [`current-wind-${id}-gfs-0.25.json`], scale: "0 – 360 km/h", readout: "18 km/h"
            })),
            {id: "temperature", category: "Surface scalars", title: "Temperature @ Surface",
                files: [wind, "current-temp-surface-level-gfs-0.25.json"], scale: "-10 – 45 °C", readout: "20.0 °C"},
            {id: "rh", category: "Surface scalars", title: "Rel. Humidity @ Surface",
                files: [wind, "current-rh-surface-level-gfs-0.25.json"], scale: "0 – 100 %", readout: "60 %"},
            {id: "dew", category: "Surface scalars", title: "Dew Point @ Surface",
                files: [wind, "current-dewpoint-surface-level-gfs-0.25.json"], scale: "-40 – 35 °C", readout: "10.0 °C"}
        ],
        physics: ["surface"]
    },
    ocean: {
        title: "Ocean displays",
        layers: [
            {id: "ocean", category: "Currents", title: "Ocean Currents @ Surface", files: [currents], scale: "0 – 1.5 m/s", readout: "0.50 m/s"},
            ...[["ocean25", "25"], ["ocean110", "110"], ["ocean450", "450"]].map(([id, depth]) => ({
                id, category: "Currents", title: `Ocean Currents @ ${depth} m`,
                files: [`current-ocean-currents-${depth}m-cmems-0.25.json`], scale: "0 – 1.5 m/s", readout: "0.50 m/s"
            })),
            {id: "sst", category: "Temperature", title: "Sea Water Temperature @ Surface",
                files: [currents, "current-ocean-temp-cmems-0.25.json"], scale: "0 – 35 °C", readout: "20.5 °C"},
            {id: "waves", category: "Waves", title: "Ocean Waves",
                files: ["current-ocean-waves-gfswave-0.25.json", "current-ocean-wave-height-gfswave-0.25.json"],
                scale: "0 – 15 m", readout: "2.5 m"}
        ],
        physics: ["ocean450", "waves"]
    },
    solar: {
        title: "Solar radiance display",
        layers: [
            {id: "daylight", category: "Daylight", title: "Daylight", files: [day]},
            {id: "nightlights", category: "Night lights", title: "Night Lights", files: [day, "blackmarble-2016-5400.jpg"]},
            {id: "relief", category: "Terrain relief", title: "Relief", files: [day, "elevation-gebco-1350.png"]}
        ].map(layer => ({...layer, scale: "night – day", readout: " solar"})),
        physics: []
    }
};

function record(value, parameterNumber) {
    return {header: {nx: 8, ny: 5, dx: 45, dy: 45, lo1: 0, la1: 90,
        scanMode: 0, refTime: "2026-08-17T00:00:00Z", forecastTime: 0,
        parameterCategory: 2, parameterNumber}, data: Array(40).fill(value)};
}

/** Browser preload: only weather/imagery are replaced; all shipped JS/maps run normally. */
export function featureFixtures() {
    const data = {};
    for (const group of Object.values(FEATURES)) {
        for (const {files} of group.layers) {
            for (const file of files.filter(file => file.endsWith(".json"))) {
                if (file.startsWith("current-wind")) data[file] = [record(3, 2), record(4, 3)];
                else if (file.includes("currents")) data[file] = [record(.3, 2), record(.4, 3)];
            }
        }
    }
    data["current-temp-surface-level-gfs-0.25.json"] = [record(293.15, 0)];
    data["current-rh-surface-level-gfs-0.25.json"] = [record(60, 1)];
    data["current-dewpoint-surface-level-gfs-0.25.json"] = [record(283.15, 6)];
    data["current-ocean-temp-cmems-0.25.json"] = [record(20.5, 18)];
    data["current-ocean-waves-gfswave-0.25.json"] = [record(10, 2), record(0, 3)];
    data["current-ocean-wave-height-gfswave-0.25.json"] = [record(2.5, 3)];

    return `
        window.featureAudit = {errors: [], requests: []};
        addEventListener('error', event => featureAudit.errors.push(event.message));
        addEventListener('unhandledrejection', event => featureAudit.errors.push(String(event.reason)));
        const fixtureData = ${JSON.stringify(data)};
        const realFetch = window.fetch;
        window.fetch = (url, options) => {
            const file = new URL(String(url), location.href).pathname.split('/').pop();
            if (!file.startsWith('current-')) return realFetch(url, options);
            featureAudit.requests.push(file);
            if (!fixtureData[file]) return Promise.reject(Error('Unknown dataset: ' + file));
            return Promise.resolve(new Response(JSON.stringify(fixtureData[file]), {
                headers: {'Content-Type': 'application/json'}
            }));
        };
        const imageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 16;
        const context = canvas.getContext('2d');
        for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) {
            context.fillStyle = 'rgb(' + (80 + x * 4) + ',' + (80 + y * 8) + ',150)';
            context.fillRect(x, y, 1, 1);
        }
        const texture = canvas.toDataURL('image/png');
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
            get: imageSrc.get,
            set(url) {
                const file = new URL(String(url), location.href).pathname.split('/').pop();
                if (/^(bluemarble-|blackmarble-|elevation-)/.test(file)) {
                    featureAudit.requests.push(file);
                    imageSrc.set.call(this, texture);
                } else imageSrc.set.call(this, url);
            }
        });
    `;
}
