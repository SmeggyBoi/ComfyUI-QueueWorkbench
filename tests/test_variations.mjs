// Run from the repo root: node tests/test_variations.mjs
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../web/queue_workbench.js", import.meta.url), "utf8").replace(/^import .*$/mg, "");
globalThis.window   = { matchMedia: () => ({ matches: true }) };
globalThis.document = { getElementById: () => null };
const { rerollSeeds, variationBody } = new Function("app", "api",
    src + "\nreturn { rerollSeeds, variationBody };")({ registerExtension() {} }, { addEventListener() {} });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// A fake Math.random returning the given values in turn. New seed = 1 + floor(r * (2^50 - 1)):
// 0.25 -> 2^48, 0.5 -> 2^49, 0.75 -> 3 * 2^48, 0 -> 1
const seq = (...values) => { let i = 0; return () => values[i++ % values.length]; };
const S1 = 2 ** 48, S2 = 2 ** 49, S3 = 3 * 2 ** 48;
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

test("a new seed is an integer in [1, 2^50) and never the old one", () => {
    const one = rerollSeeds(run({ "3": { inputs: { seed: 1 } } }, null), seq(0, 0.9999999999)).prompt["3"].inputs.seed;
    assert.equal(one, 1 + Math.floor(0.9999999999 * (2 ** 50 - 1)), "the draw that gave the old seed is thrown away");
    assert.ok(Number.isInteger(one) && one < 2 ** 50);
    assert.equal(rerollSeeds(run({ "3": { inputs: { seed: 5 } } }, null), seq(0)).prompt["3"].inputs.seed, 1);
    for (let i = 0; i < 200; i++) {
        const seed = rerollSeeds(run({ "3": { inputs: { seed: 7 } } }, null)).prompt["3"].inputs.seed;
        assert.ok(Number.isInteger(seed) && seed >= 1 && seed < 2 ** 50 && seed !== 7, String(seed));
    }
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

let failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
