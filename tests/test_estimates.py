"""Run from the repo root: ~/ComfyUI/venv/bin/python -m unittest discover -s tests -v"""
import contextlib
import importlib
import io
import json
import pathlib
import sqlite3
import sys
import tempfile
import types
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

ROOT = pathlib.Path(__file__).resolve().parents[1]

# The real persistence.py inside its own stand-in package, so estimates.py's relative import
# finds it (test_queue_edit.py and test_oom_retry.py stub persistence in theirs)
_pkg = types.ModuleType("qm_est")
_pkg.__path__ = [str(ROOT)]
sys.modules["qm_est"] = _pkg
persistence = importlib.import_module("qm_est.persistence")
estimates = importlib.import_module("qm_est.estimates")

START = 1_791_000_000_000   # an execution_start timestamp (ms)


def primitive(title, value, class_type="PrimitiveFloat"):
    return {"class_type": class_type, "_meta": {"title": title}, "inputs": {"value": value}}


def graph(steps=8, seconds=5.0, width=1280, height=720):
    return {
        "3": {"class_type": "KSampler", "inputs": {"steps": steps, "cfg": 1.0, "seed": 42, "denoise": 1.0, "model": ["4", 0]}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "7": primitive("Float (duration, seconds)", seconds),
        "8": {"class_type": "CLIPTextEncode", "inputs": {"text": "a woman walks through a sunlit flower shop"}},
    }


SIG = "batch_size=1|duration=5|height=720|steps=8|width=1280"   # time_signature(graph())


def entry(prompt_id, name="Wf", workflow_id="wf-1", prompt=None, state="success", ms=60_000):
    """A ComfyUI history entry as record_history gets it; ms=None leaves the timestamps out."""
    messages = []
    if ms is not None:
        end = {"success": "execution_success", "error": "execution_error", "interrupted": "execution_interrupted"}[state]
        messages = [["execution_start", {"prompt_id": prompt_id, "timestamp": START}],
                    ["execution_cached", {"nodes": [], "prompt_id": prompt_id, "timestamp": START + 5}],
                    [end, {"prompt_id": prompt_id, "timestamp": START + ms}]]
    workflow = {"id": workflow_id, "extra": {"qm_name": f"{name}.json"} if name else {}, "nodes": []}
    return {
        "prompt": [1, prompt_id, graph() if prompt is None else prompt,
                   {"extra_pnginfo": {"workflow": workflow}, "client_id": "c1"}, ["9"]],
        "outputs": {},
        "status": {"status_str": "success" if state == "success" else "error", "completed": state == "success",
                   "messages": messages},
    }


class DbTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = pathlib.Path(tmp.name)
        persistence._DB_PATH = str(self.dir / "queue_persist.db")
        persistence._init_db()

    def columns(self, prompt_id):
        with contextlib.closing(sqlite3.connect(persistence._DB_PATH)) as conn:
            return conn.execute("SELECT workflow, workflow_id, status, sig, duration_ms FROM history WHERE prompt_id=?",
                                (prompt_id,)).fetchone()


class TimeSignatureTest(unittest.TestCase):
    def test_numeric_time_inputs_sorted_with_names_from_primitive_titles(self):
        self.assertEqual(persistence.time_signature(graph()), SIG)

    def test_bools_strings_links_and_other_inputs_are_left_out(self):
        prompt = {
            "1": {"class_type": "X", "inputs": {"steps": True, "frames": "81", "width": ["2", 0], "fps": {"on": True},
                                                 "cfg": 7.0, "seed": 1, "frame_rate": 16}},
            "2": primitive("Steps", 20, "PrimitiveInt"),
            "3": primitive("Int (num_frames)", 81, "PrimitiveInt"),
            "4": primitive("Float (strength, model)", 0.8),
            "5": {"class_type": "PrimitiveInt", "inputs": {"value": 30}},
            "6": "not a node",
        }
        self.assertEqual(persistence.time_signature(prompt), "frame_rate=16|num_frames=81|steps=20")

    def test_order_independent_with_short_values(self):
        a = {"1": {"inputs": {"width": 1280.0, "height": 720}}, "2": {"inputs": {"steps": 8}}}
        b = {"9": {"inputs": {"steps": 8}}, "4": {"inputs": {"height": 720.0, "width": 1280}}}
        self.assertEqual(persistence.time_signature(a), "height=720|steps=8|width=1280")
        self.assertEqual(persistence.time_signature(b), persistence.time_signature(a))
        self.assertEqual(persistence.time_signature({"1": {"inputs": {"seconds": 5.5}}}), "seconds=5.5")
        self.assertEqual(persistence.time_signature({}), "")
        self.assertEqual(persistence.time_signature(None), "")


class HistoryColumnsTest(DbTest):
    def test_record_history_fills_the_derived_columns(self):
        persistence.record_history(entry("a", ms=95_000))
        self.assertEqual(self.columns("a"), ("Wf", "wf-1", "success", SIG, 95_000))

    def test_status_and_duration_of_failed_interrupted_and_untimed_runs(self):
        persistence.record_history(entry("err", state="error", ms=30_000))
        persistence.record_history(entry("int", state="interrupted", ms=12_000))
        persistence.record_history(entry("untimed", ms=None))
        no_status = entry("no-status")
        no_status["status"] = None
        persistence.record_history(no_status)
        runs = ("err", "int", "untimed", "no-status")
        self.assertEqual([self.columns(p)[2] for p in runs], ["error", "interrupted", "success", None])
        self.assertEqual([self.columns(p)[4] for p in runs], [30_000, 12_000, None, None])

    def test_runs_without_a_name_or_without_a_workflow(self):
        persistence.record_history(entry("anon", name=None))
        api = entry("api")
        del api["prompt"][3]["extra_pnginfo"]
        persistence.record_history(api)
        self.assertEqual(self.columns("anon")[:2], (None, "wf-1"))
        self.assertEqual(self.columns("api")[:2], (None, None))

    def test_run_workflow_is_null_safe(self):
        named = {"extra_pnginfo": {"workflow": {"id": "x", "extra": {"qm_name": "Wan i2v.json"}}}}
        self.assertEqual(persistence.run_workflow(named), ("Wan i2v", "x"))
        for extra_data in (None, {}, {"extra_pnginfo": None}, {"extra_pnginfo": {"workflow": None}}):
            self.assertEqual(persistence.run_workflow(extra_data), (None, None), extra_data)
        self.assertEqual(persistence.run_workflow({"extra_pnginfo": {"workflow": {"id": "x", "extra": None}}}), (None, "x"))

    def test_an_older_history_table_gains_the_columns_filled_in_from_its_runs(self):
        path = self.dir / "old.db"
        with contextlib.closing(sqlite3.connect(path)) as conn:
            conn.execute("CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt_id TEXT UNIQUE NOT NULL, "
                         "run_json TEXT NOT NULL, entry_json TEXT NOT NULL)")
            for e in (entry("a", ms=95_000), entry("b", name=None, state="interrupted")):
                conn.execute("INSERT INTO history (prompt_id, run_json, entry_json) VALUES (?,?,?)",
                             (e["prompt"][1], "{}", json.dumps(e)))
            conn.execute("INSERT INTO history (prompt_id, run_json, entry_json) VALUES ('bad', '{}', 'not json')")
            conn.commit()
        persistence._DB_PATH = str(path)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            persistence._init_db()
        self.assertEqual(self.columns("a"), ("Wf", "wf-1", "success", SIG, 95_000))
        self.assertEqual(self.columns("b"), (None, "wf-1", "interrupted", SIG, 60_000))
        self.assertEqual(self.columns("bad"), (None, None, None, None, None), "an unreadable run keeps NULLs")
        self.assertIn("for 3 finished run(s)", out.getvalue())
        again = io.StringIO()
        with contextlib.redirect_stdout(again):
            persistence._init_db()
        self.assertEqual(again.getvalue(), "", "the next start has nothing to add")
        persistence.record_history(entry("c", ms=1_000))
        self.assertEqual(self.columns("c")[4], 1_000)


class RecentDurationsTest(DbTest):
    def test_newest_successful_runs_of_the_workflow_first_optionally_with_one_signature(self):
        fast = graph(steps=4)
        for pid, ms, prompt, state in [("a", 10_000, None, "success"), ("b", 20_000, fast, "success"),
                                       ("c", 30_000, None, "error"), ("d", 40_000, None, "success"),
                                       ("e", 50_000, fast, "interrupted"), ("f", 60_000, None, "success")]:
            persistence.record_history(entry(pid, prompt=prompt, state=state, ms=ms))
        persistence.record_history(entry("other", name="Other", ms=99_000))
        persistence.record_history(entry("untimed", ms=None))
        self.assertEqual(persistence.recent_durations("Wf", "wf-1"), [60_000, 40_000, 20_000, 10_000])
        self.assertEqual(persistence.recent_durations("Wf", "wf-1", SIG), [60_000, 40_000, 10_000])
        self.assertEqual(persistence.recent_durations("Wf", None, persistence.time_signature(fast)), [20_000])
        self.assertEqual(persistence.recent_durations("Wf", "wf-1", limit=2), [60_000, 40_000])
        self.assertEqual(persistence.recent_durations("Missing", "wf-1"), [])

    def test_unnamed_runs_match_by_workflow_id_among_the_unnamed_only(self):
        persistence.record_history(entry("named", name="Wf", workflow_id="wf-1", ms=10_000))
        persistence.record_history(entry("anon", name=None, workflow_id="wf-1", ms=20_000))
        persistence.record_history(entry("anon2", name=None, workflow_id="wf-2", ms=30_000))
        self.assertEqual(persistence.recent_durations(None, "wf-1"), [20_000])
        self.assertEqual(persistence.recent_durations("Wf", "wf-2"), [10_000])
        self.assertEqual(persistence.recent_durations(None, None), [])


def item(prompt_id, name="Wf", workflow_id="wf-1", prompt=None, number=1):
    """A queue item as get_current_queue_volatile returns it."""
    workflow = {"id": workflow_id, "extra": {"qm_name": f"{name}.json"} if name else {}, "nodes": []}
    return (number, prompt_id, graph() if prompt is None else prompt,
            {"extra_pnginfo": {"workflow": workflow}, "client_id": "c1"}, ["9"], {})


class FakeQueue:
    def __init__(self, running=(), pending=()):
        self.running, self.pending = list(running), list(pending)

    def get_current_queue_volatile(self):
        return list(self.running), list(self.pending)


def reset_capture(test):
    """The progress capture starts empty and is emptied again after the test."""
    estimates._running = None
    test.addCleanup(setattr, estimates, "_running", None)


class ProgressCaptureTest(unittest.TestCase):
    def setUp(self):
        reset_capture(self)
        self.addCleanup(setattr, estimates, "_now_ms", estimates._now_ms)
        estimates._now_ms = lambda: START + 999

    def test_follows_the_running_run_through_its_events(self):
        on = estimates.on_event
        on("execution_start", {"prompt_id": "a", "timestamp": START})
        self.assertEqual(estimates.running_state(),
                         {"prompt_id": "a", "started_at": START, "node": None, "value": None, "max": None})
        on("executing", {"node": "3", "display_node": "3", "prompt_id": "a"})
        on("progress", {"value": 12, "max": 30, "prompt_id": "a", "node": "3"})
        self.assertEqual(estimates.running_state(),
                         {"prompt_id": "a", "started_at": START, "node": "3", "value": 12, "max": 30})
        on("executing", {"node": "459:451", "display_node": "459", "prompt_id": "a"})
        self.assertEqual(estimates.running_state()["node"], "459:451")
        self.assertIsNone(estimates.running_state()["value"], "a new node starts without progress")
        on("status", {"status": {"exec_info": {"queue_remaining": 1}}})
        on(1, b"\xff\xd8 preview bytes")
        self.assertEqual(estimates.running_state()["node"], "459:451")
        on("execution_success", {"prompt_id": "a", "timestamp": START + 5_000})
        self.assertIsNone(estimates.running_state(), "execution_success clears a matching run")

    def test_every_end_of_a_run_clears_it(self):
        for event, data in [("execution_error", {"prompt_id": "a"}), ("execution_interrupted", {"prompt_id": "a"}),
                            ("executing", {"node": None, "prompt_id": "a"})]:
            estimates.on_event("execution_start", {"prompt_id": "a", "timestamp": START})
            estimates.on_event(event, data)
            self.assertIsNone(estimates.running_state(), event)

    def test_a_script_queued_run_starts_at_its_first_progress_event(self):
        # ComfyUI sends progress_state for script-queued runs (no execution_start/executing/success)
        estimates.on_event("progress_state", {"prompt_id": "s", "nodes": {"3": {"state": "running", "node_id": "3", "value": 0, "max": 1}}})
        self.assertEqual(estimates.running_state(),
                         {"prompt_id": "s", "started_at": START + 999, "node": "3", "value": 0, "max": 1})
        estimates.on_event("progress", {"prompt_id": "s", "node": "3", "value": 5, "max": 20})
        self.assertEqual(estimates.running_state(),
                         {"prompt_id": "s", "started_at": START + 999, "node": "3", "value": 5, "max": 20})
        estimates.on_event("execution_success", {"prompt_id": "u"})
        self.assertEqual(estimates.running_state()["prompt_id"], "s", "an older run's end leaves it alone")

    def test_ui_run_with_execution_start_and_progress_state(self):
        # UI runs send execution_start (with timestamp), then progress_state updates
        estimates.on_event("execution_start", {"prompt_id": "ui", "timestamp": START})
        self.assertEqual(estimates.running_state()["started_at"], START)
        estimates.on_event("progress_state", {"prompt_id": "ui", "nodes": {"7": {"state": "running", "node_id": "7", "value": 2, "max": 5}}})
        self.assertEqual(estimates.running_state(),
                         {"prompt_id": "ui", "started_at": START, "node": "7", "value": 2, "max": 5})

    def test_the_state_handed_out_is_a_copy(self):
        estimates.on_event("execution_start", {"prompt_id": "a", "timestamp": START})
        estimates.running_state()["node"] = "x"
        self.assertIsNone(estimates.running_state()["node"])


class EstimateTest(DbTest):
    def record(self, prompt_id, ms, **kw):
        persistence.record_history(entry(prompt_id, ms=ms, **kw))

    def test_median_of_the_newest_five_successful_runs_with_the_same_settings(self):
        for i, ms in enumerate([999_000, 100_000, 300_000, 200_000, 500_000, 400_000]):
            self.record(f"s{i}", ms)
        self.record("failed", 1_000, state="error")
        self.record("interrupted", 2_000, state="interrupted")
        self.record("other-settings", 7_000, prompt=graph(steps=30))
        self.assertEqual(estimates.estimate(item("q")), {"estimate_ms": 300_000, "basis": "settings", "runs": 5})

    def test_falls_back_to_the_workflows_runs_then_to_none(self):
        self.record("a", 100_000, prompt=graph(steps=30))
        self.record("b", 200_000, prompt=graph(steps=20))
        self.assertEqual(estimates.estimate(item("q")), {"estimate_ms": 150_000, "basis": "workflow", "runs": 2})
        self.assertIsNone(estimates.estimate(item("q", name="Never run")))
        self.assertIsNone(estimates.estimate((1, "api", graph(), {"client_id": "c1"}, ["9"], {})), "no workflow at all")

    def test_unnamed_runs_go_by_the_workflow_id(self):
        self.record("anon", 80_000, name=None, workflow_id="wf-9")
        self.assertEqual(estimates.estimate(item("q", name=None, workflow_id="wf-9")),
                         {"estimate_ms": 80_000, "basis": "settings", "runs": 1})

    def test_memoised_per_workflow_and_settings(self):
        self.record("a", 100_000)
        calls = []
        real = persistence.recent_durations
        self.addCleanup(setattr, persistence, "recent_durations", real)
        persistence.recent_durations = lambda *args: calls.append(args) or real(*args)
        cache = {}
        for prompt_id in ("q1", "q2", "q3"):
            estimates.estimate(item(prompt_id), cache)
        estimates.estimate(item("q4", prompt=graph(steps=30)), cache)
        self.assertEqual(len(calls), 3, "one query for the shared settings; two (settings, then workflow) for the new ones")


class SnapshotTest(DbTest):
    def setUp(self):
        super().setUp()
        reset_capture(self)
        for i in range(3):
            persistence.record_history(entry(f"h{i}", ms=600_000))            # Wf: 10 min
        persistence.record_history(entry("v", name="Video", ms=1_800_000))   # Video: 30 min

    def test_remaining_time_and_runs_without_an_estimate(self):
        estimates.on_event("execution_start", {"prompt_id": "run", "timestamp": START})
        estimates.on_event("progress", {"value": 3, "max": 8, "prompt_id": "run", "node": "3"})
        queue = FakeQueue([item("run")], [item("p1", name="Video", number=2), item("p2", name="New", number=3),
                                          item("p3", number=4)])
        snap = estimates.snapshot(queue, now_ms=START + 240_000)
        self.assertEqual(snap["now"], START + 240_000)
        self.assertEqual(snap["running"], {"prompt_id": "run", "estimate_ms": 600_000, "basis": "settings", "runs": 3,
                                           "started_at": START, "node": "3", "value": 3, "max": 8})
        self.assertEqual(snap["pending"], {"p1": {"estimate_ms": 1_800_000, "basis": "settings", "runs": 1},
                                           "p2": None,
                                           "p3": {"estimate_ms": 600_000, "basis": "settings", "runs": 3}})
        self.assertEqual(snap["remaining_ms"], 360_000 + 1_800_000 + 600_000)
        self.assertEqual(snap["unknown"], 1)
        json.dumps(snap)   # the route sends it as JSON

    def test_past_its_estimate_the_running_run_adds_nothing_and_without_one_it_is_unknown(self):
        estimates.on_event("execution_start", {"prompt_id": "run", "timestamp": START})
        over = estimates.snapshot(FakeQueue([item("run")]), now_ms=START + 700_000)
        self.assertEqual((over["remaining_ms"], over["unknown"]), (0, 0))
        new = estimates.snapshot(FakeQueue([item("run", name="New")], [item("p", number=2)]), now_ms=START)
        self.assertEqual((new["running"]["estimate_ms"], new["running"]["basis"], new["running"]["runs"]), (None, None, 0))
        self.assertEqual((new["remaining_ms"], new["unknown"]), (600_000, 1))

    def test_progress_of_another_run_is_not_shown_and_an_empty_queue_has_nothing(self):
        estimates.on_event("execution_start", {"prompt_id": "older", "timestamp": START})
        snap = estimates.snapshot(FakeQueue([item("run")]), now_ms=START + 60_000)
        self.assertEqual((snap["running"]["started_at"], snap["running"]["node"]), (None, None))
        self.assertEqual(snap["remaining_ms"], 600_000, "start unknown: the whole estimate")
        self.assertEqual(estimates.snapshot(FakeQueue(), now_ms=START),
                         {"now": START, "running": None, "pending": {}, "remaining_ms": 0, "unknown": 0})


class EstimatesRouteTest(DbTest, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        reset_capture(self)
        persistence.record_history(entry("h", ms=600_000))
        routes = web.RouteTableDef()
        estimates.register_routes(types.SimpleNamespace(routes=routes, prompt_queue=FakeQueue([], [item("p")])))
        app = web.Application()
        app.add_routes(routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def test_estimates_route(self):
        res = await self.client.get("/queue_workbench/estimates")
        self.assertEqual(res.status, 200)
        data = await res.json()
        self.assertEqual(data["pending"], {"p": {"estimate_ms": 600_000, "basis": "settings", "runs": 1}})
        self.assertEqual((data["running"], data["remaining_ms"], data["unknown"]), (None, 600_000, 0))
        self.assertIsInstance(data["now"], int)
