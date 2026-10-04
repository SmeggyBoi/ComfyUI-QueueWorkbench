// Run from the repo root: node tests/test_compare.mjs
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../web/queue_workbench.js", import.meta.url), "utf8").replace(/^import .*$/mg, "");

// Just enough DOM for the History list and the overlays. An element keeps its markup, style,
// listeners and appended children (setting innerHTML drops the children); querySelector hands
// out one stand-in element per selector, so a test can read what the code wrote into it.
function element() {
    let html = "";
    return {
        style: {}, children: [], listeners: {}, found: {}, removed: false,
        get innerHTML() { return html; },
        set innerHTML(value) { html = value; this.children = []; },
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
        querySelector(sel) { return this.found[sel] ??= element(); },
        querySelectorAll: () => [],
        appendChild(child) { this.children.push(child); },
        remove() { this.removed = true; },
    };
}
// The keydown listeners of window or document; adding the same one twice keeps one, as in the DOM
function keyTarget() {
    const keys = new Set();
    return { keys, addEventListener(type, fn) { if (type === "keydown") keys.add(fn); },
             removeEventListener(type, fn) { if (type === "keydown") keys.delete(fn); } };
}
const press = (target, key) => [...target.keys].forEach(fn => fn({ key, stopPropagation() {}, preventDefault() {} }));
const els  = {};   // the panel's elements, by id
const body = [];   // what was appended to document.body: the overlays
globalThis.window   = Object.assign(keyTarget(), { matchMedia: () => ({ matches: true }) });
globalThis.document = Object.assign(keyTarget(), {
    getElementById: id => els[id] ?? null,
    createElement: () => element(),
    body: { appendChild: el => body.push(el) },
});
const toasts = [];
const api = { addEventListener() {} };   // the History tests set api.fetchApi
const app = { registerExtension() {}, extensionManager: { toast: { add: t => toasts.push(t) } } };
const { galleryTileHtml, viewerItems, zoomView, openViewer, setHistoryLayout, setHistoryFilter, fmtTime, historyState } = new Function("app", "api",
    src + "\nreturn { galleryTileHtml, viewerItems, zoomView, openViewer, setHistoryLayout, setHistoryFilter, fmtTime, historyState: () => ({ historyRuns }) };")(app, api);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const START = Date.UTC(2026, 9, 3, 12, 0, 0);
function status(state, ms = 192_000) {
    const end = state === "success" ? ["execution_success", { prompt_id: "a", timestamp: START + ms }]
        : ["execution_error", { prompt_id: "a", node_id: "3", node_type: "KSampler", exception_message: "CUDA out of memory", timestamp: START + ms }];
    return { status_str: state, completed: state === "success", messages: [["execution_start", { prompt_id: "a", timestamp: START }], end] };
}
const out = (...files) => ({ "9": { images: files.map(filename => ({ filename, subfolder: "", type: "output" })) } });
// A History run as the panel holds it; the workflow is cut down to id + extra, as the list route sends it
function run(id, pid, { name = "Wf", state = "success", outputs = out("a.png", "b.mp4"), pinned = false, prompt = {} } = {}) {
    return { id, item: [0, pid, prompt, { extra_pnginfo: { workflow: { id: "wf", extra: { qm_name: name } } } }, ["9"]],
             outputs, status: status(state), pinned };
}
const answer = data => ({ ok: true, status: 200, json: async () => data });
const listed = r => ({ id: r.id, prompt: r.item, outputs: r.outputs, status: r.status, pinned: r.pinned });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test("gallery tile: the first output, the status mark, +N for the other outputs, ★ when pinned", () => {
    const html = galleryTileHtml(run(1, "a"));
    assert.equal((html.match(/<img |<video /g) || []).length, 1, "the first output only");
    assert.ok(html.includes("filename=a.png") && html.includes("object-fit:cover"));
    assert.ok(html.includes("✓") && html.includes("+1"));
    assert.ok(!html.includes("★") && !html.includes("#6a2c2c"));
    assert.ok(galleryTileHtml(run(1, "a", { pinned: true })).includes("★"));
    assert.ok(!/\+\d/.test(galleryTileHtml(run(1, "a", { outputs: out("a.png") }))), "no badge for a single output");
});

test("gallery tile of a failed run without outputs: placeholder, ✕, faint red border; no status, no mark; names escaped", () => {
    const failed = galleryTileHtml(run(2, "b", { state: "error", outputs: {} }));
    assert.ok(failed.includes("No output") && failed.includes("✕") && failed.includes("#6a2c2c"));
    assert.ok(!failed.includes("<img") && !failed.includes("<video"));
    const unknown = galleryTileHtml({ ...run(3, "c", { name: "<b>Wf</b>" }), status: null });
    assert.ok(!unknown.includes("undefined") && !unknown.includes("✓") && !unknown.includes("<b>Wf"));
    assert.ok(unknown.includes("&#60;b&#62;Wf"));
});

test("viewer items: every output of the run, captioned workflow · mark · finish time", () => {
    const items = viewerItems(run(1, "a"));
    assert.deepEqual(items.map(i => [i.label, i.video]), [["a.png", false], ["b.mp4", true]]);
    assert.equal(items[0].caption, `Wf · ✓ · ${fmtTime(START + 192_000)}`);
    assert.equal(viewerItems({ ...run(1, "a", { name: null }), status: null })[0].caption, "Unnamed workflow");
    assert.deepEqual(viewerItems(run(1, "a", { outputs: {} })), []);
});

test("zoom: the tapped point stays put, pans stop at the zoomed image's edges, 1× is centred, 5× at most", () => {
    const fit = { w: 400, h: 300 }, box = { w: 400, h: 800 }, one = { scale: 1, x: 0, y: 0 };
    const p = { x: 100, y: 50 };
    const zoomed = zoomView(one, p, p, 2.5, fit, box);
    // 1000 × 750 now: 300 px to pan either way horizontally, none vertically (750 < 800)
    assert.deepEqual(zoomed, { scale: 2.5, x: -150, y: 0 });
    assert.deepEqual(zoomView(zoomed, { x: 0, y: 0 }, { x: -1000, y: 0 }, 2.5, fit, box), { scale: 2.5, x: -300, y: 0 }, "dragged far left: stops at the image's right edge");
    assert.deepEqual(zoomView(zoomed, { x: 0, y: 0 }, { x: 100, y: 0 }, 2.5, fit, box), { scale: 2.5, x: -50, y: 0 });
    assert.deepEqual(zoomView(zoomed, p, p, 1, fit, box), one, "back at 1×: centred");
    assert.deepEqual(zoomView(one, p, p, 0.4, fit, box), one, "never below 1×");
    assert.equal(zoomView(one, p, p, 12, fit, box).scale, 5);
    // a pinch at 2× spreading to 4× while its midpoint moves 20 px right
    assert.deepEqual(zoomView({ scale: 2, x: 0, y: 0 }, { x: 0, y: 0 }, { x: 20, y: 0 }, 4, { w: 400, h: 400 }, { w: 400, h: 400 }), { scale: 4, x: 20, y: 0 });
});

test("viewer: ← / → step through the items and stop at the ends; Esc or ✕ closes it and drops its key listener", () => {
    const items = viewerItems(run(1, "a"));
    openViewer(items, 0);
    const viewer = body.at(-1);
    const count  = () => viewer.found[".qm-viewer-count"].textContent;
    const stage  = () => viewer.found[".qm-viewer-stage"].innerHTML;
    assert.equal(window.keys.size, 1);
    assert.equal(count(), "1 / 2");
    assert.match(stage(), /^<img src="\/view\?filename=a\.png/);
    assert.equal(viewer.found[".qm-viewer-prev"].style.visibility, "hidden");
    press(window, "ArrowLeft");
    assert.equal(count(), "1 / 2", "nothing before the first");
    press(window, "ArrowRight");
    assert.equal(count(), "2 / 2");
    assert.match(stage(), /^<video src="\/view\?filename=b\.mp4[^"]*" controls autoplay loop muted playsinline/);
    assert.equal(viewer.found[".qm-viewer-caption"].textContent, items[1].caption);
    assert.equal(viewer.found[".qm-viewer-download"].href, items[1].url);
    assert.equal(viewer.found[".qm-viewer-download"].download, "b.mp4");
    press(window, "ArrowRight");
    assert.equal(count(), "2 / 2", "nothing after the last");
    press(window, "Escape");
    assert.ok(viewer.removed);
    assert.equal(window.keys.size, 0);
    openViewer(items, 1);
    body.at(-1).found[".qm-viewer-close"].listeners.click[0]();
    assert.ok(body.at(-1).removed);
    assert.equal(window.keys.size, 0, "no listener left from either viewer");
});

test("▦ shows the runs as tiles and a tile opens its run's outputs in the viewer; ☰ goes back to rows", async () => {
    Object.assign(els, { "qm-history": element(), "qm-history-more": element(), "qm-layout": element() });
    api.fetchApi = async url => answer(url.includes("/workflows") ? { workflows: [] }
        : { runs: [listed(run(2, "b", { state: "error", outputs: {} })), listed(run(1, "a"))], more: false });
    setHistoryFilter({});
    await settle();
    const list = els["qm-history"];
    assert.equal(list.children.length, 2);
    setHistoryLayout("grid");
    assert.equal(els["qm-layout"].textContent, "☰");
    const [grid] = list.children;
    assert.match(grid.style.cssText, /display:grid/);
    const [failedTile, tile] = grid.children;
    assert.equal(tile.innerHTML, galleryTileHtml(historyState().historyRuns[1]));
    assert.ok(!failedTile.listeners.click, "no outputs, nothing to view");
    tile.listeners.click[0]();
    assert.equal(body.at(-1).found[".qm-viewer-count"].textContent, "1 / 2");
    press(window, "Escape");
    setHistoryLayout("list");
    assert.equal(els["qm-layout"].textContent, "▦");
    assert.equal(list.children.length, 2);
    assert.ok(list.children[0].innerHTML.includes("qm-requeue-btn"), "rows again");
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
