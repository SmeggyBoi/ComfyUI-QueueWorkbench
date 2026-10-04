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

ROOT = pathlib.Path(__file__).resolve().parents[1]

# The real persistence.py inside its own stand-in package, so estimates.py's relative import
# finds it (test_queue_edit.py and test_oom_retry.py stub persistence in theirs)
_pkg = types.ModuleType("qm_est")
_pkg.__path__ = [str(ROOT)]
sys.modules["qm_est"] = _pkg
persistence = importlib.import_module("qm_est.persistence")

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
