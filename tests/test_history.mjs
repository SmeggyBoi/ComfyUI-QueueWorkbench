// Run from the repo root: node tests/test_history.mjs
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../web/queue_workbench.js", import.meta.url), "utf8").replace(/^import .*$/mg, "");
globalThis.window   = { matchMedia: () => ({ matches: true }) };
globalThis.document = { getElementById: () => null };
const api = { addEventListener() {} };   // the History tests below set api.fetchApi
const { runResult, fmtDuration, finishedInfo, outputMedia, requeueBody, mergeNewRuns, historyRowHtml, detailHtml, groupInfo, historyQuery, workflowOptionsHtml,
        refreshHistory, setHistoryFilter, clearHistoryFilter, togglePin, historyState } = new Function("app", "api",
    src + "\nreturn { runResult, fmtDuration, finishedInfo, outputMedia, requeueBody, mergeNewRuns, historyRowHtml, detailHtml, groupInfo, historyQuery, workflowOptionsHtml,"
        + " refreshHistory, setHistoryFilter, clearHistoryFilter, togglePin, historyState: () => ({ historyRuns, historyNewestId }) };")({ registerExtension() {} }, api);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const START = Date.UTC(2026, 9, 3, 12, 0, 0);
function status(state, { ms = 192_000, error = "CUDA out of memory" } = {}) {
    const end = state === "success" ? ["execution_success", { prompt_id: "a", timestamp: START + ms }]
        : state === "interrupted" ? ["execution_interrupted", { prompt_id: "a", node_id: "3", node_type: "KSampler", executed: [], timestamp: START + ms }]
        : ["execution_error", { prompt_id: "a", node_id: "3", node_type: "KSampler", exception_message: error, exception_type: "RuntimeError", traceback: [], timestamp: START + ms }];
    return {
        status_str: state === "success" ? "success" : "error",
        completed: state === "success",
        messages: [["execution_start", { prompt_id: "a", timestamp: START }], ["execution_cached", { nodes: [], prompt_id: "a", timestamp: START + 5 }], end],
    };
}

// A history item as the list route returns it: workflow cut down to id + extra
function histItem(id, name) {
    return [0, id, {
        "3": { class_type: "KSampler", _meta: { title: "KSampler" }, inputs: { steps: 8, cfg: 1, seed: 7 } },
        "4": { class_type: "LoadImage", inputs: { image: "input.png" } },
    }, { extra_pnginfo: { workflow: { id: "wf", extra: { qm_name: name } } } }, ["9"]];
}
const OUT = { "9": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } };

test("run result reads success, error and interrupt from the status messages", () => {
    assert.deepEqual(runResult(status("success")), { state: "success", startedAt: START, finishedAt: START + 192_000, error: null });
    const failed = runResult(status("error"));
    assert.equal(failed.state, "error");
    assert.deepEqual(failed.error, { node: "KSampler", message: "CUDA out of memory" });
    const interrupted = runResult(status("interrupted"));
    assert.equal(interrupted.state, "interrupted");
    assert.equal(interrupted.error, null);
    assert.equal(interrupted.finishedAt, START + 192_000);
    assert.deepEqual(runResult(null), { state: null, startedAt: null, finishedAt: null, error: null });
});

test("durations read like 42s, 3m 12s, 1h 04m", () => {
    assert.equal(fmtDuration(42_000), "42s");
    assert.equal(fmtDuration(192_000), "3m 12s");
    assert.equal(fmtDuration(185_000), "3m 05s");
    assert.equal(fmtDuration(3_840_000), "1h 04m");
    assert.equal(fmtDuration(400), "0s");
});

test("finished info: mark, label and time text; nothing for a missing status", () => {
    const f = finishedInfo({ status: status("interrupted", { ms: 42_000 }) });
    assert.equal(f.mark, "⏹");
    assert.equal(f.label, "Interrupted");
    assert.match(f.text, / · 42s$/);
    const unknown = finishedInfo({ status: null });
    assert.equal(unknown.mark, "");
    assert.equal(unknown.text, "");
    assert.equal(unknown.label, "Finished");
});

test("output media: saved outputs before temp previews, videos recognised, duplicates and non-media dropped", () => {
    const media = outputMedia({
        "7":  { a_images: [{ filename: "rgthree.compare._temp_1.png", subfolder: "", type: "temp" }] },
        "9":  { images: [{ filename: "Qwen_00166.png", subfolder: "", type: "output" }], animated: [false] },
        "12": { gifs: [{ filename: "clip_0001.mp4", subfolder: "vids", type: "output", format: "video/h264-mp4" }] },
        "13": { images: [{ filename: "Qwen_00166.png", subfolder: "", type: "output" }] },
        "14": { text: ["a prompt"] },
        "15": { latents: [{ filename: "x.latent", subfolder: "", type: "output" }] },
    });
    assert.deepEqual(media.map(m => m.label), ["Qwen_00166.png", "clip_0001.mp4", "rgthree.compare._temp_1.png"]);
    assert.deepEqual(media.map(m => m.video), [false, true, false]);
    assert.equal(media[1].url, "/view?filename=clip_0001.mp4&type=output&subfolder=vids");
    assert.deepEqual(outputMedia(undefined), []);
});

test("re-queue body: server picks the prompt_id, fresh queue time, this tab's client, original untouched", () => {
    const item = [3, "old-id", { "1": { inputs: { seed: 5 } } }, { client_id: "phone", create_time: 1, preview_method: "auto", qm_retry_of: "x",
        extra_pnginfo: { workflow: { id: "wf", nodes: [{ id: 1 }], extra: { qm_name: "Wf", qm_queued_at: 1 } } } }, ["9"]];
    const before = Date.now();
    const body = requeueBody(item, "desktop");
    assert.deepEqual(Object.keys(body).sort(), ["client_id", "extra_data", "partial_execution_targets", "prompt"]);
    assert.equal(body.client_id, "desktop");
    assert.equal(body.prompt, item[2], "same graph, same seed");
    assert.deepEqual(body.partial_execution_targets, item[4], "same outputs, incl. a 'queue selected output nodes' run");
    assert.equal("client_id" in body.extra_data, false);
    assert.equal("create_time" in body.extra_data, false);
    assert.equal("qm_retry_of" in body.extra_data, false);
    assert.equal(body.extra_data.preview_method, "auto");
    assert.equal(body.extra_data.extra_pnginfo.workflow.extra.qm_name, "Wf");
    assert.ok(body.extra_data.extra_pnginfo.workflow.extra.qm_queued_at >= before);
    assert.deepEqual(body.extra_data.extra_pnginfo.workflow.nodes, [{ id: 1 }]);
    assert.equal(item[3].extra_pnginfo.workflow.extra.qm_queued_at, 1, "original untouched");
    assert.equal(item[3].client_id, "phone");
    assert.deepEqual(requeueBody([0, "x", {}, {}, []], "c").extra_data, {});
});

test("new runs go on top; a prompt_id that finished again keeps only its newest run", () => {
    const r = (id, pid) => ({ id, item: [0, pid, {}, {}, []] });
    const merged = mergeNewRuns([r(3, "c"), r(2, "b"), r(1, "a")], [r(5, "e"), r(4, "b")]);
    assert.deepEqual(merged.map(x => x.id), [5, 4, 3, 1]);
});

test("history row: output thumbnail first, status mark, finish time and duration, escaped name, actions", () => {
    const run = { id: 1, item: histItem("a", "<b>Upscale</b>"), outputs: OUT, status: status("success") };
    const html = historyRowHtml(run, groupInfo([run.item]).get("a"));
    assert.ok(html.indexOf("filename=out.png") >= 0 && html.indexOf("filename=out.png") < html.indexOf("filename=input.png"));
    assert.ok(html.includes("✓"));
    assert.match(html, /3m 12s/);
    assert.ok(html.includes("&#60;b&#62;Upscale"));
    assert.ok(!html.includes("<b>Upscale"));
    for (const cls of ["qm-load-workflow", "qm-requeue-btn", "qm-history-delete"]) assert.ok(html.includes(cls), cls);
});

test("history row of a script-queued failed run: no workflow, no output, no status crash", () => {
    const item = [0, "api", { "3": { class_type: "KSampler", inputs: { steps: 8 } } }, {}, []];
    const failed = historyRowHtml({ id: 2, item, outputs: {}, status: status("error") }, groupInfo([item]).get("api"));
    assert.ok(failed.includes("✕"));
    assert.ok(!failed.includes("/view?"));
    assert.ok(!failed.includes("undefined"));
    const unknown = historyRowHtml({ id: 3, item, outputs: {}, status: null }, groupInfo([item]).get("api"));
    assert.ok(!unknown.includes("undefined"));
});

test("detail card of a finished run lists its outputs and the escaped error; live cards unchanged", () => {
    const run = { id: 1, item: histItem("a", "Wf"), outputs: OUT, status: status("error", { error: "bad <tensor>" }) };
    const info = groupInfo([run.item]).get("a");
    const html = detailHtml(run.item, info, "✕ Failed", run);
    assert.ok(html.includes("Outputs"));
    assert.ok(html.includes("Inputs"));
    assert.ok(html.includes("filename=out.png"));
    assert.ok(html.includes("KSampler: bad &#60;tensor&#62;"));
    const live = detailHtml(run.item, info, "Running");
    assert.ok(!live.includes("Outputs") && !live.includes("Inputs") && live.includes("filename=input.png"));
});

test("a retry after out-of-memory is marked in its row and detail card", () => {
    const item = histItem("b", "Wf");
    item[3].qm_retry_of = "aaaaaaaa-1111-2222-3333-444444444444";
    const run = { id: 2, item, outputs: OUT, status: status("success") };
    const info = groupInfo([item]).get("b");
    assert.ok(historyRowHtml(run, info).includes("↻"));
    assert.ok(detailHtml(item, info, "✓ Finished", run).includes("Retry of aaaaaaaa"));
    const plain = { id: 3, item: histItem("c", "Wf"), outputs: OUT, status: status("success") };
    assert.ok(!historyRowHtml(plain, groupInfo([plain.item]).get("c")).includes("↻"));
});

test("history query: the page or poll part, then only the filters that are set", () => {
    const none = { status: "", workflow: null, q: "" };
    assert.equal(historyQuery(none, { limit: 50 }), "limit=50");
    assert.equal(historyQuery({ status: "error", workflow: "Long Videos", q: "  sunlit shop " }, { limit: 50, before: 12 }),
        "limit=50&before=12&status=error&workflow=Long+Videos&q=sunlit+shop");
    assert.equal(historyQuery({ status: "", workflow: "", q: "   " }, { after: 7 }), "after=7&workflow=", "unnamed; only spaces is no search");
    assert.equal(historyQuery({ ...none, q: "100% a_b" }, {}), "q=100%25+a_b");
});

test("workflow filter: all, each workflow with its run count, unnamed; the chosen one stays listed", () => {
    const workflows = [{ name: "Long <b>Videos</b>", count: 12 }, { name: null, count: 3 }];
    assert.equal(workflowOptionsHtml(workflows, null), `<option value="" selected>All workflows</option>`
        + `<option value="=Long &#60;b&#62;Videos&#60;/b&#62;">Long &#60;b&#62;Videos&#60;/b&#62; (12)</option><option value="=">Unnamed (3)</option>`);
    assert.match(workflowOptionsHtml(workflows, ""), /<option value="=" selected>Unnamed \(3\)<\/option>/);
    assert.match(workflowOptionsHtml(workflows, "Gone"), /<option value="=Gone" selected>Gone \(0\)<\/option>$/);
    assert.equal(workflowOptionsHtml([], null), `<option value="" selected>All workflows</option>`, "workflows route failed: just All");
});

test("history row: ☆ before ⤴, a gold ★ once pinned; the detail card says Pinned", () => {
    const run  = { id: 1, item: histItem("a", "Wf"), outputs: OUT, status: status("success"), pinned: false };
    const info = groupInfo([run.item]).get("a");
    const html = historyRowHtml(run, info);
    assert.ok(html.includes("qm-pin-btn"));
    assert.ok(html.indexOf("☆") < html.indexOf("⤴"));
    assert.ok(!html.includes("★") && !html.includes("#f5c518"));
    const pinned = historyRowHtml({ ...run, pinned: true }, info);
    assert.ok(pinned.includes("★") && !pinned.includes("☆") && pinned.includes("#f5c518"));
    assert.ok(detailHtml(run.item, info, "✓ Finished", { ...run, pinned: true }).includes("Pinned"));
    assert.ok(!detailHtml(run.item, info, "✓ Finished", run).includes("Pinned"));
});

test("new runs past the cap: like the backend, only pinned runs stay beyond it", () => {
    const r = (id, pinned = false) => ({ id, item: [0, `p${id}`, {}, {}, []], pinned });
    assert.deepEqual(mergeNewRuns([r(3), r(2, true), r(1)], [r(5), r(4)], 3).map(x => x.id), [5, 4, 3, 2]);
});

// The History tab against a fake backend. These share the panel's state and run in order.
const answer = body => ({ ok: true, status: 200, json: async () => body });
const listed = (id, pid) => ({ id, prompt: histItem(pid, "Wf"), outputs: OUT, status: status("success"), pinned: false });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test("a filter change while a request is out: its answer is dropped and the new filter's first page loads", async () => {
    const requests = [];
    api.fetchApi = url => new Promise(resolve => requests.push({ url, resolve }));
    const done = refreshHistory();
    setHistoryFilter({ status: "error" });
    requests[0].resolve(answer({ runs: [listed(9, "old")], more: false }));
    await settle();
    assert.equal(requests[1].url, "/queue_workbench/history?limit=50&status=error");
    requests[1].resolve(answer({ runs: [listed(4, "failed")], more: false }));
    await done;
    assert.deepEqual(historyState().historyRuns.map(r => r.item[1]), ["failed"]);
    assert.equal(historyState().historyNewestId, 4, "the dropped answer moved no cursor");
});

test("Clear filters on an empty history: the plain empty state, not the filtered one", async () => {
    const list = { innerHTML: "", querySelector: () => null };
    const els  = { "qm-history": list, "qm-history-more": { style: {} }, "qm-filter-status": {}, "qm-filter-q": { value: "zebra" }, "qm-filter-workflow": {} };
    document.getElementById = id => els[id] ?? null;
    api.fetchApi = async () => answer({ runs: [], more: false });
    try {
        setHistoryFilter({ status: "", q: "zebra" });
        await settle();
        assert.match(list.innerHTML, /No runs match these filters/);
        clearHistoryFilter();
        await settle();
        assert.match(list.innerHTML, /No finished runs yet/);
        assert.equal(els["qm-filter-q"].value, "");
    } finally {
        document.getElementById = () => null;
    }
});

test("⭐ takes the server's answer; a run gone from the history leaves the list; another failure leaves the star", async () => {
    api.fetchApi = async () => answer({ runs: [listed(2, "b"), listed(1, "a")], more: false });
    setHistoryFilter({});
    await settle();
    const [b, a] = historyState().historyRuns;
    const sent = [];
    api.fetchApi = async (url, init) => { sent.push([url, JSON.parse(init.body)]); return answer({ pinned: true }); };
    await togglePin(a);
    assert.deepEqual(sent, [["/queue_workbench/history/pin", { prompt_id: "a", pinned: true }]]);
    assert.equal(a.pinned, true);
    api.fetchApi = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await togglePin(a);
    assert.equal(a.pinned, true);
    api.fetchApi = async () => ({ ok: false, status: 404, json: async () => ({ error: "not in history" }) });
    await togglePin(b);
    assert.deepEqual(historyState().historyRuns.map(r => r.item[1]), ["a"]);
});

test("two pin clicks before the first answer: only one POST; after it resolves, the next togglePin sends the opposite value", async () => {
    const run = { id: 1, item: histItem("z", "Wf"), outputs: OUT, status: status("success"), pinned: false };
    const sent = [];
    let resolveGate;
    const gate = new Promise(resolve => { resolveGate = resolve; });
    api.fetchApi = async (url, init) => {
        sent.push([url, JSON.parse(init.body)]);
        await gate;
        return answer({ pinned: true });
    };
    const first  = togglePin(run);
    const second = togglePin(run);
    assert.equal(sent.length, 1, "the second click while the first is out sends nothing");
    resolveGate();
    await Promise.all([first, second]);
    assert.equal(run.pinned, true);
    api.fetchApi = async (url, init) => { sent.push([url, JSON.parse(init.body)]); return answer({ pinned: false }); };
    await togglePin(run);
    assert.deepEqual(sent[1], ["/queue_workbench/history/pin", { prompt_id: "z", pinned: false }]);
});

let failed = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
