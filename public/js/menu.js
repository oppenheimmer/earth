/**
 * menu.js — burger menu for the HUD.
 *
 * The panel (tabs, layer list, data info, color scale) is hidden behind a burger
 * button, nullschool-style. Tabs are hierarchical: one top-level domain (Atmosphere /
 * Ocean) is active at a time, and each domain shows a single displayed layer — layers
 * are never combined. Ocean layers are placeholders until their data pipelines exist.
 */
(function () {
    "use strict";

    var burger = document.getElementById("burger");
    var panel = document.getElementById("menu-panel");

    burger.addEventListener("click", function () {
        panel.hidden = !panel.hidden;
        burger.setAttribute("aria-expanded", String(!panel.hidden));
    });

    var tabs = document.querySelectorAll("#tabs .tab");
    var bodies = document.querySelectorAll(".tab-body");

    tabs.forEach(function (tab) {
        tab.addEventListener("click", function () {
            tabs.forEach(function (t) { t.classList.toggle("active", t === tab); });
            bodies.forEach(function (b) { b.hidden = b.dataset.tab !== tab.dataset.tab; });
        });
    });

    // Layer buttons: the engine (wind.js) owns the switch and the active-state sync;
    // the menu only announces the request.
    document.querySelectorAll(".layer[data-layer]").forEach(function (btn) {
        btn.addEventListener("click", function () {
            if (btn.classList.contains("active")) return;
            document.dispatchEvent(new CustomEvent("layerchange", {detail: btn.dataset.layer}));
        });
    });
})();
