"""Run from the repo root: ~/ComfyUI/venv/bin/python -m unittest discover -s tests -v"""
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("qm_summary", ROOT / "summary.py")
summary = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(summary)


class FakeTimer:
    def __init__(self, seconds, fn):
        self.seconds, self.fn, self.cancelled, self.daemon = seconds, fn, False, False

    def start(self):
        pass

    def cancel(self):
        self.cancelled = True


class SummaryTest(unittest.TestCase):
    def setUp(self):
        self.now = [0.0]
        self.remaining = [0]
        self.sent = []
        self.s = summary.QueueSummary(90, lambda: self.remaining[0], lambda *a: self.sent.append(a),
                                      clock=lambda: self.now[0], timer=FakeTimer)

    def run_one(self, name, state, start, end):
        self.now[0] = start
        self.s.on_start()
        self.now[0] = end
        self.s.on_finished(name, state)

    def test_a_batch_of_two_runs_sends_one_summary(self):
        self.run_one("Wf A", "success", 0, 100)
        self.s.on_output(("a.png", "", "output"))
        self.run_one("Wf B", "error", 100, 185)
        self.s.fire()
        self.assertEqual(self.sent, [("Queue finished ⚠️", "2 runs: 1 ✓ · 1 ✕ · 3m 05s\nFailed: Wf B", ("a.png", "", "output"))])
        self.s.fire()
        self.assertEqual(len(self.sent), 1, "batch is reset after sending")

    def test_a_single_run_sends_nothing(self):
        self.run_one("Wf A", "success", 0, 10)
        self.s.fire()
        self.assertEqual(self.sent, [])
        self.run_one("Wf A", "success", 20, 30)
        self.s.fire()
        self.assertEqual(self.sent, [], "a later single run is a new batch, not the second of the old one")

    def test_waits_while_runs_remain_and_counts_them_all(self):
        self.run_one("A", "success", 0, 10)
        self.run_one("B", "success", 10, 20)
        self.remaining[0] = 1
        self.s.fire()
        self.assertEqual(self.sent, [])
        self.remaining[0] = 0
        self.run_one("C", "interrupted", 20, 30)
        self.s.fire()
        self.assertEqual(self.sent[0][:2], ("Queue finished ⚠️", "3 runs: 2 ✓ · 0 ✕ · 1 ⏹ · 30s\nFailed: C"))

    def test_all_succeeded_and_long_failure_lists(self):
        for i in range(3):
            self.run_one(f"ok{i}", "success", i, i + 1)
        self.s.fire()
        self.assertEqual(self.sent[0][0], "Queue finished ✅")
        self.assertNotIn("Failed", self.sent[0][1])
        title, message = summary.summary_text([(f"r{i}", "error") for i in range(7)], 60)
        self.assertTrue(message.endswith("Failed: r0, r1, r2, r3, r4 +2 more"))

    def test_a_run_that_recovers_on_retry_merges_into_one_entry(self):
        self.now[0] = 0
        self.s.on_start()
        self.now[0] = 50
        self.s.on_finished("Wf A", "error", prompt_id="p1")
        self.now[0] = 90
        self.s.on_finished("Wf A", "success", prompt_id="p2", retry_of="p1")
        self.s.fire()
        self.assertEqual(self.sent, [], "one run after merging: below the 2+ runs threshold")

    def test_a_recovered_run_counts_as_a_success_not_a_failure(self):
        self.now[0] = 0
        self.s.on_start()
        self.now[0] = 50
        self.s.on_finished("Wf A", "error", prompt_id="p1")
        self.now[0] = 90
        self.s.on_finished("Wf A", "success", prompt_id="p2", retry_of="p1")
        self.now[0] = 120
        self.s.on_finished("Wf B", "success", prompt_id="p3")
        self.s.fire()
        self.assertEqual(self.sent, [("Queue finished ✅", "2 runs: 2 ✓ (1 after a retry) · 0 ✕ · 2m 00s", None)])

    def test_re_arms_the_timer_while_a_task_remains_then_sends_once_it_drains(self):
        self.run_one("A", "success", 0, 10)
        self.run_one("B", "error", 10, 20)
        self.remaining[0] = 1
        self.s.fire()
        self.assertEqual(self.sent, [], "still a task left: no summary yet")
        timer = self.s._timer
        self.assertIsNotNone(timer, "re-armed instead of being dropped")
        self.assertEqual(timer.seconds, 90)
        self.remaining[0] = 0
        timer.fn()
        self.assertEqual(len(self.sent), 1)

    def test_re_arms_with_at_least_one_second_when_quiet_seconds_is_zero(self):
        s = summary.QueueSummary(0, lambda: self.remaining[0], lambda *a: self.sent.append(a),
                                 clock=lambda: self.now[0], timer=FakeTimer)
        self.now[0] = 0
        s.on_start()
        self.now[0] = 10
        s.on_finished("A", "success")
        self.now[0] = 20
        s.on_finished("B", "error")
        self.remaining[0] = 1
        s.fire()
        self.assertIsNotNone(s._timer)
        self.assertEqual(s._timer.seconds, 1, "0 would mean Timer(0, ...) fires immediately in a loop")

    def test_a_new_run_cancels_the_pending_timer(self):
        self.run_one("A", "success", 0, 10)
        timer = self.s._timer
        self.s.on_start()
        self.assertTrue(timer.cancelled)

    def test_durations(self):
        self.assertEqual(summary.fmt_duration(42), "42s")
        self.assertEqual(summary.fmt_duration(185), "3m 05s")
        self.assertEqual(summary.fmt_duration(8040), "2h 14m")
