"""Run from the repo root: ~/ComfyUI/venv/bin/python -m unittest discover -s tests -v"""
import asyncio
import heapq
import importlib
import pathlib
import sys
import threading
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]

# Load queue_edit.py inside a stand-in package, with ComfyUI's execution module and
# our persistence module stubbed (importing execution would initialise CUDA).
_pkg = types.ModuleType("qm")
_pkg.__path__ = [str(ROOT)]
sys.modules["qm"] = _pkg
sys.modules["qm.persistence"] = types.SimpleNamespace(resync_queue=lambda: None)
_execution = types.ModuleType("execution")
sys.modules["execution"] = _execution
queue_edit = importlib.import_module("qm.queue_edit")


class FakeQueue:
    def __init__(self, items):
        self.mutex = threading.RLock()
        self.queue = list(items)
        heapq.heapify(self.queue)

    def order(self):
        return [item[1] for item in sorted(self.queue)]


def run_item(number, prompt_id):
    workflow = {"id": "wf", "extra": {"qm_name": "Wf", "qm_queued_at": 111}}
    return (number, prompt_id, {"1": {"inputs": {"text": prompt_id}}},
            {"extra_pnginfo": {"workflow": workflow}, "client_id": "c1"}, ["9"], {"api_key": "secret"})


class ReplaceTest(unittest.TestCase):
    def test_swaps_in_place_and_keeps_identity(self):
        q = FakeQueue([run_item(1, "a"), run_item(2, "b")])
        new_wf = {"id": "wf", "extra": {"qm_name": "✎ #2 Wf"}, "nodes": []}
        replaced, not_pending = queue_edit.replace_items(q, [("b", {"1": {"inputs": {"text": "fixed"}}}, new_wf, ["9", "10"])])
        self.assertEqual((replaced, not_pending), (["b"], []))
        item = next(i for i in q.queue if i[1] == "b")
        self.assertEqual(item[0], 2)
        self.assertEqual(item[2]["1"]["inputs"]["text"], "fixed")
        self.assertEqual(item[3]["extra_pnginfo"]["workflow"]["extra"], {"qm_name": "Wf", "qm_queued_at": 111})
        self.assertEqual(item[3]["client_id"], "c1")
        self.assertEqual(item[4], ["9", "10"])
        self.assertEqual(item[5], {"api_key": "secret"})
        self.assertEqual(q.order(), ["a", "b"])

    def test_reports_items_no_longer_pending(self):
        q = FakeQueue([run_item(1, "a")])
        replaced, not_pending = queue_edit.replace_items(q, [("gone", {}, {}, []), ("a", {}, {"extra": {}}, [])])
        self.assertEqual((replaced, not_pending), (["a"], ["gone"]))


class ValidateTest(unittest.TestCase):
    def test_any_invalid_item_rejects_all(self):
        async def validate_prompt(prompt_id, prompt, partial):
            if prompt_id == "bad":
                return (False, {"message": "Prompt outputs failed validation"}, [],
                        {"3": {"errors": [{"message": "Value not in list"}]}})
            return (True, None, ["9"], {})
        _execution.validate_prompt = validate_prompt
        items = [{"prompt_id": "ok", "prompt": {}, "workflow": {}}, {"prompt_id": "bad", "prompt": {}, "workflow": {}}]
        validated, error = asyncio.run(queue_edit.validate_items(items))
        self.assertIsNone(validated)
        self.assertEqual(error["prompt_id"], "bad")
        self.assertIn("3", error["node_errors"])

    def test_partially_valid_prompt_is_rejected(self):
        # validate_prompt reports valid=True when at least one output survives; the broken
        # outputs only show up in node_errors and would silently never run
        async def validate_prompt(prompt_id, prompt, partial):
            return (True, None, ["9"], {"12": {"errors": [{"message": "Value 0 smaller than min of 1"}], "class_type": "VHS_VideoCombine"}})
        _execution.validate_prompt = validate_prompt
        validated, error = asyncio.run(queue_edit.validate_items([{"prompt_id": "ok", "prompt": {}, "workflow": {}}]))
        self.assertIsNone(validated)
        self.assertIn("12", error["node_errors"])

    def test_valid_items_carry_their_outputs(self):
        async def validate_prompt(prompt_id, prompt, partial):
            return (True, None, ["9"], {})
        _execution.validate_prompt = validate_prompt
        validated, error = asyncio.run(queue_edit.validate_items([{"prompt_id": "ok", "prompt": {"p": 1}, "workflow": {"w": 1}}]))
        self.assertIsNone(error)
        self.assertEqual(validated, [("ok", {"p": 1}, {"w": 1}, ["9"])])


class ReorderTest(unittest.TestCase):
    def test_renumbers_in_requested_order_keeping_ids(self):
        q = FakeQueue([run_item(5, "a"), run_item(6, "b"), run_item(7, "c")])
        self.assertEqual(queue_edit.reorder_items(q, ["c", "a", "b"]), 3)
        self.assertEqual(q.order(), ["c", "a", "b"])
        self.assertEqual(sorted(i[0] for i in q.queue), [5, 6, 7])

    def test_ignores_unknown_and_duplicate_ids(self):
        q = FakeQueue([run_item(1, "a"), run_item(2, "b")])
        self.assertEqual(queue_edit.reorder_items(q, ["b", "zzz", "b", "a"]), 2)
        self.assertEqual(q.order(), ["b", "a"])

    def test_tied_numbers_still_follow_requested_order(self):
        q = FakeQueue([run_item(0, "a"), run_item(0, "b")])
        queue_edit.reorder_items(q, ["b", "a"])
        self.assertEqual(q.order(), ["b", "a"])


if __name__ == "__main__":
    unittest.main()
