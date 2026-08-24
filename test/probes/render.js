// Rendering suite: fingerprints the settled view. Any pixel that moves between builds
// shows up as a changed hash, and ink/sum narrow down whether geometry or colour moved.
async function runSuite() {
    var view = E.params();

    var settled = await E.settle(90000);
    E.trace("fingerprinting");

    // #animation is deliberately absent from the comparison — its particles are seeded from
    // Math.random. It is asserted to carry ink instead, which is the property that matters:
    // the trails are being drawn at all.
    var animation = E.canvasSignature("animation");

    E.report({
        view: view.name,
        settled: settled,
        map: E.canvasSignature("map"),
        overlay: E.canvasSignature("overlay"),
        lines: E.canvasSignature("lines"),
        animationInk: animation.ink,
        diameter: E.sphereDiameter(),
        hash: E.hashState(),
        dom: {
            label: E.el("data-label").textContent.trim(),
            date: E.el("data-date").textContent.trim(),
            scale: E.el("scale-label").textContent.trim(),
            location: E.el("location").textContent.trim()
        }
    });
}
