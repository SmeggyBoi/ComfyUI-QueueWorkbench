"""Run from the repo root: ~/ComfyUI/venv/bin/python -m unittest discover -s tests -v"""
import contextlib
import importlib.util
import io
import json
import pathlib
import sqlite3
import tempfile
import types
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

ROOT = pathlib.Path(__file__).resolve().parents[1]

# The real persistence.py under its own name: test_queue_edit.py puts a stub at qm.persistence
_spec = importlib.util.spec_from_file_location("qm_history_persistence", ROOT / "persistence.py")
persistence = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(persistence)


def entry(prompt_id, nodes=3, status="success"):
    """A ComfyUI history entry as task_done leaves it (sensitive element already removed)."""
    workflow = {"id": "wf", "extra": {"qm_name": "Wf", "qm_queued_at": 111}, "nodes": [{"id": i} for i in range(nodes)]}
    return {
        "prompt": [1, prompt_id, {"1": {"inputs": {"text": prompt_id}}},
                   {"extra_pnginfo": {"workflow": workflow}, "client_id": "c1", "create_time": 100}, ["9"]],
        "outputs": {"9": {"images": [{"filename": f"{prompt_id}.png", "subfolder": "", "type": "output"}]}},
        "status": {"status_str": status, "completed": status == "success", "messages": []},
        "meta": {"9": {"node_id": "9"}},
    }


def ids(runs):
    return [r["prompt"][1] for r in runs]


class DbTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = pathlib.Path(tmp.name)
        persistence._DB_PATH = str(self.dir / "queue_persist.db")
        persistence._init_db()


class HistoryStoreTest(DbTest):
    def test_lists_newest_first_with_cut_down_workflow(self):
        for pid in "abc":
            persistence.record_history(entry(pid))
        runs, more = persistence.list_history()
        self.assertEqual((ids(runs), more), (["c", "b", "a"], False))
        extra_data = runs[0]["prompt"][3]
        self.assertEqual(extra_data["extra_pnginfo"], {"workflow": {"id": "wf", "extra": {"qm_name": "Wf", "qm_queued_at": 111}}})
        self.assertEqual((extra_data["client_id"], extra_data["create_time"]), ("c1", 100))
        self.assertEqual(runs[0]["outputs"]["9"]["images"][0]["filename"], "c.png")
        self.assertEqual(runs[0]["status"]["status_str"], "success")
        self.assertNotIn("meta", runs[0])

    def test_pages_back_with_before_and_catches_up_with_after(self):
        for pid in "abcde":
            persistence.record_history(entry(pid))
        page, more = persistence.list_history(limit=2)
        self.assertEqual((ids(page), more), (["e", "d"], True))
        older, more = persistence.list_history(limit=2, before=page[-1]["id"])
        self.assertEqual((ids(older), more), (["c", "b"], True))
        last, more = persistence.list_history(limit=2, before=older[-1]["id"])
        self.assertEqual((ids(last), more), (["a"], False))
        persistence.record_history(entry("f"))
        persistence.record_history(entry("g"))
        new, more = persistence.list_history(after=page[0]["id"])
        self.assertEqual((ids(new), more), (["g", "f"], False))
        self.assertEqual(persistence.list_history(after=new[0]["id"]), ([], False))

    def test_keeps_only_the_newest_runs(self):
        self.assertEqual(persistence.HISTORY_LIMIT, 200)
        self.addCleanup(setattr, persistence, "HISTORY_LIMIT", persistence.HISTORY_LIMIT)
        persistence.HISTORY_LIMIT = 3
        for pid in "abcde":
            persistence.record_history(entry(pid))
        self.assertEqual(ids(persistence.list_history()[0]), ["e", "d", "c"])

    def test_same_prompt_id_keeps_only_its_newest_run(self):
        persistence.record_history(entry("a", status="error"))
        persistence.record_history(entry("b"))
        persistence.record_history(entry("a"))
        runs, _ = persistence.list_history()
        self.assertEqual(ids(runs), ["a", "b"])
        self.assertEqual(runs[0]["status"]["status_str"], "success")

    def test_full_entry_and_delete(self):
        persistence.record_history(entry("a", nodes=5))
        persistence.record_history(entry("b"))
        full = persistence.get_history_entry("a")
        self.assertEqual(len(full["prompt"][3]["extra_pnginfo"]["workflow"]["nodes"]), 5)
        self.assertNotIn("meta", full)
        self.assertIsNone(persistence.get_history_entry("missing"))
        self.assertEqual(persistence.delete_history(["a", "missing"]), 1)
        self.assertEqual(persistence.delete_history([]), 0)
        self.assertEqual(ids(persistence.list_history()[0]), ["b"])
        self.assertIsNone(persistence.get_history_entry("a"))

    def test_execution_error_messages_are_stripped_of_inputs_and_outputs(self):
        error_message = {
            "prompt_id": "a",
            "node_id": "3",
            "node_type": "SaveImage",
            "executed": [],
            "exception_message": "boom",
            "exception_type": "RuntimeError",
            "traceback": ["line 1"],
            "timestamp": 222,
            "current_inputs": {"images": [{"api_key_comfy_org": "secret-key", "blob": "x" * 5000}]},
            "current_outputs": ["9"],
        }
        e = entry("a", status="error")
        e["status"] = {
            "status_str": "error",
            "completed": False,
            "messages": [
                ["execution_start", {"prompt_id": "a", "timestamp": 111}],
                ["execution_error", error_message],
            ],
        }
        persistence.record_history(e)

        listed = persistence.list_history()[0][0]
        full = persistence.get_history_entry("a")
        for status in (listed["status"], full["status"]):
            stored = dict(status["messages"][1][1])
            self.assertNotIn("current_inputs", stored)
            self.assertNotIn("current_outputs", stored)
            self.assertEqual(stored["node_type"], "SaveImage")
            self.assertEqual(stored["exception_message"], "boom")
            self.assertEqual(stored["exception_type"], "RuntimeError")
            self.assertEqual(stored["timestamp"], 222)

        self.assertNotIn("secret-key", json.dumps(persistence.list_history()))
        self.assertNotIn("secret-key", json.dumps(persistence.get_history_entry("a")))
        # the caller's entry is never mutated
        self.assertIn("current_inputs", e["status"]["messages"][1][1])

    def test_record_history_tolerates_a_missing_status(self):
        e = entry("a")
        e["status"] = None
        persistence.record_history(e)
        self.assertIsNone(persistence.list_history()[0][0]["status"])
        self.assertIsNone(persistence.get_history_entry("a")["status"])

    def test_run_queued_without_a_workflow(self):
        e = entry("api")
        del e["prompt"][3]["extra_pnginfo"]
        e["status"] = None
        persistence.record_history(e)
        run = persistence.list_history()[0][0]
        self.assertEqual(run["prompt"][3], {"client_id": "c1", "create_time": 100})
        self.assertIsNone(run["status"])

    def test_deleting_the_newest_run_never_reuses_its_id(self):
        persistence.record_history(entry("a"))
        persistence.record_history(entry("b"))
        newest = persistence.list_history()[0][0]["id"]
        persistence.delete_history(["b"])
        persistence.record_history(entry("c"))
        self.assertEqual(ids(persistence.list_history(after=newest)[0]), ["c"])

    def test_a_1_0_database_gains_the_history_table(self):
        path = self.dir / "old.db"
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE saved_jobs (prompt_id TEXT PRIMARY KEY, number REAL, origin TEXT NOT NULL, "
                     "item_json TEXT NOT NULL, saved_at INTEGER NOT NULL)")
        conn.execute("INSERT INTO saved_jobs VALUES ('q', 1, 'queue', '[]', 0)")
        conn.commit()
        conn.close()
        persistence._DB_PATH = str(path)
        with contextlib.redirect_stdout(io.StringIO()):
            persistence._init_db()
        persistence.record_history(entry("a"))
        self.assertEqual(ids(persistence.list_history()[0]), ["a"])


class FakeQueue:
    """The PromptQueue surface persistence wraps, plus ComfyUI's history bookkeeping."""
    def __init__(self):
        self.currently_running = {}
        self.history = {}

    def put(self, item):
        pass

    def get(self, timeout=None):
        pass

    def delete_queue_item(self, function):
        return False

    def wipe_queue(self):
        pass

    def task_done(self, item_id, history_result, status, process_item=None):
        prompt = self.currently_running.pop(item_id)
        if process_item is not None:
            prompt = process_item(prompt)
        self.history[prompt[1]] = {"prompt": prompt, "outputs": {}, "status": status, **history_result}

    def get_history(self, prompt_id=None):
        return {prompt_id: json.loads(json.dumps(self.history[prompt_id]))} if prompt_id in self.history else {}


class TaskDoneHookTest(DbTest):
    def finish(self, q):
        q.currently_running[7] = (1, "run", {"1": {}}, {"client_id": "c1"}, ["9"], {"api_key": "secret"})
        q.task_done(7, {"outputs": {"9": {"images": []}}, "meta": {}},
                    {"status_str": "success", "completed": True, "messages": []},
                    process_item=lambda p: p[:5] + p[6:])

    def test_finished_run_is_recorded_without_the_sensitive_element(self):
        q = FakeQueue()
        persistence._install_queue_hooks(q)
        self.finish(q)
        runs, _ = persistence.list_history()
        self.assertEqual(ids(runs), ["run"])
        self.assertEqual(runs[0]["outputs"], {"9": {"images": []}})
        self.assertNotIn("secret", json.dumps(persistence.get_history_entry("run")))

    def test_recording_failure_never_breaks_task_done(self):
        q = FakeQueue()
        persistence._install_queue_hooks(q)
        q.get_history = lambda prompt_id=None: 1 / 0
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.finish(q)
        self.assertIn("run", q.history)
        self.assertIn("history record error", out.getvalue())
        self.assertEqual(persistence.list_history()[0], [])


class HistoryRoutesTest(DbTest, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        routes = web.RouteTableDef()
        persistence._register_routes(types.SimpleNamespace(routes=routes))
        app = web.Application()
        app.add_routes(routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def test_history_routes(self):
        for pid in "abc":
            persistence.record_history(entry(pid))
        data = await (await self.client.get("/queue_workbench/history?limit=2")).json()
        self.assertEqual((ids(data["runs"]), data["more"]), (["c", "b"], True))
        self.assertNotIn("nodes", data["runs"][0]["prompt"][3]["extra_pnginfo"]["workflow"])
        newer = await (await self.client.get(f"/queue_workbench/history?after={data['runs'][1]['id']}")).json()
        self.assertEqual((ids(newer["runs"]), newer["more"]), (["c"], False))
        older = await (await self.client.get(f"/queue_workbench/history?limit=2&before={data['runs'][1]['id']}")).json()
        self.assertEqual((ids(older["runs"]), older["more"]), (["a"], False))
        full = await (await self.client.get("/queue_workbench/history/a")).json()
        self.assertEqual(len(full["run"]["prompt"][3]["extra_pnginfo"]["workflow"]["nodes"]), 3)
        self.assertEqual((await self.client.get("/queue_workbench/history/zzz")).status, 404)
        self.assertEqual((await self.client.get("/queue_workbench/history?before=x")).status, 400)
        res = await self.client.post("/queue_workbench/history/delete", json={"prompt_ids": ["a"]})
        self.assertEqual(await res.json(), {"deleted": 1})
        self.assertEqual((await self.client.get("/queue_workbench/history/a")).status, 404)
