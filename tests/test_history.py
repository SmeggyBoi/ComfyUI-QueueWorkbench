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


def run(prompt_id, name="Wf", state="success", text="a woman walks through a sunlit flower shop"):
    """An entry of workflow `name` (None: unnamed) prompted with `text` that ended as `state`."""
    e = entry(prompt_id, status="success" if state == "success" else "error")
    e["prompt"][2] = {"6": {"class_type": "CLIPTextEncode", "inputs": {"text": text, "clip": ["4", 1]}},
                      "3": {"class_type": "KSampler", "inputs": {"sampler_name": "euler ancestral", "seed": 1}}}
    e["prompt"][3]["extra_pnginfo"]["workflow"]["extra"]["qm_name"] = f"{name}.json" if name else None
    if state == "interrupted":
        e["status"]["messages"] = [["execution_interrupted", {"prompt_id": prompt_id}]]
    return e


def insert_raw(path, e):
    """Store an entry the way an older version did: only prompt_id, run_json and entry_json."""
    with contextlib.closing(sqlite3.connect(path)) as conn:
        conn.execute("INSERT INTO history (prompt_id, run_json, entry_json) VALUES (?,?,?)",
                     (e["prompt"][1], json.dumps(persistence._list_row(e)), json.dumps(e)))
        conn.commit()


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


class HistoryFilterTest(DbTest):
    def test_search_text_is_the_name_and_the_prompt_like_inputs_lower_cased(self):
        prompt = {"6": {"inputs": {"text": "A Woman walks THROUGH a shop", "clip": ["4", 1]}},
                  "3": {"inputs": {"sampler_name": "euler ancestral", "seed": 1}},
                  "7": {"inputs": {"text": "second prompt with spaces"}},
                  "8": "not a node"}
        self.assertEqual(persistence.search_text("Long Videos", prompt),
                         "long videos\na woman walks through a shop\nsecond prompt with spaces")
        self.assertEqual(persistence.search_text(None, prompt), "a woman walks through a shop\nsecond prompt with spaces")
        self.assertEqual(persistence.search_text(None, None), "")

    def test_status_workflow_and_unnamed_filters_combine(self):
        for pid, name, state in [("a", "Wf", "success"), ("b", "Wf", "error"), ("c", "Other", "interrupted"),
                                 ("d", None, "error"), ("e", "Other", "success")]:
            persistence.record_history(run(pid, name, state))
        listed = lambda **filters: ids(persistence.list_history(**filters)[0])
        self.assertEqual(listed(status="error"), ["d", "b"])
        self.assertEqual(listed(status="interrupted"), ["c"])
        self.assertEqual(listed(workflow="Other"), ["e", "c"])
        self.assertEqual(listed(workflow=""), ["d"], '"" is the unnamed runs')
        self.assertEqual(listed(status="error", workflow="Wf"), ["b"])
        self.assertEqual(listed(status=None, workflow=None, q=None), ["e", "d", "c", "b", "a"])
        persistence.record_history(run("f", "100%_v2"))
        self.assertEqual(listed(workflow="100%_v2"), ["f"])
        self.assertEqual(listed(workflow="100%"), [], "the workflow filter is an exact match")

    def test_text_search_ignores_case_and_takes_wildcards_literally(self):
        texts = {"a": "a cat on the sofa at night", "b": "a dog with 100% detail in the sun",
                 "c": "the snake_case name of a thing", "d": "a folder C:\\new\\images on the disk",
                 "e": "a Café at the corner of the street"}
        for pid, text in texts.items():
            persistence.record_history(run(pid, text=text))
        persistence.record_history(run("f", name="Cat Videos", text="a dog runs along the beach"))
        search = lambda q: ids(persistence.list_history(q=q)[0])
        self.assertEqual(search("CAT"), ["f", "a"], "the workflow name counts too")
        self.assertEqual(search("CAFÉ"), ["e"])
        self.assertEqual(search("%"), ["b"])
        self.assertEqual(search("_"), ["c"])
        self.assertEqual(search("\\new"), ["d"])
        self.assertEqual(search("euler"), [], "a one-word input is no prompt")
        self.assertEqual(search("   "), ["f", "e", "d", "c", "b", "a"], "only spaces: no search")

    def test_filters_combine_with_before_and_after(self):
        for i in range(6):
            persistence.record_history(run(f"r{i}", state="error" if i % 2 else "success"))
        page, more = persistence.list_history(limit=2, status="error")
        self.assertEqual((ids(page), more), (["r5", "r3"], True))
        older, more = persistence.list_history(limit=2, before=page[-1]["id"], status="error")
        self.assertEqual((ids(older), more), (["r1"], False))
        persistence.record_history(run("new-ok"))
        persistence.record_history(run("new-err", state="error"))
        self.assertEqual(ids(persistence.list_history(after=page[0]["id"], status="error")[0]), ["new-err"])

    def test_workflows_with_their_counts_most_recently_run_first(self):
        for pid, name in [("a", "Wf"), ("b", None), ("c", "Other"), ("d", "Wf"), ("e", None)]:
            persistence.record_history(run(pid, name))
        self.assertEqual(persistence.history_workflows(),
                         [{"name": None, "count": 2}, {"name": "Wf", "count": 2}, {"name": "Other", "count": 1}])

    def test_filters_read_the_covering_index_and_then_only_the_pages_rows(self):
        with contextlib.closing(sqlite3.connect(persistence._DB_PATH)) as conn:
            self.assertEqual([row[2] for row in conn.execute("PRAGMA index_info(history_filters)")],
                             ["status", "workflow", "search"])
            plan = conn.execute(
                "EXPLAIN QUERY PLAN SELECT id, run_json, pinned FROM history WHERE id IN (SELECT id FROM history "
                "INDEXED BY history_filters WHERE id < ? AND status = ? AND workflow = ? AND search LIKE ? ESCAPE '\\' "
                "ORDER BY id DESC LIMIT ?) ORDER BY id DESC", (9, "error", "Wf", "%cat%", 51)).fetchall()
        detail = " ".join(row[3] for row in plan)
        self.assertIn("USING COVERING INDEX history_filters", detail)
        self.assertIn("USING INTEGER PRIMARY KEY", detail)


class HistoryPinTest(DbTest):
    def test_pinned_runs_are_never_trimmed_and_do_not_count_toward_the_limit(self):
        self.addCleanup(setattr, persistence, "HISTORY_LIMIT", persistence.HISTORY_LIMIT)
        persistence.HISTORY_LIMIT = 3
        persistence.record_history(entry("a"))
        persistence.record_history(entry("b"))
        self.assertTrue(persistence.set_pinned("a", True))
        for pid in "cdef":
            persistence.record_history(entry(pid))
        runs = persistence.list_history()[0]
        self.assertEqual([(r["prompt"][1], r["pinned"]) for r in runs], [("f", False), ("e", False), ("d", False), ("a", True)])
        self.assertTrue(persistence.set_pinned("a", False))
        persistence.record_history(entry("g"))
        self.assertEqual(ids(persistence.list_history()[0]), ["g", "f", "e"], "unpinned, it ages out with the next run")
        self.assertFalse(persistence.set_pinned("missing", True))

    def test_a_run_recorded_again_keeps_its_pin_and_can_still_be_removed(self):
        persistence.record_history(entry("a", status="error"))
        persistence.set_pinned("a", True)
        persistence.record_history(entry("b"))
        persistence.record_history(entry("a"))
        self.assertEqual([(r["prompt"][1], r["pinned"]) for r in persistence.list_history()[0]], [("a", True), ("b", False)])
        self.assertEqual(persistence.delete_history(["a"]), 1)
        self.assertEqual(ids(persistence.list_history()[0]), ["b"])


class HistoryMigrationTest(DbTest):
    def test_a_database_from_before_the_filters_gains_pin_and_search(self):
        path = self.dir / "b.db"
        with contextlib.closing(sqlite3.connect(path)) as conn:   # the history table as the time estimates left it
            conn.execute("CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt_id TEXT UNIQUE NOT NULL, "
                         "run_json TEXT NOT NULL, entry_json TEXT NOT NULL, workflow TEXT, workflow_id TEXT, "
                         "status TEXT, sig TEXT, duration_ms INTEGER)")
        insert_raw(path, run("a", name="Long Videos"))
        insert_raw(path, run("b", text="a cat on the sofa at night"))
        persistence._DB_PATH = str(path)
        with contextlib.redirect_stdout(io.StringIO()):
            persistence._init_db()
        self.assertEqual(ids(persistence.list_history(q="long videos")[0]), ["a"])
        self.assertEqual(ids(persistence.list_history(q="sofa")[0]), ["b"])
        self.assertEqual([r["pinned"] for r in persistence.list_history()[0]], [False, False])
        self.assertTrue(persistence.set_pinned("a", True))

    def test_the_backfill_runs_once_per_version_and_again_after_a_crash_before_its_commit(self):
        insert_raw(persistence._DB_PATH, run("a"))   # derived columns NULL, as a row the back-fill hasn't reached
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            persistence._init_db()
        self.assertEqual(out.getvalue(), "")
        self.assertEqual(persistence.list_history(q="sunlit")[0], [], "a start at the current version reads no entries")
        with contextlib.closing(sqlite3.connect(persistence._DB_PATH)) as conn:
            conn.execute("PRAGMA user_version = 0")   # what a crash before the back-fill's commit leaves
        with contextlib.redirect_stdout(out):
            persistence._init_db()
        self.assertEqual(ids(persistence.list_history(q="sunlit")[0]), ["a"])
        with contextlib.closing(sqlite3.connect(persistence._DB_PATH)) as conn:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], persistence.HISTORY_VERSION)


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
        self.routes = routes = web.RouteTableDef()
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

    async def test_filter_workflows_and_pin_routes(self):
        for pid, name, state in [("a", "Wf", "success"), ("b", None, "error"), ("c", "Wf", "error")]:
            persistence.record_history(run(pid, name, state))
        listed = lambda query: self.client.get(f"/queue_workbench/history?{query}")
        self.assertEqual(ids((await (await listed("status=error&workflow=Wf")).json())["runs"]), ["c"])
        self.assertEqual(ids((await (await listed("workflow=")).json())["runs"]), ["b"])
        self.assertEqual(ids((await (await listed("q=SUNLIT+flower&status=")).json())["runs"]), ["c", "b", "a"])
        self.assertEqual((await listed("status=failed")).status, 400)
        data = await (await self.client.get("/queue_workbench/history/workflows")).json()
        self.assertEqual(data, {"workflows": [{"name": "Wf", "count": 2}, {"name": None, "count": 1}]})
        res = await self.client.post("/queue_workbench/history/pin", json={"prompt_id": "a", "pinned": True})
        self.assertEqual(await res.json(), {"pinned": True})
        self.assertEqual([r["pinned"] for r in (await (await listed("")).json())["runs"]], [False, False, True])
        res = await self.client.post("/queue_workbench/history/pin", json={"prompt_id": "gone", "pinned": True})
        self.assertEqual(res.status, 404)

    async def test_the_workflows_route_is_added_before_the_run_route(self):
        paths = [route.path for route in self.routes]
        self.assertLess(paths.index("/queue_workbench/history/workflows"), paths.index("/queue_workbench/history/{prompt_id}"))
