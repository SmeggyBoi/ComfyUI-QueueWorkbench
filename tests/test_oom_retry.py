"""Run from the repo root: ~/ComfyUI/venv/bin/python -m unittest discover -s tests -v"""
import contextlib
import importlib
import io
import pathlib
import sys
import threading
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]

# oom_retry.py inside its own stand-in package with persistence stubbed (test_queue_edit.py uses "qm")
_pkg = types.ModuleType("qm_oom")
_pkg.__path__ = [str(ROOT)]
sys.modules["qm_oom"] = _pkg
held = [False]
sys.modules["qm_oom.persistence"] = types.SimpleNamespace(has_held=lambda: held[0])
oom_retry = importlib.import_module("qm_oom.oom_retry")

OOM = ("execution_error", {"prompt_id": "run", "node_type": "KSampler", "exception_type": "torch.OutOfMemoryError",
                           "exception_message": "Allocation on device\nThis error means you ran out of memory on your GPU."})


def status(state="error", error=OOM):
    messages = [("execution_start", {"prompt_id": "run", "timestamp": 1})] + ([error] if error else [])
    return types.SimpleNamespace(status_str=state, completed=state == "success", messages=messages)


class FakeQueue:
    def __init__(self, pending=()):
        self.mutex = threading.RLock()
        self.queue = list(pending)
        self.currently_running = {}
        self.flags = {}
        self.done = []

    def put(self, item):
        self.queue.append(item)

    def set_flag(self, name, value):
        self.flags[name] = value

    def task_done(self, item_id, history_result, status, process_item=None):
        self.done.append(self.currently_running.pop(item_id)[1])


QUEUED_FROM_FRONTEND = {"extra_pnginfo": {"workflow": {"extra": {"qm_queued_at": 111}}}}


def running_item(extra=None):
    return (7, "run", {"1": {"inputs": {"seed": 5}}},
            {"client_id": "c1", **QUEUED_FROM_FRONTEND, **(extra or {})}, ["9"], {"api_key": "secret"})


class RetryTest(unittest.TestCase):
    def setUp(self):
        held[0] = False

    def finish(self, q, item, st):
        oom_retry.install(q)
        q.currently_running[3] = item
        q.task_done(3, {"outputs": {}}, st)

    def test_out_of_memory_run_is_queued_again_at_the_front_once(self):
        q = FakeQueue([(5, "p1", {}, {}, []), (6, "p2", {}, {}, [])])
        with contextlib.redirect_stdout(io.StringIO()):
            self.finish(q, running_item(), status())
        self.assertEqual(q.done, ["run"])
        retry = q.queue[-1]
        self.assertEqual(retry[0], 4, "in front of every pending run")
        self.assertNotEqual(retry[1], "run")
        self.assertEqual(retry[2], {"1": {"inputs": {"seed": 5}}})
        self.assertEqual(retry[3], {"client_id": "c1", **QUEUED_FROM_FRONTEND, "qm_retry_of": "run"})
        self.assertEqual(retry[4], ["9"])
        self.assertEqual(retry[5], {"api_key": "secret"}, "tokens stay in memory for the retry")
        self.assertEqual(q.flags, {"free_memory": True})

    def test_recognised_by_comfys_tip_text_too_and_numbered_before_an_empty_queue(self):
        q = FakeQueue()
        tip = ("execution_error", {"exception_type": "RuntimeError", "exception_message": "x\nThis error means you ran out of memory on your GPU.\n"})
        with contextlib.redirect_stdout(io.StringIO()):
            self.finish(q, running_item(), status(error=tip))
        self.assertEqual(len(q.queue), 1)
        self.assertEqual(q.queue[0][0], 6, "the failed run's number - 1")

    def test_other_errors_successes_retries_and_paused_queues_are_not_retried(self):
        other = ("execution_error", {"exception_type": "ValueError", "exception_message": "bad input"})
        meta_batch_prompt = {"1": {"inputs": {}, "class_type": "VHS_BatchManager"}, "2": {"inputs": {}, "class_type": "KSampler"}}
        cases = [
            (running_item(), status(error=other), False),
            (running_item(), status("success", error=None), False),
            (running_item({"qm_retry_of": "older"}), status(), False),
            (running_item(), status(), True),   # paused
            ((7, "run", {}, {"client_id": "c1"}, ["9"], {}), status(), False),   # queued by a script: no qm_queued_at stamp
            (running_item({"extra_pnginfo": {"workflow": None}}), status(), False),   # null-safe: workflow may be None
            (running_item({"extra_pnginfo": {"workflow": {"extra": None}}}), status(), False),   # null-safe: extra may be None
            ((7, "run", meta_batch_prompt, {"client_id": "c1", **QUEUED_FROM_FRONTEND}, ["9"], {}), status(), False),   # VHS meta batch
        ]
        for item, st, paused in cases:
            held[0] = paused
            q = FakeQueue()
            self.finish(q, item, st)
            self.assertEqual(q.queue, [], (item[3], st.status_str, paused))
            self.assertEqual(q.done, ["run"])

    def test_a_failing_retry_never_breaks_task_done(self):
        q = FakeQueue()
        q.put = lambda item: 1 / 0
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.finish(q, running_item(), status())
        self.assertEqual(q.done, ["run"])
        self.assertIn("out-of-memory retry error", out.getvalue())

    def test_failure_note_for_the_notification(self):
        q = FakeQueue()
        q.currently_running[3] = running_item()
        data = OOM[1]
        self.assertEqual(oom_retry.failure_note(q, data, True), " — retrying once")
        self.assertEqual(oom_retry.failure_note(q, data, False), "")
        self.assertEqual(oom_retry.failure_note(q, {"prompt_id": "run", "exception_type": "ValueError"}, True), "")
        self.assertEqual(oom_retry.failure_note(q, {**data, "prompt_id": "unknown"}, True), "")
        held[0] = True
        self.assertEqual(oom_retry.failure_note(q, data, True), " — not retried (queue paused)")
        held[0] = False
        q.currently_running[3] = running_item({"qm_retry_of": "older"})
        self.assertEqual(oom_retry.failure_note(q, data, True), " — failed again after a retry")
        q.currently_running[3] = (7, "run", {}, {"client_id": "c1"}, ["9"], {})
        self.assertEqual(oom_retry.failure_note(q, data, True), " — not retried (queued by a script)")
        meta_batch_prompt = {"1": {"inputs": {}, "class_type": "VHS_BatchManager"}}
        q.currently_running[3] = (7, "run", meta_batch_prompt, {"client_id": "c1", **QUEUED_FROM_FRONTEND}, ["9"], {})
        self.assertEqual(oom_retry.failure_note(q, data, True), " — not retried (meta batch)")
