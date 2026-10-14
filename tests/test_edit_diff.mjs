// Run from the repo root: node tests/test_edit_diff.mjs
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../web/queue_workbench.js", import.meta.url), "utf8").replace(/^import .*$/mg, "");
globalThis.window   = { matchMedia: () => ({ matches: true }) };
globalThis.document = { getElementById: () => null, addEventListener() {}, removeEventListener() {} };
const { diffPrompts, diffWidgets, patchRun, changeLabel, editedRunPayload, editTabName, siblingCandidates, validationMessage, resubmitBody, detailHtml, groupInfo, slotShifts, markDropTarget, trackDropTarget, reorderedIds, onDragStart, onDragEnd, sourceWorkflow, carryBack } = new Function("app", "api",
    src + "\nreturn { diffPrompts, diffWidgets, patchRun, changeLabel, editedRunPayload, editTabName, siblingCandidates, validationMessage, resubmitBody, detailHtml, groupInfo, slotShifts, markDropTarget, trackDropTarget, reorderedIds, onDragStart, onDragEnd, sourceWorkflow, carryBack };")({ registerExtension() {} }, { addEventListener() {} });

const TEXT = "summary: a woman walks through a sunlit flower shop, smiling at the camera";
function run(id, { seed = 1, text = TEXT, steps = 12, lora = true } = {}) {
    const prompt = {
        "5":  { class_type: "CLIPTextEncode", _meta: { title: "PROMPTS" }, inputs: { text, clip: ["4", 0] } },
        "20": { class_type: "easy seed", _meta: { title: "EasySeed" }, inputs: { seed } },
        "23": { class_type: "Power Lora Loader (rgthree)", inputs: { lora_1: { on: lora, lora: "styles/watercolor_v2.safetensors", strength: 1 } } },
        "24": { class_type: "PrimitiveInt", _meta: { title: "Steps" }, inputs: { value: steps } },
    };
    const workflow = { id: "wf", nodes: [
        { id: 5, widgets_values: [text] }, { id: 20, widgets_values: [seed, "randomize"] }, { id: 24, widgets_values: [steps, "fixed"] },
    ] };
    return [0, id, prompt, { extra_pnginfo: { workflow } }, ["9"]];
}
const edit = (item, fn) => { const copy = structuredClone(item); fn(copy[2], copy[3].extra_pnginfo.workflow); return copy; };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("prompt typo fix is copied to runs with the same prompt, seeds untouched", () => {
    const a = run("a", { seed: 1 }), b = run("b", { seed: 2 }), c = run("c", { seed: 3, text: TEXT + " (other)" });
    const fixed = edit(a, (p, w) => { p["5"].inputs.text = TEXT.replace("walks", "strolls"); w.nodes[0].widgets_values[0] = p["5"].inputs.text; });
    const { changes, structural } = diffPrompts(a[2], fixed[2]);
    assert.equal(structural, false);
    assert.deepEqual(changes.map(c => `${c.nodeId}.${c.input}`), ["5.text"]);
    const widgetChanges = diffWidgets(a[3].extra_pnginfo.workflow, fixed[3].extra_pnginfo.workflow);
    const patched = patchRun(b, changes, widgetChanges);
    assert.equal(patched.prompt["5"].inputs.text, fixed[2]["5"].inputs.text);
    assert.equal(patched.prompt["20"].inputs.seed, 2);
    assert.equal(patched.workflow.nodes[0].widgets_values[0], fixed[2]["5"].inputs.text);
    assert.equal(b[2]["5"].inputs.text, TEXT, "original sibling is not mutated");
    assert.equal(patchRun(c, changes, widgetChanges), null);
});

test("the edited run itself gets every change, even where its queued value drifted in the editor", () => {
    // The editor re-serializes some widgets differently on load (e.g. 0 -> 0.5); the user's edit
    // is diffed against that baseline, so its "old" value need not match the queued graph.
    const a = run("a");
    const change = { nodeId: "24", input: "value", old: 99, new: 13 };
    const patched = patchRun(a, [change], [{ key: "root:24", index: "0", old: 99, new: 13 }], true);
    assert.equal(patched.prompt["24"].inputs.value, 13);
    assert.equal(patched.workflow.nodes[2].widgets_values[0], 13);
    assert.equal(patched.prompt["20"].inputs.seed, 1, "untouched values stay exactly as queued");
    assert.equal(patchRun(a, [change], []), null, "siblings still require the old value");
});

test("edited run uses the editor's graph when a change has no place in the queued one", () => {
    const a = run("a");
    const output = edit(a, p => { p["99"] = { class_type: "Note", inputs: { text: "x" } }; })[2];
    const fallback = editedRunPayload(a, output, { nodes: [] }, [{ nodeId: "99", input: "text", old: "x", new: "y" }], [], false);
    assert.equal(fallback.prompt, output);
    const normal = editedRunPayload(a, output, { nodes: [] }, [{ nodeId: "24", input: "value", old: 14, new: 13 }], [], false);
    assert.equal(normal.prompt["24"].inputs.value, 13);
    assert.equal(normal.prompt["99"], undefined, "value-only edits land on the queued graph");
});

const named = (id, name, opts) => { const r = run(id, opts); r[3].extra_pnginfo.workflow.extra = { qm_name: name }; return r; };

test("edit tab names are unique per run even when position and workflow match", () => {
    const a = named("aaaaaaaa-1111", "Portrait"), b = named("bbbbbbbb-2222", "Portrait");
    assert.notEqual(editTabName(a, "#3"), editTabName(b, "#3"));
});

test("sibling candidates: same workflow only, never runs without a workflow, never runs open in another edit tab", () => {
    const a = named("a", "Portrait"), b = named("b", "Portrait"), c = named("c", "Portrait"), d = named("d", "Landscape");
    const api1 = [0, "x", {}, {}, []], api2 = [0, "y", {}, {}, []];
    assert.deepEqual(siblingCandidates(a, [a, b, c, d], new Set(["c"])).map(it => it[1]), ["b"]);
    assert.deepEqual(siblingCandidates(api1, [api1, api2], new Set()), []);
});

test("validation errors name the node of the run they belong to", () => {
    const edited = run("a"), sibling = run("b");
    sibling[2]["24"]._meta.title = "Steps (other run)";
    const items = [{ prompt_id: "a", prompt: edited[2] }, { prompt_id: "b", prompt: sibling[2] }];
    const data  = { prompt_id: "b", node_errors: { "24": { errors: [{ message: "Value 0 smaller than min of 1" }], class_type: "PrimitiveInt" } } };
    assert.equal(validationMessage(data, items), "Steps (other run): Value 0 smaller than min of 1");
});

test("a change on an input the queued node lacks falls back to the editor's graph", () => {
    const a = run("a");
    const output = edit(a, p => { p["24"].inputs.extra_flag = true; })[2];
    const payload = editedRunPayload(a, output, { nodes: [] }, [{ nodeId: "24", input: "extra_flag", old: false, new: true }], [], false);
    assert.equal(payload.prompt, output);
});

test("re-submitting a run (resume / old reorder path) keeps its prompt_id", () => {
    const body = resubmitBody(run("keep-me"), -9000);
    assert.equal(body.prompt_id, "keep-me");
    assert.equal(body.number, -9000);
});

test("detail card shows the whole prompt when runs share it, and greys only the shared part when they differ", () => {
    const solo = run("solo");
    assert.ok(detailHtml(solo, groupInfo([solo]).get("solo"), "#1").includes("sunlit flower shop"), "single run");
    const a = named("a", "Shop"), b = named("b", "Shop", { text: TEXT + ", golden hour" });
    const html = detailHtml(a, groupInfo([a, b]).get("a"), "#1");
    assert.ok(html.includes("sunlit flower shop") && html.includes("qm-div"), "differing runs keep both parts");
});

test("seed edit is never copied", () => {
    const a = run("a", { seed: 1 }), b = run("b", { seed: 2 });
    const reseeded = edit(a, p => { p["20"].inputs.seed = 99; });
    const { changes } = diffPrompts(a[2], reseeded[2]);
    assert.equal(patchRun(b, changes, []), null);
});

test("steps change only reaches runs that still have the old steps", () => {
    const a = run("a"), b = run("b", { seed: 2 }), d = run("d", { seed: 4, steps: 14 });
    const more = edit(a, p => { p["24"].inputs.value = 14; });
    const { changes } = diffPrompts(a[2], more[2]);
    assert.equal(patchRun(b, changes, []).prompt["24"].inputs.value, 14);
    assert.equal(patchRun(d, changes, []), null);
});

test("added nodes or rewired links are structural", () => {
    const a = run("a");
    assert.equal(diffPrompts(a[2], edit(a, p => { p["30"] = { class_type: "Note", inputs: {} }; })[2]).structural, true);
    assert.equal(diffPrompts(a[2], edit(a, p => { p["5"].inputs.clip = ["6", 0]; })[2]).structural, true);
});

test("object-style widgets_values (VHS) are diffed by key", () => {
    const before = { nodes: [{ id: 7, widgets_values: { frame_rate: 24, format: "video/h264-mp4" } }] };
    const after  = { nodes: [{ id: 7, widgets_values: { frame_rate: 30, format: "video/h264-mp4" } }] };
    assert.deepEqual(diffWidgets(before, after), [{ key: "root:7", index: "frame_rate", old: 24, new: 30 }]);
});

test("change labels read like the chips", () => {
    const a = run("a");
    const off = edit(a, p => { p["23"].inputs.lora_1.on = false; p["24"].inputs.value = 14; });
    const labels = diffPrompts(a[2], off[2]).changes.map(c => changeLabel(c, off[2]));
    assert.deepEqual(labels, ["watercolor_v2: 1.0 → off", "Steps: 12 → 14"]);
});

test("rows that changed slots slide from their old place; new, gone and unmoved rows don't", () => {
    const before = new Map([["a", 0], ["b", 64], ["c", 128], ["gone", 192], ["d", 256]]);
    const after  = new Map([["c", 0], ["a", 64], ["b", 128], ["new", 192], ["d", 256]]);
    assert.deepEqual([...slotShifts(before, after)], [["c", 128], ["a", -64], ["b", -64]]);
    assert.equal(slotShifts(after, after).size, 0);
});

test("while dragging, red follows the row under the cursor and clears off the rows", () => {
    const log = [];
    const row = (name, index) => ({ dataset: { index: String(index) }, animate: () => { log.push(`on ${name}`); return { cancel: () => log.push(`off ${name}`) }; } });
    const a = row("a", 0), b = row("b", 1);
    const over = el => trackDropTarget({ target: { closest: () => el } });
    over(a); over(a); over(b); over(null);
    markDropTarget(null);
    assert.deepEqual(log, ["on a", "off a", "on b", "off b"]);
});

test("never red over the dragged run itself", () => {
    const log = [];
    const row = name => ({ dataset: { promptId: name }, animate: () => { log.push(`on ${name}`); return { cancel: () => log.push(`off ${name}`) }; } });
    const a = row("a"), b = row("b");
    onDragStart({ currentTarget: { dataset: { promptId: "a" }, style: {} }, dataTransfer: {} });
    const over = el => trackDropTarget({ target: { closest: () => el } });
    over(a);   // dragged row itself: no highlight
    over(b);   // a different row: highlighted
    onDragEnd({ currentTarget: { style: {} } });
    assert.deepEqual(log, ["on b", "off b"]);
});

test("reorder: a run dropped on another takes that run's slot; to top; no-ops", () => {
    const ids = ["a", "b", "c", "d", "e"];
    assert.deepEqual(reorderedIds(ids, "b", "d"), ["a", "c", "d", "b", "e"], "down: b takes d's slot");
    assert.deepEqual(reorderedIds(ids, "d", "b"), ["a", "d", "b", "c", "e"], "up: d takes b's slot");
    assert.deepEqual(reorderedIds(ids, "e", "top"), ["e", "a", "b", "c", "d"]);
    assert.equal(reorderedIds(ids, "a", "top"), null, "already first");
    assert.equal(reorderedIds(ids, "c", "c"), null, "dropped on itself");
    assert.equal(reorderedIds(ids, "gone", "b"), null, "dragged run already started");
    assert.equal(reorderedIds(ids, "b", "gone"), null, "target already started");
    assert.deepEqual(ids, ["a", "b", "c", "d", "e"], "input not mutated");
});

test("detail card offers Move to top only for pending runs #2 and later", () => {
    const a = run("a");
    const info = groupInfo([a]).get("a");
    const has = where => detailHtml(a, info, where).includes("qm-detail-top");
    assert.equal(has("#3 of 5"), true);
    assert.equal(has("#10 of 12"), true);
    assert.equal(has("#1 of 5"), false);
    assert.equal(has("Running"), false);
    assert.equal(has("Saved"), false);
    assert.equal(has("✓ Finished 14:32 · 3m 12s"), false);
});

// A run as queued from the tab "Long Videos" (the stamp the queue wrapper adds)
const stamped = (item, name = "Long Videos") => { item[3].extra_pnginfo.workflow.extra = { qm_name: name }; return item; };
const openTab = (path, state) => ({ path, filename: path.split("/").pop().replace(/\.json$/, ""), activeState: state });
const edited  = (item, fn) => { const copy = structuredClone(item); fn(copy[3].extra_pnginfo.workflow); return copy; };

test("source workflow: the open tab with the run's name and workflow id, not a Save As copy", () => {
    const a      = stamped(run("a"));
    const state  = structuredClone(a[3].extra_pnginfo.workflow);
    const source = openTab("workflows/sub/Long Videos.json", state);
    const copy   = openTab("workflows/Long Videos v2.json", state);       // Save As keeps the workflow id
    const other  = openTab("workflows/Other.json", { ...state, id: "x" });
    assert.equal(sourceWorkflow(a, [copy, other, source], {}).tab, source);
    assert.equal(sourceWorkflow(a, [copy, other], {}), null);
});

test("source workflow: the saved file when it isn't open; nothing when ambiguous or unknown", () => {
    const a = stamped(run("a"));
    assert.deepEqual(sourceWorkflow(a, [], { wf: ["sub/Long Videos.json", "Long Videos v2.json"] }), { path: "workflows/sub/Long Videos.json" });
    assert.equal(sourceWorkflow(a, [], { wf: ["a/Long Videos.json", "b/Long Videos.json"] }), null);
    const state = structuredClone(a[3].extra_pnginfo.workflow);
    assert.equal(sourceWorkflow(a, [openTab("workflows/a/Long Videos.json", state), openTab("workflows/b/Long Videos.json", state)], {}), null);
    assert.equal(sourceWorkflow(run("b"), [], { wf: ["Long Videos.json"] }), null, "no stamped name, no unambiguous id match in the panel's map");
    const noId = stamped(run("c"));
    delete noId[3].extra_pnginfo.workflow.id;
    assert.equal(sourceWorkflow(noId, [openTab("workflows/Long Videos.json", {})], {}), null);
});

test("carry back: values the workflow still has are applied, values changed there are conflicts, the input stays as it was", () => {
    const a       = run("a", { steps: 12 });
    const newText = TEXT.replace("walks", "strolls");
    const after   = edited(a, w => { w.nodes[0].widgets_values[0] = newText; w.nodes[2].widgets_values[0] = 30; });
    const changes = diffWidgets(a[3].extra_pnginfo.workflow, after[3].extra_pnginfo.workflow);
    const source  = structuredClone(a[3].extra_pnginfo.workflow);
    source.nodes[2].widgets_values[0] = 25;                                 // Steps changed in the workflow since queueing
    const before  = structuredClone(source);
    const r = carryBack(source, changes);
    assert.deepEqual(r.applied.map(c => c.key), ["root:5"]);
    assert.deepEqual(r.conflicts.map(({ change, current }) => [change.key, current]), [["root:24", 25]]);
    assert.deepEqual(r.missing, []);
    assert.equal(r.workflow.nodes[0].widgets_values[0], newText);
    assert.equal(r.workflow.nodes[2].widgets_values[0], 25);
    assert.deepEqual(source, before, "the workflow passed in is not mutated");
    const forced = carryBack(source, changes, new Set(["root:24|0"]));
    assert.equal(forced.workflow.nodes[2].widgets_values[0], 30);
    assert.deepEqual(forced.applied.map(c => c.key).sort(), ["root:24", "root:5"]);
    assert.equal(forced.conflicts.length, 1, "a ticked conflict is still reported as one");
});

test("carry back: a value the workflow already has is left out; a deleted node or widget is missing", () => {
    const a      = run("a", { steps: 12 });
    const after  = edited(a, w => { w.nodes[0].widgets_values[0] = "new text"; w.nodes[2].widgets_values[0] = 30; w.nodes[1].widgets_values[1] = "fixed"; });
    const changes = diffWidgets(a[3].extra_pnginfo.workflow, after[3].extra_pnginfo.workflow);
    const source = structuredClone(a[3].extra_pnginfo.workflow);
    source.nodes[0].widgets_values[0] = "new text";                        // already there
    source.nodes = source.nodes.filter(n => n.id !== 24);                  // Steps node deleted
    source.nodes.find(n => n.id === 20).widgets_values = [1];              // seed control widget gone
    const r = carryBack(source, changes);
    assert.deepEqual(r.applied, []);
    assert.deepEqual(r.conflicts, []);
    assert.deepEqual(r.missing.map(c => `${c.key}|${c.index}`).sort(), ["root:20|1", "root:24|0"]);
});

test("carry back: subgraph nodes and object-style widgets_values (VHS)", () => {
    const workflow = { id: "wf", nodes: [{ id: 9, type: "sg1", widgets_values: [] }],
        definitions: { subgraphs: [{ id: "sg1", nodes: [{ id: 3, widgets_values: { frame_rate: 16, format: "video/h264-mp4" } }] }] } };
    const r = carryBack(workflow, [{ key: "sg1:3", index: "frame_rate", old: 16, new: 24 }]);
    assert.equal(r.applied.length, 1);
    assert.equal(r.workflow.definitions.subgraphs[0].nodes[0].widgets_values.frame_rate, 24);
    assert.equal(workflow.definitions.subgraphs[0].nodes[0].widgets_values.frame_rate, 16);
});

test("a seed the workflow re-rolled since queueing is a conflict", () => {
    const a       = run("a", { seed: 111 });
    const after   = edited(a, w => { w.nodes[1].widgets_values[0] = 222; });
    const changes = diffWidgets(a[3].extra_pnginfo.workflow, after[3].extra_pnginfo.workflow);
    const source  = structuredClone(a[3].extra_pnginfo.workflow);
    source.nodes[1].widgets_values[0] = 987654;                            // "randomize" fired after queueing
    const r = carryBack(source, changes);
    assert.deepEqual(r.applied, []);
    assert.deepEqual(r.conflicts.map(({ current }) => current), [987654]);
    assert.equal(r.workflow.nodes[1].widgets_values[0], 987654);
});

let failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
