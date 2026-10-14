// Run from the repo root: node tests/test_freeze.mjs
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../web/queue_workbench.js", import.meta.url), "utf8").replace(/^import .*$/mg, "");
// Enough DOM for the edit bar: every element is a stand-in that accepts anything
const fake = () => new Proxy(function () {}, {
    get: (t, k) => k === Symbol.toPrimitive ? () => "" : fake(), set: () => true, apply: () => fake(),
});
globalThis.window   = { matchMedia: () => ({ matches: true }), innerWidth: 1000, addEventListener() {} };
globalThis.document = { getElementById: () => null, addEventListener() {}, removeEventListener() {},
                        createElement: () => fake(), body: { appendChild() {} }, querySelectorAll: () => [] };
const api = { addEventListener() {} };
const { freezeTagHtml, queueTexts, freezeNote, freezeFor } = new Function("app", "api",
    src + "\nreturn { freezeTagHtml, queueTexts, freezeNote, freezeFor };")({ registerExtension() {} }, api);

const pending = ["a", "b", "c"].map((id, i) => [i, id, {}, {}, []]);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("status tag: paused, frozen by an edit, both; Unfreeze only while an edit holds the queue", () => {
    assert.equal(freezeTagHtml({ paused: false, editing: [] }, pending), "");
    const paused = freezeTagHtml({ paused: true, editing: [] }, pending);
    assert.ok(paused.includes(">PAUSED<") && !paused.includes("qm-unfreeze"), paused);
    const frozen = freezeTagHtml({ paused: false, editing: ["b"] }, pending);
    assert.ok(frozen.includes(">FROZEN — editing #2<") && frozen.includes("qm-unfreeze"), frozen);
    const both = freezeTagHtml({ paused: true, editing: ["c", "a"] }, pending);
    assert.ok(both.includes(">PAUSED · editing #3 and #1<"), both);
});

test("an edited run the panel doesn't list yet doesn't show as #0", () => {
    assert.equal(freezeTagHtml({ paused: false, editing: ["zzz"] }, pending), "");
});

test("while frozen nothing counts down: no start times or queue end, ⏸ on the badge when runs wait", () => {
    const est = { now: 0, running: null, pending: { a: { estimate_ms: 60_000 }, b: { estimate_ms: 60_000 } }, remaining_ms: 120_000, unknown: 0 };
    const live = queueTexts(est, ["a", "b"], false);
    assert.equal(live.badge, "2m");
    assert.ok(live.end.startsWith("queue empty ~"), live.end);
    assert.equal(Object.keys(live.starts).length, 2);
    assert.deepEqual(queueTexts(est, ["a", "b"], true), { badge: "⏸", end: "", starts: {} });
    const runningOnly = { now: 0, running: { prompt_id: "r", estimate_ms: 60_000, started_at: 0 }, pending: {}, remaining_ms: 60_000, unknown: 0 };
    assert.equal(queueTexts(runningOnly, [], true).badge, "1m");
});

test("edit bar: queue frozen for this edit, paused, or running again after an Unfreeze elsewhere", () => {
    const session = { promptId: "b", token: "t1" };
    assert.equal(freezeNote(session, { paused: false, editing: ["b"] }), " · queue frozen");
    assert.equal(freezeNote(session, { paused: true, editing: [] }), " · queue paused");
    assert.equal(freezeNote(session, { paused: false, editing: [] }), " · queue running — this run may start");
    assert.equal(freezeNote({ promptId: "b", token: null }, { paused: false, editing: [] }), "");
});

test("freezing for an edit: frozen, already started (409), or an older backend (404)", async () => {
    const answers = {
        200: { ok: true, status: 200, json: async () => ({ paused: false, editing: ["b"] }) },
        409: { ok: false, status: 409, json: async () => ({ not_pending: true }) },
        404: { ok: false, status: 404, json: async () => ({}) },
    };
    const posted = [];
    for (const [code, expected] of [[200, "frozen"], [409, "started"], [404, "unsupported"]]) {
        api.fetchApi = async (url, opts) => { posted.push([url, JSON.parse(opts.body)]); return answers[code]; };
        assert.equal(await freezeFor("b", "t1"), expected);
    }
    assert.deepEqual(posted[0], ["/queue_workbench/freeze", { edit: "b", token: "t1", on: true }]);
});

// A panel whose ✎ opens a tab after 50 ms (or fails to); posts = the freeze requests it sent
function editingPanel(loadGraphData) {
    const posts = [];
    const store = { openWorkflows: [], activeWorkflow: { path: "workflows/main.json" } };
    store.openWorkflows.push(store.activeWorkflow);
    let n = 0;
    const panelApp = {
        registerExtension() {},
        extensionManager: { workflow: store, toast: { add() {} } },
        loadGraphData: loadGraphData ?? (async (wf, a, b, name) => {
            await new Promise(r => setTimeout(r, 50));
            const tab = { path: `workflows/${name}${n++ ? ` (${n})` : ""}.json` };
            store.openWorkflows.push(tab);
            store.activeWorkflow = tab;
        }),
        graphToPrompt: async () => ({ output: {}, workflow: {} }),
    };
    const panelApi = { addEventListener() {}, fetchApi: async (url, opts) => {
        if (opts) posts.push(JSON.parse(opts.body));
        const body = url === "/queue" ? { queue_running: [], queue_pending: [] } : { paused: false, editing: ["run-b"] };
        return { ok: true, status: 200, json: async () => body };
    } };
    const panel = new Function("app", "api", src + "\nreturn { editQueuedRun, editSessions, endEditSession };")(panelApp, panelApi);
    const held = () => {
        const off = posts.filter(p => p.on === false).map(p => p.token);
        return posts.filter(p => p.on === true).map(p => p.token).filter(t => !off.includes(t));
    };
    return { ...panel, posts, held };
}
const edited = [2, "run-b", {}, { extra_pnginfo: { workflow: { nodes: [] } } }, []];

test("a double click on ✎ freezes once, and ending the edit leaves nothing holding the queue", async () => {
    const panel = editingPanel();
    await Promise.all([panel.editQueuedRun(edited), new Promise(r => setTimeout(r, 20)).then(() => panel.editQueuedRun(edited))]);
    assert.equal(panel.editSessions.size, 1);
    assert.equal(panel.posts.filter(p => p.on === true).length, 1, "one freeze for one edit");
    for (const s of [...panel.editSessions.values()]) panel.endEditSession(s);
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(panel.held(), []);
});

test("a tab that fails to load doesn't leave the queue frozen", async () => {
    const panel = editingPanel(async () => { throw new Error("bad graph"); });
    await assert.rejects(panel.editQueuedRun(edited), /bad graph/);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(panel.posts.filter(p => p.on === true).length, 1);
    assert.deepEqual(panel.held(), []);
    assert.equal(panel.editSessions.size, 0);
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
