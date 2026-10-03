"""
ComfyUI Queue Workbench — "queue finished" summary
--------------------------------------------------
Collects the runs from the queue becoming busy until it has stayed empty for the
quiet period, then sends one notification when the batch had two or more runs
(a single run's own notification already says everything).
"""
import threading
import time


def fmt_duration(seconds):
    s = round(seconds)
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60:02d}s"
    return f"{s // 3600}h {s // 60 % 60:02d}m"


def summary_text(runs, seconds, recovered=0):
    """(title, message) for a finished batch; runs = [(name, "success" | "error" | "interrupted")].
    recovered = how many of those successes only got there after an out-of-memory retry."""
    count = {state: sum(1 for _, s in runs if s == state) for state in ("success", "error", "interrupted")}
    success = f"{count['success']} ✓" + (f" ({recovered} after a retry)" if recovered else "")
    parts = [f"{len(runs)} runs: {success}", f"{count['error']} ✕"]
    if count["interrupted"]:
        parts.append(f"{count['interrupted']} ⏹")
    parts.append(fmt_duration(seconds))
    message = " · ".join(parts)
    failed = [name for name, state in runs if state != "success"]
    if failed:
        message += "\nFailed: " + ", ".join(failed[:5]) + (f" +{len(failed) - 5} more" if len(failed) > 5 else "")
    return ("Queue finished ⚠️" if failed else "Queue finished ✅"), message


class QueueSummary:
    def __init__(self, quiet_seconds, tasks_remaining, send, clock=time.time, timer=threading.Timer):
        self._quiet = quiet_seconds
        self._tasks_remaining = tasks_remaining
        self._send = send            # send(title, message, last_output or None)
        self._clock = clock
        self._timer_factory = timer
        self._timer = None
        self._batch = None
        self._lock = threading.Lock()

    def on_start(self):
        with self._lock:
            self._cancel()
            self._open()

    def on_output(self, output):
        with self._lock:
            if self._batch:
                self._batch["last_output"] = output

    def on_finished(self, name, state, prompt_id=None, retry_of=None):
        with self._lock:
            self._open()
            runs = self._batch["runs"]
            # a run that recovered on an out-of-memory retry completes under a new prompt_id that
            # names the original: replace that entry instead of appending a second one for it.
            run = next((r for r in runs if retry_of is not None and r["prompt_id"] == retry_of), None)
            if run is not None:
                run["state"], run["prompt_id"], run["retried"] = state, prompt_id, True
            else:
                runs.append({"name": name, "state": state, "prompt_id": prompt_id, "retried": False})
            self._batch["ended"] = self._clock()
            self._cancel()
            self._timer = self._timer_factory(self._quiet, self.fire)
            self._timer.daemon = True
            self._timer.start()

    def fire(self):
        remaining = self._tasks_remaining()   # outside our lock: it takes the queue mutex
        with self._lock:
            self._timer = None
            if self._batch is None:
                return
            if remaining > 0:   # execution_success fires before task_done; wait for it to drain
                self._timer = self._timer_factory(max(self._quiet, 1), self.fire)
                self._timer.daemon = True
                self._timer.start()
                return
            batch, self._batch = self._batch, None
        runs = batch["runs"]
        if len(runs) >= 2:
            recovered = sum(1 for r in runs if r["retried"] and r["state"] == "success")
            pairs = [(r["name"], r["state"]) for r in runs]
            title, message = summary_text(pairs, batch["ended"] - batch["started"], recovered)
            self._send(title, message, batch["last_output"])

    def _open(self):
        if self._batch is None:
            self._batch = {"started": self._clock(), "runs": [], "ended": None, "last_output": None}

    def _cancel(self):
        if self._timer:
            self._timer.cancel()
            self._timer = None
