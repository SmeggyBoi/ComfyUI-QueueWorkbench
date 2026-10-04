// Run from the repo root: node tests/test_estimates.mjs
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../web/queue_workbench.js", import.meta.url), "utf8").replace(/^import .*$/mg, "");
globalThis.window   = { matchMedia: () => ({ matches: true }) };
globalThis.document = { getElementById: () => null };
const { fmtMinutes, leftText, runningRemaining, startTimes, runningProgress, showProgress, badgeText, queueEndText, estimateLine, detailHtml, groupInfo, fmtTime } = new Function("app", "api",
    src + "\nreturn { fmtMinutes, leftText, runningRemaining, startTimes, runningProgress, showProgress, badgeText, queueEndText, estimateLine, detailHtml, groupInfo, fmtTime };")({ registerExtension() {} }, { addEventListener() {} });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// The server's clock, years off this machine's: nothing may mix in Date.now()
const NOW = Date.UTC(2031, 0, 15, 20, 0, 0);
const MIN = 60_000;
const known = (min, basis = "settings", runs = 5) => ({ estimate_ms: min * MIN, basis, runs });
const NONE  = { estimate_ms: null, basis: null, runs: 0 };
// An estimates answer; by default "run" started 20 min ago with a 30 min estimate
function est({ running = { prompt_id: "run", started_at: NOW - 20 * MIN, ...known(30), node: "3", value: 4, max: 8 },
               pending = {}, remaining_ms = 0, unknown = 0 } = {}) {
    return { now: NOW, running, pending, remaining_ms, unknown };
}
const RUN_ITEM = [0, "run", {
    "3":       { class_type: "KSamplerAdvanced", _meta: { title: "High noise" }, inputs: { steps: 8 } },
    "459:451": { class_type: "KSampler", inputs: { steps: 8 } },
}, {}, ["9"]];

test("minutes read like <1m, 8m, 1h 12m; the time left like ~12 min left", () => {
    assert.equal(fmtMinutes(20_000), "<1m");
    assert.equal(fmtMinutes(8 * MIN), "8m");
    assert.equal(fmtMinutes(8 * MIN + 20_000), "8m");
    assert.equal(fmtMinutes(72 * MIN), "1h 12m");
    assert.equal(fmtMinutes(64 * MIN), "1h 04m");
    assert.equal(fmtMinutes(59 * MIN + 50_000), "1h 00m");
    assert.equal(leftText(12 * MIN), "~12 min left");
    assert.equal(leftText(10_000), "<1 min left");
    assert.equal(leftText(72 * MIN), "~1h 12m left");
});

test("the running run's remaining time by its estimate", () => {
    assert.equal(runningRemaining(est()), 10 * MIN);
    assert.equal(runningRemaining(est({ running: { prompt_id: "run", started_at: NOW - 40 * MIN, ...known(30) } })), 0, "past the estimate");
    assert.equal(runningRemaining(est({ running: { prompt_id: "run", started_at: null, ...known(30) } })), 30 * MIN, "start unknown");
    assert.equal(runningRemaining(est({ running: { prompt_id: "run", started_at: NOW, ...NONE } })), null);
    assert.equal(runningRemaining(est({ running: null })), null);
    assert.equal(runningRemaining(null), null);
});

test("start times add up in queue order and become a lower bound after a run without an estimate", () => {
    const e = est({ pending: { a: known(5), b: null, c: known(3) } });
    assert.deepEqual(startTimes(e, ["a", "b", "c", "d"]), {
        a: { at: NOW + 10 * MIN, exact: true },
        b: { at: NOW + 15 * MIN, exact: true },
        c: { at: NOW + 15 * MIN, exact: false },
        d: { at: NOW + 18 * MIN, exact: false },   // queued since the estimates were fetched
    });
    assert.deepEqual(startTimes(est({ running: null, pending: { a: known(5) } }), ["a"]), { a: { at: NOW, exact: true } }, "nothing running: next up now");
    assert.deepEqual(startTimes(null, ["a"]), {});
});

test("a running run without an estimate makes every start a lower bound; a bound of just now is left out", () => {
    const e = est({ running: { prompt_id: "run", started_at: NOW - MIN, ...NONE }, pending: { a: known(5), b: known(5) } });
    assert.deepEqual(startTimes(e, ["a", "b"]), { a: null, b: { at: NOW + 5 * MIN, exact: false } });
});

test("a running run past its estimate makes every start a lower bound too, instead of an exact time that slides every poll", () => {
    const e = est({ running: { prompt_id: "run", started_at: NOW - 40 * MIN, ...known(30) }, pending: { a: known(5), b: known(5) } });
    assert.deepEqual(startTimes(e, ["a", "b"]), { a: null, b: { at: NOW + 5 * MIN, exact: false } });
});

test("running row: time-based bar capped at 99 %, then running longer than usual", () => {
    assert.deepEqual(runningProgress(est(), RUN_ITEM), { fraction: 20 / 30, label: "~10 min left" });
    const almost = est({ running: { prompt_id: "run", started_at: NOW - 29.9 * MIN, ...known(30) } });
    assert.equal(runningProgress(almost, RUN_ITEM).fraction, 0.99);
    assert.deepEqual(runningProgress(est({ running: { prompt_id: "run", started_at: NOW - 31 * MIN, ...known(30) } }), RUN_ITEM),
        { fraction: null, label: "running longer than usual" });
});

test("running row without an estimate: the current node's progress under its title; nothing without data", () => {
    const noEstimate = (node, value, max) => est({ running: { prompt_id: "run", started_at: NOW - MIN, ...NONE, node, value, max } });
    assert.deepEqual(runningProgress(noEstimate("3", 12, 30), RUN_ITEM), { fraction: 0.4, label: "High noise · 12/30" });
    assert.deepEqual(runningProgress(noEstimate("459:451", 3, 8), RUN_ITEM), { fraction: 3 / 8, label: "KSampler · 3/8" });
    assert.deepEqual(runningProgress(noEstimate("77", 1, 4), RUN_ITEM), { fraction: 0.25, label: "1/4" }, "node not in the prompt");
    assert.equal(runningProgress(noEstimate(null, null, null), RUN_ITEM), null);
    const unstarted = est({ running: { prompt_id: "run", started_at: null, ...known(30), node: "3", value: 2, max: 8 } });
    assert.deepEqual(runningProgress(unstarted, RUN_ITEM), { fraction: 0.25, label: "High noise · 2/8" }, "start unknown");
    assert.equal(runningProgress(est(), [0, "other", {}, {}, []]), null, "estimates of another run");
    assert.equal(runningProgress(null, RUN_ITEM), null);
});

test("the running bar's first width lands without a transition; a rebuilt row jumps instead of replaying the 0->x% flash", () => {
    const bar   = { style: {}, dataset: {}, getAnimations: () => [], animate: () => {} };
    const label = { textContent: "" };
    const block = { style: {}, querySelector: sel => sel === ".qm-run-label" ? label : bar };
    showProgress(block, { fraction: 0.4, label: "4m left" });
    assert.equal(bar.style.width, "40.0%");
    assert.equal(bar.style.transition, undefined, "a freshly rendered bar jumps straight there, no 0 -> 40% flash");
    showProgress(block, { fraction: 0.6, label: "3m left" });
    assert.equal(bar.style.width, "60.0%");
    assert.equal(bar.style.transition, "width 0.5s linear", "once the first width has landed, later polls on the same element animate smoothly");
});

test("toolbar badge and queue end", () => {
    const idle = est({ running: null });
    assert.equal(badgeText(idle), "");
    assert.equal(queueEndText(idle), "");
    assert.equal(badgeText(null), "");
    assert.equal(queueEndText(null), "");
    const busy = est({ pending: { a: known(62) }, remaining_ms: 72 * MIN });
    assert.equal(badgeText(busy), "1h 12m");
    assert.equal(queueEndText(busy), `queue empty ~${fmtTime(NOW + 72 * MIN)}`);
    const mixed = est({ pending: { a: known(5), b: null, c: null }, remaining_ms: 15 * MIN, unknown: 2 });
    assert.equal(badgeText(mixed), "15m+");
    assert.equal(queueEndText(mixed), `queue empty ~${fmtTime(NOW + 15 * MIN)} · 2 without estimate`);
    const blind = est({ running: { prompt_id: "run", started_at: NOW, ...NONE }, pending: { a: null }, unknown: 2 });
    assert.equal(badgeText(blind), "?");
    assert.equal(queueEndText(blind), "2 without estimate");
});

test("detail line names the basis and run count; only pending and running runs get one", () => {
    assert.equal(estimateLine(known(32)), "Estimated 32m 00s (from 5 runs with these settings)");
    assert.equal(estimateLine({ estimate_ms: 42_000, basis: "workflow", runs: 1 }), "Estimated 42s (from 1 run of this workflow with other settings)");
    assert.equal(estimateLine(null), "");
    assert.equal(estimateLine(NONE), "");
    const item = [0, "p1", { "3": { class_type: "KSampler", inputs: { steps: 8 } } }, {}, ["9"]];
    const info = groupInfo([item]).get("p1");
    for (const where of ["Running", "#2 of 3"]) {
        const html = detailHtml(item, info, where);
        assert.ok(html.includes(`class="qm-est-line" data-est-id="p1"`), where);
        assert.ok(!html.includes("data-prompt-id"), "the estimate placeholder must not carry the row-identity attribute (plan A's row lookups match on it)");
    }
    assert.ok(!detailHtml(item, info, "Saved").includes("qm-est-line"));
    assert.ok(!detailHtml(item, info, "✓ Finished", { id: 1, item, outputs: {}, status: null }).includes("qm-est-line"));
});

let failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
