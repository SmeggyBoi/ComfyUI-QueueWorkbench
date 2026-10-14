"""Run from the repo root: ~/ComfyUI/venv/bin/python -m unittest discover -s tests -v"""
import heapq
import importlib
import pathlib
import sys
import threading
import time
import types
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

ROOT = pathlib.Path(__file__).resolve().parents[1]

# freeze.py inside its own stand-in package (other test files use "qm" and "qm_oom")
_pkg = types.ModuleType("qm_freeze")
_pkg.__path__ = [str(ROOT)]
sys.modules["qm_freeze"] = _pkg
freeze = importlib.import_module("qm_freeze.freeze")


class FakeQueue:
    """ComfyUI's PromptQueue put / get / get_current_queue_volatile (execution.py), without a server."""
    def __init__(self):
        self.mutex = threading.RLock()
        self.not_empty = threading.Condition(self.mutex)
        self.queue = []
        self.taken = []

    def put(self, item):
        with self.mutex:
            heapq.heappush(self.queue, item)
            self.not_empty.notify()

    def get(self, timeout=None):
        with self.not_empty:
            while len(self.queue) == 0:
                self.not_empty.wait(timeout=timeout)
                if timeout is not None and len(self.queue) == 0:
                    return None
            item = heapq.heappop(self.queue)
            self.taken.append(item[1])
            return (item, len(self.taken))

    def get_current_queue_volatile(self):
        with self.mutex:
            return [], list(self.queue)

    def delete(self, prompt_id):
        with self.mutex:
            self.queue[:] = [it for it in self.queue if it[1] != prompt_id]
            heapq.heapify(self.queue)


def item(number, prompt_id):
    return (number, prompt_id, {}, {}, [])


def fresh_queue(*ids):
    freeze._paused = False
    freeze._edits.clear()
    queue = FakeQueue()
    freeze.install(queue)
    for number, prompt_id in enumerate(ids, 1):
        queue.put(item(number, prompt_id))
    return queue


def taken_after(queue, timeout):
    """(prompt_id or None, seconds) of a get() in a worker thread started now."""
    got = []
    worker = threading.Thread(target=lambda: got.append(queue.get(timeout=timeout)))
    worker.start()
    return worker, got


class FreezeTest(unittest.TestCase):
    def setUp(self):
        self.q = fresh_queue("a", "b", "c")

    def test_takes_the_lowest_number_when_not_frozen(self):
        self.assertEqual(self.q.get(timeout=0.5)[0][1], "a")

    def test_paused_takes_nothing_and_keeps_the_order(self):
        freeze.set_paused(True)
        started = time.monotonic()
        self.assertIsNone(self.q.get(timeout=0.3))
        self.assertGreaterEqual(time.monotonic() - started, 0.25)
        self.assertEqual([it[1] for it in sorted(self.q.queue)], ["a", "b", "c"])
        self.assertEqual(self.q.taken, [])
        freeze.set_paused(False)
        self.assertEqual(self.q.get(timeout=0.5)[0][1], "a")

    def test_unfreezing_wakes_a_waiting_worker_at_once(self):
        freeze.set_paused(True)
        worker, got = taken_after(self.q, 10)
        time.sleep(0.2)
        released = time.monotonic()
        freeze.set_paused(False)
        worker.join(5)
        self.assertEqual(got[0][0][1], "a")
        self.assertLess(time.monotonic() - released, 0.5)

    def test_a_run_queued_while_paused_waits(self):
        empty = fresh_queue()
        freeze.set_paused(True)
        worker, got = taken_after(empty, 0.6)
        time.sleep(0.2)
        empty.put(item(4, "d"))
        worker.join(5)
        self.assertEqual(got, [None])
        self.assertEqual([it[1] for it in empty.queue], ["d"])

    def test_a_new_run_wakes_an_idle_worker_at_once(self):
        empty = fresh_queue()
        worker, got = taken_after(empty, 10)
        time.sleep(0.2)
        queued = time.monotonic()
        empty.put(item(4, "d"))
        worker.join(5)
        self.assertEqual(got[0][0][1], "d")
        self.assertLess(time.monotonic() - queued, 0.5)

    def test_an_edit_freezes_until_it_ends(self):
        self.assertTrue(freeze.start_edit("t1", "b"))
        self.assertIsNone(self.q.get(timeout=0.2))
        self.assertEqual(freeze.state(), {"paused": False, "editing": ["b"]})
        freeze.end_edit("t1")
        self.assertEqual(self.q.get(timeout=0.5)[0][1], "a")

    def test_no_edit_freeze_for_a_run_that_is_not_pending(self):
        self.assertFalse(freeze.start_edit("t1", "zzz"))
        self.assertEqual(freeze.state(), {"paused": False, "editing": []})
        self.assertEqual(self.q.get(timeout=0.5)[0][1], "a")

    def test_an_edit_of_a_deleted_run_no_longer_holds_the_queue(self):
        freeze.start_edit("t1", "b")
        self.q.delete("b")
        self.assertEqual(self.q.get(timeout=2)[0][1], "a")

    def test_two_edits_of_one_run_hold_until_both_end(self):
        freeze.start_edit("t1", "b")
        freeze.start_edit("t2", "b")
        freeze.end_edit("t1")
        self.assertIsNone(self.q.get(timeout=0.2))
        freeze.end_edit("t2")
        self.assertEqual(self.q.get(timeout=0.5)[0][1], "a")

    def test_unfreeze_clears_the_edits_but_keeps_pause(self):
        freeze.set_paused(True)
        freeze.start_edit("t1", "b")
        freeze.clear_edits()
        self.assertEqual(freeze.state(), {"paused": True, "editing": []})
        self.assertIsNone(self.q.get(timeout=0.2))
        self.assertTrue(freeze.paused())


class FreezeRoutesTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.q = fresh_queue("a")
        routes = web.RouteTableDef()
        freeze.register_routes(types.SimpleNamespace(routes=routes))
        app = web.Application()
        app.add_routes(routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def post(self, body):
        res = await self.client.post("/queue_workbench/freeze", **({"data": body} if isinstance(body, str) else {"json": body}))
        return res.status, await res.json()

    async def test_pause_edit_release_and_clear(self):
        self.assertEqual(await self.post({"pause": True}), (200, {"paused": True, "editing": []}))
        self.assertEqual(await self.post({"edit": "a", "token": "t1", "on": True}), (200, {"paused": True, "editing": ["a"]}))
        self.assertEqual(await self.post({"edits": "clear"}), (200, {"paused": True, "editing": []}))
        self.assertEqual(await self.post({"pause": False}), (200, {"paused": False, "editing": []}))
        self.assertEqual(await (await self.client.get("/queue_workbench/freeze")).json(), {"paused": False, "editing": []})

    async def test_edit_of_a_started_run_is_refused(self):
        status, body = await self.post({"edit": "zzz", "token": "t1", "on": True})
        self.assertEqual((status, body["not_pending"], body["editing"]), (409, True, []))

    async def test_a_beacon_posts_text_plain(self):
        await self.post({"edit": "a", "token": "t1", "on": True})
        self.assertEqual(await self.post('{"token": "t1", "on": false}'), (200, {"paused": False, "editing": []}))

    async def test_bad_bodies_are_400(self):
        for body in ("not json", "[]", {"on": True}):
            self.assertEqual((await self.post(body))[0], 400)
