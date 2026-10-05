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
const { galleryTileHtml, viewerItems, zoomView, openViewer, setHistoryLayout, setHistoryFilter, fmtTime, historyState,
        wordDiff, settingsDiff, compareHtml, previousRun, detailHtml, groupInfo, startComparePick, refreshHistory, deleteHistoryRun,
        setTab, openCompare } = new Function("app", "api",
    src + "\nreturn { galleryTileHtml, viewerItems, zoomView, openViewer, setHistoryLayout, setHistoryFilter, fmtTime, wordDiff, settingsDiff, compareHtml, previousRun,"
        + " detailHtml, groupInfo, startComparePick, refreshHistory, deleteHistoryRun, setTab, openCompare, historyState: () => ({ historyRuns, comparePick }) };")(app, api);

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

test("viewer: a tap beside the image closes on the stage's click, not on pointerup; a pan/swipe ending there doesn't close", () => {
    const items = viewerItems(run(1, "a"));
    const rect  = { left: 0, top: 0, width: 400, height: 300 };

    openViewer(items, 0);
    const stage = body.at(-1).found[".qm-viewer-stage"];
    stage.getBoundingClientRect = () => rect;
    stage.setPointerCapture     = () => {};
    stage.listeners.pointerdown[0]({ pointerId: 1, target: stage, clientX: 0, clientY: 0 });
    stage.listeners.pointerup[0]({ pointerId: 1, type: "pointerup", clientX: 0, clientY: 0 });
    assert.ok(!body.at(-1).removed, "pointerup alone doesn't close it");
    stage.listeners.click[0]();
    assert.ok(body.at(-1).removed, "the stage's own click, after the pointer events, does");

    openViewer(items, 0);
    const stage2 = body.at(-1).found[".qm-viewer-stage"];
    stage2.getBoundingClientRect = () => rect;
    stage2.setPointerCapture     = () => {};
    stage2.listeners.pointerdown[0]({ pointerId: 1, target: stage2, clientX: 0, clientY: 0 });
    stage2.listeners.pointermove[0]({ pointerId: 1, clientX: 80, clientY: 0 });   // a swipe
    stage2.listeners.pointerup[0]({ pointerId: 1, type: "pointerup", clientX: 80, clientY: 0 });
    stage2.listeners.click[0]();
    assert.ok(!body.at(-1).removed, "a pan/swipe that ends over the black area must not close");
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

test("word diff: identical, an insertion, a deletion, a replacement in the middle", () => {
    assert.deepEqual(wordDiff("a cat on a sofa", "a cat on a sofa"), [{ op: "same", text: "a cat on a sofa" }]);
    assert.deepEqual(wordDiff("a cat on a sofa", "a black cat on a sofa"),
        [{ op: "same", text: "a " }, { op: "add", text: "black " }, { op: "same", text: "cat on a sofa" }]);
    assert.deepEqual(wordDiff("a black cat on a sofa", "a cat on a sofa"),
        [{ op: "same", text: "a " }, { op: "del", text: "black " }, { op: "same", text: "cat on a sofa" }]);
    assert.deepEqual(wordDiff("a cat on a red sofa at night", "a cat on a green sofa at night"),
        [{ op: "same", text: "a cat on a " }, { op: "del", text: "red " }, { op: "add", text: "green " }, { op: "same", text: "sofa at night" }]);
});

test("word diff: changes at both ends, line breaks kept, an empty side", () => {
    assert.deepEqual(wordDiff("one two three four", "zero two three five"), [
        { op: "del", text: "one " }, { op: "add", text: "zero " }, { op: "same", text: "two three " }, { op: "del", text: "four" }, { op: "add", text: "five" }]);
    assert.deepEqual(wordDiff("portrait,\nsoft light", "portrait,\nhard light"),
        [{ op: "same", text: "portrait,\n" }, { op: "del", text: "soft " }, { op: "add", text: "hard " }, { op: "same", text: "light" }]);
    assert.deepEqual(wordDiff("", "new text"), [{ op: "add", text: "new text" }]);
    assert.deepEqual(wordDiff("old text", ""), [{ op: "del", text: "old text" }]);
    assert.deepEqual(wordDiff("", ""), []);
});

test("word diff: a middle of more than 4 000 000 word pairs is one deletion and one addition", () => {
    const words = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i} `).join("");
    // 2000 × 2000 words in the middle: the LCS still finds the shared word
    assert.deepEqual(wordDiff(words("a", 1000) + "shared " + words("b", 999), words("c", 1000) + "shared " + words("d", 999)).map(p => p.op),
        ["del", "add", "same", "del", "add"]);
    // 2001 × 2001: past the limit, no LCS
    const a = words("a", 1000) + "shared " + words("b", 1000), b = words("c", 1000) + "shared " + words("d", 1000);
    assert.deepEqual(wordDiff(a, b), [{ op: "del", text: a }, { op: "add", text: b }]);
});

test("settings diff: per category what only A and only B have, the shared count, seeds that differ", () => {
    const prompt = (steps, lora, seeds, extra = {}) => ({
        "3": { class_type: "KSampler", inputs: { steps, cfg: 1, sampler_name: "euler", seed: seeds[0], ...extra } },
        "5": { class_type: "LoraLoader", inputs: { lora_name: lora, strength_model: 0.8 } },
        "6": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "8": { class_type: "RandomNoise", inputs: { noise_seed: seeds[1] ?? 0 } },
    });
    const { rows, same } = settingsDiff(prompt(8, "detail.safetensors", [1, 7]), prompt(12, "style.safetensors", [2, 7], { denoise: 0.5 }));
    assert.deepEqual(rows, [
        { cat: "sampling", onlyA: ["Steps 8"], onlyB: ["Steps 12", "Denoise 0.5"] },
        { cat: "lora", onlyA: ["detail · 0.8"], onlyB: ["style · 0.8"] },
        { cat: "seeds", onlyA: ["1"], onlyB: ["2"] },
    ], "the shared seed 7 is left out");
    assert.equal(same, 4, "CFG 1, Sampler euler, 1024×1024, Batch size 1");
    const p = prompt(8, "detail.safetensors", [1]);
    assert.deepEqual(settingsDiff(p, p), { rows: [], same: 6 });
    assert.deepEqual(settingsDiff({}, {}), { rows: [], same: 0 });
});

// API prompts with a sampler and prompt text (promptTexts takes text inputs of 30+ characters)
const PROMPT = (text, { steps = 8, seed = 1 } = {}) => ({
    "3": { class_type: "KSampler", _meta: { title: "KSampler" }, inputs: { steps, cfg: 1, sampler_name: "euler", seed } },
    "6": { class_type: "CLIPTextEncode", _meta: { title: "Positive" }, inputs: { text, clip: ["4", 1] } },
});
const NEGATIVE = { "7": { class_type: "CLIPTextEncode", _meta: { title: "Negative" }, inputs: { text: "blurry, low quality, extra fingers", clip: ["4", 1] } } };

test("compare view: headers, first outputs, the settings that differ and a word diff of the prompts, escaped", () => {
    const older = run(1, "aaaa1111", { prompt: { ...PROMPT("a <b>bold</b> cat on a red sofa at night"), ...NEGATIVE } });
    const newer = run(2, "bbbb2222", { prompt: PROMPT("a <b>bold</b> cat on a green sofa at night", { steps: 12, seed: 2 }), outputs: out("c.png") });
    const html  = compareHtml(older, newer);
    assert.ok(html.indexOf("aaaa1111…") < html.indexOf("bbbb2222…"));
    assert.ok(html.includes("Older") && html.includes("Newer") && html.includes("3m 12s"));
    assert.match(html, /data-side="0" data-index="0"[^>]*><img src="\/view\?filename=a\.png/);
    assert.match(html, /data-side="1" data-index="0"[^>]*><img src="\/view\?filename=c\.png/);
    assert.match(html, /data-side="0" data-index="1"[^>]*>\+1 more</);
    assert.ok(!html.includes(`data-side="1" data-index="1"`), "one output: no +N more");
    assert.ok(html.indexOf("Steps 8") < html.indexOf("→") && html.indexOf("→") < html.indexOf("Steps 12"));
    assert.ok(html.includes("Seeds") && html.includes("2 settings identical"));
    assert.ok(html.includes(`<del style="color:#f88;background:#ff666622;">red </del>`));
    assert.ok(html.includes(`<ins style="color:#7e7;background:#66ff6622;text-decoration:none;">green </ins>`));
    assert.ok(html.includes("a &#60;b&#62;bold&#60;/b&#62; cat") && !html.includes("<b>bold"));
    assert.ok(html.includes("Negative — only in the older run") && html.includes("blurry, low quality"));
    assert.ok(!html.includes("different workflows"));
    const other = compareHtml(older, run(3, "cccc3333", { name: "Other", state: "error", outputs: {}, prompt: older.item[2] }));
    assert.match(other, /<details[^>]*><summary[^>]*>Positive — identical<\/summary>/);
    assert.match(other, /<summary[^>]*>Negative — identical<\/summary>/);
    assert.ok(other.includes("different workflows") && other.includes("No output") && other.includes("✕"));
    assert.ok(other.includes("None") && other.includes("3 settings identical"));
});

test("detail card of a finished run: ⇄ Compare…, and ⇄ vs previous once an older run of its workflow is loaded", async () => {
    api.fetchApi = async url => answer(url.includes("/workflows") ? { workflows: [] }
        : { runs: [listed(run(3, "cccc3333")), listed(run(2, "bbbb2222", { name: "Other" })), listed(run(1, "aaaa1111"))], more: false });
    setHistoryFilter({});
    await settle();
    const [c, b, a] = historyState().historyRuns;
    const card = (r, where = "✓ Finished") => detailHtml(r.item, groupInfo([r.item]).get(r.item[1]), where, where === "Running" ? null : r);
    assert.ok(card(c).includes("⇄ Compare…") && card(c).includes("qm-compare-prev"), "a ran Wf before c");
    assert.ok(!card(a).includes("qm-compare-prev"), "nothing of Wf before a");
    assert.ok(!card(b).includes("qm-compare-prev"), "Other ran once");
    assert.ok(!card(c, "Running").includes("qm-compare"), "not for queued runs");
    assert.equal(previousRun(c, historyState().historyRuns), a);
    const script = { ...run(5, "eeee5555"), item: [0, "eeee5555", {}, {}, []] };
    assert.equal(previousRun(script, [script, { ...script, id: 4 }]), undefined, "no workflow identity, no previous");
});

test("pick mode: ⇄ Compare…, then a tap on another run compares them, older first; the same run or Esc cancels", () => {
    els["qm-compare-pick"] = element();
    const banner = els["qm-compare-pick"], list = els["qm-history"];
    const [c, b, a] = historyState().historyRuns;
    const tapRow = r => list.children[historyState().historyRuns.indexOf(r)].listeners.click[0]({ stopImmediatePropagation() {}, preventDefault() {} });
    const before = body.length;
    startComparePick(c);
    assert.equal(banner.style.display, "flex");
    assert.match(banner.innerHTML, /Tap a run to compare with Wf · /);
    assert.equal(list.children[2].style.cursor, "copy");
    assert.equal(document.keys.size, 1);
    tapRow(c);
    assert.equal(banner.style.display, "none");
    assert.equal(document.keys.size, 0);
    assert.equal(body.length, before, "the same run: nothing to compare");
    startComparePick(c);
    tapRow(a);
    const view = body.at(-1);
    assert.equal(body.length, before + 1);
    assert.ok(view.innerHTML.indexOf("aaaa1111…") < view.innerHTML.indexOf("cccc3333…"), "the older run on the left");
    assert.equal(historyState().comparePick, null);
    assert.equal(document.keys.size, 1, "the compare view's Esc");
    openViewer(viewerItems(a), 0);   // a tap on an output: the viewer on top of the compare view
    assert.deepEqual([window.keys.size, document.keys.size], [1, 1]);
    press(window, "Escape");         // window sees a key before document does: only the viewer closes
    assert.ok(body.at(-1).removed && !view.removed);
    assert.deepEqual([window.keys.size, document.keys.size], [0, 1]);
    press(document, "Escape");
    assert.ok(view.removed);
    assert.equal(document.keys.size, 0);
    startComparePick(b);
    press(document, "Escape");
    assert.equal(historyState().comparePick, null);
    assert.equal(banner.style.display, "none");
    assert.equal(document.keys.size, 0);
    assert.equal(list.children[2].style.cursor, undefined, "rows are plain again");
});

test("setTab ends pick mode for the rows too: no stale cursor or pick listener to throw from", async () => {
    const [c, , a] = historyState().historyRuns;
    const list = els["qm-history"];
    startComparePick(c);
    assert.equal(list.children[2].style.cursor, "copy");
    setTab("queue");
    setTab("history");   // triggers a background refreshHistory(); let it finish before the next test
    assert.equal(historyState().comparePick, null);
    assert.notEqual(list.children[2].style.cursor, "copy", "setTab re-rendered the rows out of pick mode");
    assert.equal(list.children[2].listeners.click, undefined, "no pick listener left over to throw on a stale comparePick");
    await settle();
});

test("⇄ vs previous ends pick mode first: no leftover banner or pick listener under the compare view", () => {
    const [c, , a] = historyState().historyRuns;
    startComparePick(c);
    assert.equal(document.keys.size, 1, "pick mode's Esc listener");
    openCompare(a, c);
    assert.equal(historyState().comparePick, null);
    assert.equal(els["qm-compare-pick"].style.display, "none");
    assert.equal(document.keys.size, 1, "only the compare view's own Esc listener remains");
    press(document, "Escape");
    assert.ok(body.at(-1).removed);
});

test("a picked run that leaves the list ends pick mode with a toast; new runs coming in keep it", async () => {
    const [, b, a] = historyState().historyRuns;
    startComparePick(a);
    api.fetchApi = async url => answer(url.includes("/workflows") ? { workflows: [] } : { runs: [listed(run(4, "dddd4444"))], more: false });
    await refreshHistory();   // the 2 s poll brings a new run
    assert.equal(historyState().comparePick, a);
    toasts.length = 0;
    api.fetchApi = async () => answer({ deleted: 1 });
    await deleteHistoryRun(a);
    assert.equal(historyState().comparePick, null);
    assert.deepEqual(toasts.map(t => [t.severity, t.summary]), [["warn", "Compare cancelled"]]);
    assert.equal(document.keys.size, 0);
    startComparePick(b);
    api.fetchApi = async url => answer(url.includes("/workflows") ? { workflows: [] } : { runs: [listed(run(3, "cccc3333", { state: "error" }))], more: false });
    setHistoryFilter({ status: "error" });
    await settle();
    assert.equal(historyState().comparePick, null, "filtered away");
    assert.equal(toasts.length, 2);
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
