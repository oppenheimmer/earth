// Device profiles.
//
// A profile is not a viewport. wind.js and sunlight.js both branch on isMobile(), and that
// function reads navigator.userAgent — nothing else:
//
//     /android|blackberry|iemobile|ipad|iphone|ipod|opera mini|webos/i.test(navigator.userAgent)
//
// Emulation.setDeviceMetricsOverride does not touch the user agent, so a 412x915 dpr-3 tab
// with touch emulation on is still, to every one of those branches, a desktop. The suites
// that called themselves "mobile" were running the desktop paths end to end: full particle
// count instead of PARTICLE_REDUCTION, 5400-wide textures instead of the halved cap, the
// deep-zoom tier engaged instead of skipped, relief at 2700 instead of 1350. None of the
// mobile rendering had ever been executed by a test.
//
// So a profile carries the user agent as well as the metrics, and the probes assert which
// branch they actually landed on rather than assuming.
export class Device {
    constructor({name, width, height, dpr, touch = false, userAgent = null, platform = null, mobile = null}) {
        this.name = name;
        this.width = width;
        this.height = height;
        this.dpr = dpr;
        this.touch = touch;
        this.userAgent = userAgent;
        this.platform = platform;
        // Chrome's own "mobile" emulation flag — overlay scrollbars, viewport meta handling.
        // Defaults to following touch, which is what the suites meant by it before.
        this.mobile = mobile === null ? touch : mobile;
    }

    /** True when this profile's UA satisfies the app's own isMobile() test. */
    get isMobileUA() {
        return /android|blackberry|iemobile|ipad|iphone|ipod|opera mini|webos/i
            .test(this.userAgent || "");
    }

    /** The page options newPage() consumes. */
    page(extra = {}) {
        return {
            viewport: {width: this.width, height: this.height, dpr: this.dpr},
            touch: this.touch,
            mobile: this.mobile,
            userAgent: this.userAgent,
            platform: this.platform,
            ...extra
        };
    }
}

// A desktop browser: no touch, dpr 1, and a UA that fails the mobile test.
export const DESKTOP = new Device({
    name: "desktop", width: 900, height: 700, dpr: 1, touch: false
});

// A HiDPI desktop. dpr > 1 with a desktop UA is its own combination — it takes the
// device-pixel branches (canvas backing store, particle density, overlayScale) without
// taking the isMobile() ones, and nothing had covered it.
export const DESKTOP_HIDPI = new Device({
    name: "desktop-hidpi", width: 1440, height: 900, dpr: 2, touch: false
});

// A real phone: iPhone 14 Pro metrics with an iOS Safari UA, so isMobile() is true and the
// mobile branches are the ones under test.
export const PHONE = new Device({
    name: "phone", width: 393, height: 852, dpr: 3, touch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    platform: "iPhone"
});

// An Android phone at dpr 2.75: a different UA branch of the same regex, and a
// non-integer device pixel ratio, which is where canvas backing-store rounding shows up.
export const PHONE_ANDROID = new Device({
    name: "phone-android", width: 412, height: 915, dpr: 2.75, touch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/125.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l"
});

// A tablet. "ipad" is in the regex, so this takes the mobile branches at a viewport where
// the halved texture cap is stretched across far more screen than a phone stretches it.
export const TABLET = new Device({
    name: "tablet", width: 1024, height: 1366, dpr: 2, touch: true,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    platform: "iPad"
});

// The phone metrics the suites used *before* profiles existed: a phone-shaped viewport with
// a headless desktop UA. Kept deliberately, as the control that shows the difference the UA
// makes — it is the device every "mobile" number in the old reports was actually measured on.
export const PHONE_NO_UA = new Device({
    name: "phone-desktop-ua", width: 412, height: 915, dpr: 3, touch: true
});

export const DEVICES = {
    desktop: DESKTOP,
    desktopHidpi: DESKTOP_HIDPI,
    phone: PHONE,
    phoneAndroid: PHONE_ANDROID,
    tablet: TABLET,
    phoneNoUA: PHONE_NO_UA
};
