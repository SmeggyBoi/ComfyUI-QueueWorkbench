// Run from the repo root: node tests/test_variations.mjs
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../web/queue_workbench.js", import.meta.url), "utf8").replace(/^import .*$/mg, "");
globalThis.window   = { matchMedia: () => ({ matches: true }) };
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
// A stand-in server for queueVariations: /prompt answers the k-th POST with answer(k), the
// history route serves historyItems by prompt_id, /queue is empty (the panel's refresh)
const calls  = [];   // fetched URLs, in order
const posted = [];   // bodies POSTed to /prompt
const toasts = [];
const OK     = { ok: true, body: { prompt_id: "new", number: 1, node_errors: {} } };
let answer       = () => OK;
let historyItems = {};
let gate         = null; // set to a promise to delay the next /prompt response once
const api = {
    clientId: "tab-1",
    addEventListener() {},
    async fetchApi(url, options = {}) {
        calls.push(url);
        if (url === "/prompt") {
            posted.push(JSON.parse(options.body));
            if (gate) { await gate; gate = null; }
            const { ok, body } = answer(posted.length - 1);
            return { ok, json: async () => body };
        }
        if (url === "/queue") return { ok: true, json: async () => ({ queue_running: [], queue_pending: [] }) };
        const prompt = historyItems[decodeURIComponent(url.replace("/queue_workbench/history/", ""))];
        return { ok: !!prompt, json: async () => ({ run: { prompt } }) };
    },
};
const app = { registerExtension() {}, extensionManager: { toast: { add: t => toasts.push(t) } } };
const { rerollSeeds, variationBody, variationCountFrom, queueVariations, detailHtml, groupInfo } = new Function("app", "api",
    src + "\nreturn { rerollSeeds, variationBody, variationCountFrom, queueVariations, detailHtml, groupInfo };")(app, api);

function server(reply = () => OK) {
    calls.length = 0;
    posted.length = 0;
    toasts.length = 0;
    answer = reply;
    gate = null;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// A fake Math.random returning the given values in turn. New seed = 1 + floor(r * (2^31 - 1)):
// 0.25 -> 2^29, 0.5 -> 2^30, 0.75 -> 3 * 2^29, 0 -> 1
const seq = (...values) => { let i = 0; return () => values[i++ % values.length]; };
const S1 = 2 ** 29, S2 = 2 ** 30, S3 = 3 * 2 ** 29;
// API prompt keys iterate as integer-like ids ascending, then the "a:b" ids in insertion order,
// so seeds are drawn in that order.

const SG = "bc1c967a-7f6a-4be9-a372-dad16e4f28e3", OUTER = "aa3468ae-0000-4000-8000-000000000001", INNER = "bb5d091e-0000-4000-8000-000000000002";
const run = (prompt, workflow, extra = {}) => [5, "old-id", prompt, { ...extra, extra_pnginfo: { workflow } }, ["9"]];

test("every non-zero seed gets a new one; equal seeds stay equal; 0, links and other inputs stay", () => {
    const item = run({
        "3":  { class_type: "KSampler", inputs: { seed: 111, steps: 8, cfg: 1, model: ["4", 0] } },
        "4":  { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
        "10": { class_type: "RandomNoise", inputs: { noise_seed: 222 } },
        "11": { class_type: "easy seed", inputs: { seed: 222, seed_mode: "fixed" } },
        "12": { class_type: "KSampler", inputs: { seed: ["11", 0], steps: 8 } },
        "13": { class_type: "H3ChainLoop", inputs: { clip_seed_1: 333, clip_seed_2: 0 } },
    }, { id: "wf", nodes: [] });
    const { prompt, changed } = rerollSeeds(item, seq(0.25, 0.5, 0.75));
    assert.equal(changed, 4);
    assert.deepEqual(prompt["3"].inputs, { seed: S1, steps: 8, cfg: 1, model: ["4", 0] });
    assert.equal(prompt["10"].inputs.noise_seed, S2);
    assert.deepEqual(prompt["11"].inputs, { seed: S2, seed_mode: "fixed" }, "the same old seed, the same new one");
    assert.deepEqual(prompt["12"].inputs.seed, ["11", 0], "a linked seed changes at its source");
    assert.deepEqual(prompt["13"].inputs, { clip_seed_1: S3, clip_seed_2: 0 }, "unused 0 slots stay 0");
    assert.deepEqual(prompt["4"], item[2]["4"]);
});

test("a new seed is an integer in [1, 2^31 - 1] and never the old one", () => {
    const one = rerollSeeds(run({ "3": { inputs: { seed: 1 } } }, null), seq(0, 0.9999999999)).prompt["3"].inputs.seed;
    assert.equal(one, 1 + Math.floor(0.9999999999 * (2 ** 31 - 1)), "the draw that gave the old seed is thrown away");
    assert.ok(Number.isInteger(one) && one <= 2 ** 31 - 1);
    assert.equal(rerollSeeds(run({ "3": { inputs: { seed: 5 } } }, null), seq(0)).prompt["3"].inputs.seed, 1);
    for (let i = 0; i < 200; i++) {
        const seed = rerollSeeds(run({ "3": { inputs: { seed: 7 } } }, null)).prompt["3"].inputs.seed;
        assert.ok(Number.isInteger(seed) && seed >= 1 && seed <= 2 ** 31 - 1 && seed !== 7, String(seed));
    }
});

test("a decimal seed-named input is left alone and not counted as a seed", () => {
    const item = run({ "3": { class_type: "KSampler", inputs: { seed: 111, variation_seed_strength: 0.3 } } }, { id: "wf", nodes: [] });
    const { prompt, changed } = rerollSeeds(item, seq(0.25));
    assert.equal(changed, 1);
    assert.equal(prompt["3"].inputs.variation_seed_strength, 0.3);
    assert.equal(prompt["3"].inputs.seed, S1);
});

test("workflow widgets follow on root nodes, subgraph instances, the nodes inside and nested paths", () => {
    const item = run({
        "3":           { class_type: "KSampler", inputs: { seed: 1, steps: 8, cfg: 1 } },
        "459:451":     { class_type: "KSampler", inputs: { seed: 444, steps: 25 } },
        "500:501:502": { class_type: "KSampler", inputs: { seed: 555, steps: 20 } },
    }, {
        id: "wf",
        nodes: [
            { id: 3, type: "KSampler", widgets_values: [1, "fixed", 8, 1, "euler", "simple", 1] },
            // a seed promoted to a subgraph input: the instance holds it, the node inside a stale 0
            { id: 459, type: SG, widgets_values: ["a prompt", 25, 444] },
            { id: 500, type: OUTER, widgets_values: [] },
        ],
        definitions: { subgraphs: [
            { id: SG, nodes: [{ id: 451, type: "KSampler", widgets_values: [0, "randomize", 25, 1, "euler", "simple", 1] }] },
            { id: OUTER, nodes: [{ id: 501, type: INNER, widgets_values: [] }] },
            { id: INNER, nodes: [{ id: 502, type: "KSampler", widgets_values: [555, "fixed", 20, 1, "euler", "simple", 1] }] },
        ] },
    });
    const { workflow } = rerollSeeds(item, seq(0.25, 0.5, 0.75));
    assert.deepEqual(workflow.nodes[0].widgets_values, [S1, "fixed", 8, 1, "euler", "simple", 1], "seed 1 changes, cfg 1 stays");
    assert.deepEqual(workflow.nodes[1].widgets_values, ["a prompt", 25, S2]);
    assert.deepEqual(workflow.definitions.subgraphs[0].nodes[0].widgets_values, [0, "randomize", 25, 1, "euler", "simple", 1]);
    assert.deepEqual(workflow.definitions.subgraphs[2].nodes[0].widgets_values, [S3, "fixed", 20, 1, "euler", "simple", 1]);
});

test("one subgraph seed feeding two nodes inside changes the instance once", () => {
    const item = run({
        "459:451": { class_type: "KSampler", inputs: { seed: 7, cfg: 7 } },
        "459:452": { class_type: "RandomNoise", inputs: { noise_seed: 7 } },
    }, {
        id: "wf",
        nodes: [{ id: 459, type: SG, widgets_values: ["a prompt", 7, 7] }],   // [prompt, seed, cfg]
        definitions: { subgraphs: [{ id: SG, nodes: [
            { id: 451, type: "KSampler", widgets_values: [0, "randomize", 8, 7] },
            { id: 452, type: "RandomNoise", widgets_values: [0, "randomize"] },
        ] }] },
    });
    const { prompt, workflow, changed } = rerollSeeds(item, seq(0.5));
    assert.equal(changed, 2);
    assert.deepEqual([prompt["459:451"].inputs, prompt["459:452"].inputs], [{ seed: S2, cfg: 7 }, { noise_seed: S2 }]);
    assert.deepEqual(workflow.nodes[0].widgets_values, ["a prompt", S2, 7]);
    assert.deepEqual(workflow.definitions.subgraphs[0].nodes[0].widgets_values, [0, "randomize", 8, 7], "inner node unchanged when seed is promoted");
    assert.deepEqual(workflow.definitions.subgraphs[0].nodes[1].widgets_values, [0, "randomize"], "second inner node unchanged");
});

test("non-promoted seed lives in the inner node, not the instance", () => {
    const item = run({
        "459:451": { class_type: "KSampler", inputs: { seed: 8, cfg: 7 } },
    }, {
        id: "wf",
        nodes: [{ id: 459, type: SG, widgets_values: ["a prompt", 25, 7] }],   // [prompt, something, cfg]—no seed
        definitions: { subgraphs: [{ id: SG, nodes: [
            { id: 451, type: "KSampler", widgets_values: [8, "fixed", 8, 7] },   // seed at position 0
        ] }] },
    });
    const { prompt, workflow, changed } = rerollSeeds(item, seq(0.75));
    assert.equal(changed, 1);
    assert.equal(prompt["459:451"].inputs.seed, S3);
    assert.deepEqual(workflow.nodes[0].widgets_values, ["a prompt", 25, 7], "instance unchanged");
    assert.deepEqual(workflow.definitions.subgraphs[0].nodes[0].widgets_values, [S3, "fixed", 8, 7], "inner node seed changes");
});

test("object widgets_values (VHS style) are patched by value", () => {
    const item = run({ "20": { class_type: "CustomNoise", inputs: { frame_rate: 16, seed: 666 } } },
        { id: "wf", nodes: [{ id: 20, type: "CustomNoise", widgets_values: { frame_rate: 16, seed: 666, videopreview: { hidden: false } } }] });
    assert.deepEqual(rerollSeeds(item, seq(0.25)).workflow.nodes[0].widgets_values, { frame_rate: 16, seed: S1, videopreview: { hidden: false } });
});

test("no GUI node for a seed: the prompt is still re-rolled, the workflow left as it is", () => {
    const workflow = { id: "wf", nodes: [
        { id: 4, type: "KSampler", widgets_values: [9, "fixed"] },
        { id: 77, type: "workflow>My group", widgets_values: [10, "fixed"] },   // a legacy group node, not a subgraph
    ] };
    const item = run({ "3": { inputs: { seed: 9 } }, "77:0": { inputs: { seed: 10 } } }, workflow);
    const result = rerollSeeds(item, seq(0.25, 0.5));
    assert.equal(result.changed, 2);
    assert.deepEqual([result.prompt["3"].inputs.seed, result.prompt["77:0"].inputs.seed], [S1, S2]);
    assert.deepEqual(result.workflow, workflow);
    const scripted = rerollSeeds([0, "s", { "3": { inputs: { seed: 9 } } }, {}, []], seq(0.25));
    assert.equal(scripted.prompt["3"].inputs.seed, S1);
    assert.equal(scripted.workflow, null);
    assert.equal(rerollSeeds([0, "e", { "3": { inputs: { steps: 8, seed: 0 } } }, {}, []]).changed, 0);
});

test("variation body: re-queue shape with the new seeds in graph and workflow; original untouched", () => {
    const item = run({ "3": { class_type: "KSampler", inputs: { seed: 42, steps: 8 } } },
        { id: "wf", nodes: [{ id: 3, type: "KSampler", widgets_values: [42, "randomize", 8] }], extra: { qm_name: "Wf.json", qm_queued_at: 1 } },
        { client_id: "phone", create_time: 1, preview_method: "auto", qm_retry_of: "x" });
    const original = structuredClone(item);
    const before   = Date.now();
    const body     = variationBody(item, "desktop", seq(0.5));
    assert.deepEqual(Object.keys(body).sort(), ["client_id", "extra_data", "partial_execution_targets", "prompt"], "no prompt_id: the server picks one");
    assert.equal(body.client_id, "desktop");
    assert.deepEqual(body.partial_execution_targets, ["9"]);
    assert.deepEqual(body.prompt, { "3": { class_type: "KSampler", inputs: { seed: S2, steps: 8 } } });
    assert.deepEqual(Object.keys(body.extra_data).sort(), ["extra_pnginfo", "preview_method"]);
    const workflow = body.extra_data.extra_pnginfo.workflow;
    assert.deepEqual(workflow.nodes[0].widgets_values, [S2, "randomize", 8]);
    assert.equal(workflow.extra.qm_name, "Wf.json");
    assert.ok(workflow.extra.qm_queued_at >= before, "fresh queue time");
    assert.deepEqual(item, original, "original untouched");
    assert.notEqual(variationBody(item, "desktop", seq(0.25)).prompt["3"].inputs.seed, body.prompt["3"].inputs.seed, "each body draws its own seeds");
    const scripted = variationBody([0, "s", { "3": { inputs: { seed: 5 } } }, { client_id: "a" }, []], "c", seq(0.5));
    assert.deepEqual(scripted.extra_data, {});
    assert.equal(scripted.prompt["3"].inputs.seed, S2);
});

// A queued run of "Wf": one KSampler, its seed also in the GUI node
const wfRun = (seed = 111) => run({ "3": { class_type: "KSampler", _meta: { title: "KSampler" }, inputs: { seed, steps: 8 } } },
    { id: "wf", nodes: [{ id: 3, type: "KSampler", widgets_values: [seed, "randomize", 8] }], extra: { qm_name: "Wf.json" } });
const historyRun = item => ({ id: 1, item, outputs: {}, status: null });

test("detail cards: 🎲 New seed and 🎲 × on finished runs, ⧉ × on pending and running ones, none on saved ones", () => {
    const item = wfRun();
    const info = groupInfo([item]).get("old-id");
    const finished = detailHtml(item, info, "✓ Finished 14:32 · 3m 12s", historyRun(item));
    for (const part of [`class="qm-vary-one"`, "🎲 New seed", `class="qm-vary-many"`, "🎲 ×", `class="qm-vary-count"`, `min="1"`, `max="20"`, `value="4"`]) {
        assert.ok(finished.includes(part), part);
    }
    for (const where of ["#2 of 3", "Running"]) {
        const html = detailHtml(item, info, where);
        assert.ok(html.includes("⧉ ×") && html.includes(`class="qm-vary-count"`), where);
        assert.ok(!html.includes("qm-vary-one") && !html.includes("🎲"), where);
    }
    assert.ok(!detailHtml(item, info, "Saved").includes("qm-vary"));
});

test("the ×N field: rounded into 1–20, the previous N when empty or not a number", () => {
    assert.equal(variationCountFrom("7", 4), 7);
    assert.equal(variationCountFrom("2.6", 4), 3);
    assert.equal(variationCountFrom("0", 4), 1);
    assert.equal(variationCountFrom("-3", 4), 1);
    assert.equal(variationCountFrom("50", 4), 20);
    assert.equal(variationCountFrom("", 6), 6);
    assert.equal(variationCountFrom("e", 6), 6);
});

test("variations of a finished run: its full entry first, then N posts in a row, each with its own seeds", async () => {
    server();
    const full = wfRun();
    historyItems = { "old-id": full };
    const listed = [5, "old-id", full[2], { extra_pnginfo: { workflow: { id: "wf", extra: { qm_name: "Wf.json" } } } }, ["9"]];
    await queueVariations(listed, historyRun(listed), 3);
    assert.equal(calls[0], "/queue_workbench/history/old-id");
    assert.equal(posted.length, 3);
    assert.equal(new Set([111, ...posted.map(b => b.prompt["3"].inputs.seed)]).size, 4, "three new seeds, none the old one");
    for (const body of posted) {
        assert.equal(body.client_id, "tab-1");
        assert.ok(!("prompt_id" in body) && !("number" in body) && !("front" in body), "end of the queue, the server picks the ids");
        assert.equal(body.extra_data.extra_pnginfo.workflow.nodes[0].widgets_values[0], body.prompt["3"].inputs.seed, "the outputs' workflow has the seed used");
        assert.ok(body.prompt["3"].inputs.seed <= 2 ** 31 - 1, "fits 32-bit-capped seed inputs");
    }
    assert.deepEqual(toasts.map(t => [t.severity, t.summary]), [["success", "Queued 3 variations of Wf"]]);
    assert.equal(calls.at(-1), "/queue", "the panel refreshes");
    server();
    await queueVariations(listed, historyRun(listed), 1);
    assert.equal(toasts[0].summary, "Queued 1 variation of Wf");
});

test("a rejected variation stops the series and says how many were queued", async () => {
    const rejected = { ok: false, body: { error: { message: "Prompt outputs failed validation" },
        node_errors: { "3": { errors: [{ message: "Value bigger than max", details: "seed, 562949953421312 > 4294967295" }], class_type: "KSampler" } } } };
    server(k => k === 1 ? rejected : OK);
    await queueVariations(wfRun(), null, 4);
    assert.equal(posted.length, 2, "nothing after the rejection");
    assert.deepEqual(toasts.map(t => [t.severity, t.summary, t.detail]), [["error", "Couldn't queue variation 2 of 4",
        "KSampler: Value bigger than max (seed, 562949953421312 > 4294967295) — 1 of 4 queued"]]);
    assert.equal(calls.at(-1), "/queue", "the one that got queued shows up");
    server(() => rejected);
    await queueVariations(wfRun(), null, 2);
    assert.equal(posted.length, 1);
    assert.match(toasts[0].detail, / — 0 of 2 queued$/);
    assert.ok(!calls.includes("/queue"), "nothing queued, nothing to refresh");
});

test("node_errors on a 200 answer: the series stops, that run still counts as queued", async () => {
    const partial = { ok: true, body: { prompt_id: "new", number: 1, node_errors: {
        "3": { errors: [{ message: "Value bigger than max", details: "seed, 4294967296 > 4294967295" }], class_type: "KSampler" } } } };
    server(k => k === 1 ? partial : OK);
    await queueVariations(wfRun(), null, 4);
    assert.equal(posted.length, 2, "nothing after the partially-queued run");
    assert.deepEqual(toasts.map(t => [t.severity, t.summary, t.detail]), [["warn", "Variation 2 of 4 skipped some outputs",
        "KSampler: Value bigger than max (seed, 4294967296 > 4294967295) — 2 of 4 queued"]]);
    assert.equal(calls.at(-1), "/queue", "it was queued, so the panel refreshes");
});

test("a network failure mid-series: the toast says how many queued, no more posts follow", async () => {
    server(k => { if (k === 1) throw new Error("Failed to fetch"); return OK; });
    await queueVariations(wfRun(), null, 3);
    assert.equal(posted.length, 2, "the attempt that failed still counts as a post");
    assert.deepEqual(toasts.map(t => [t.severity, t.summary, t.detail]),
        [["error", "Couldn't queue variation 2 of 3", "Failed to fetch — 1 of 3 queued"]]);
    assert.equal(calls.at(-1), "/queue", "the one that queued shows up");
    server(() => { throw new Error("Failed to fetch"); });
    await queueVariations(wfRun(), null, 2);
    assert.ok(!calls.includes("/queue"), "nothing queued yet, nothing to refresh");
});

test("a second ×N click while one is still posting doesn't start a second series", async () => {
    server();
    let release;
    gate = new Promise(resolve => { release = resolve; });
    const first  = queueVariations(wfRun(), null, 4);
    const second = queueVariations(wfRun(), null, 4);
    release();
    await Promise.all([first, second]);
    assert.equal(posted.length, 4, "the overlapping click posted nothing");
});

test("a finished run removed from the history meanwhile: an error, nothing queued", async () => {
    server();
    historyItems = {};
    const item = wfRun();
    await assert.rejects(queueVariations(item, historyRun(item), 4), /no longer in the history/);
    assert.equal(posted.length, 0);
});

test("a queued run without seeds is queued as identical runs, and the toast says so", async () => {
    server();
    const item = run({ "3": { class_type: "KSampler", inputs: { seed: 0, steps: 8 } } }, { id: "wf", nodes: [], extra: { qm_name: "Wf.json" } });
    await queueVariations(item, null, 2);
    assert.equal(calls[0], "/prompt", "a queued run carries its full workflow");
    assert.deepEqual(posted.map(b => b.prompt), [item[2], item[2]]);
    assert.deepEqual(toasts.map(t => [t.severity, t.summary]), [["warn", "No seeds found — queued 2 identical runs of Wf"]]);
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
