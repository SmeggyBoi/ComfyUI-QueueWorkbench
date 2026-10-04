"""
ComfyUI Queue Workbench — time estimates
----------------------------------------
How long each queued run will take — the median duration of its workflow's newest
successful runs with the same time-relevant settings (else of any of its runs), from
the history columns in persistence.py — and how far the running run has got.

ComfyUI sends progress only to the client that queued a run, so the running run's
progress is captured here from every outgoing event (__init__.py's send_sync hook)
and served to every device: GET /queue_workbench/estimates.
"""
import statistics
import threading
import time

from aiohttp import web

from . import persistence

RECENT_RUNS = 5   # an estimate is the median of a workflow's newest successful runs, at most this many
_EVENTS = {"execution_start", "executing", "progress", "execution_success", "execution_error", "execution_interrupted"}
_NO_ESTIMATE = {"estimate_ms": None, "basis": None, "runs": 0}

_lock = threading.Lock()
_running = None   # {"prompt_id", "started_at", "node", "value", "max"} of the run executing now


def _now_ms():
    return int(time.time() * 1000)


def _state(prompt_id, started_at):
    return {"prompt_id": prompt_id, "started_at": started_at, "node": None, "value": None, "max": None}


def on_event(event, data):
    """Follow the running run through the events ComfyUI sends (called for every event)."""
    global _running
    if event not in _EVENTS or not isinstance(data, dict):
        return
    prompt_id = data.get("prompt_id")
    with _lock:
        mine = _running is not None and _running["prompt_id"] == prompt_id
        if event == "execution_start":
            _running = _state(prompt_id, data.get("timestamp") or _now_ms())
        elif event == "executing" and data.get("node") is not None:
            if not mine:   # queued without a client_id: ComfyUI sent no execution_start for it
                _running = _state(prompt_id, _now_ms())
            _running.update(node=data["node"], value=None, max=None)
        elif event == "progress":
            if mine:
                _running.update(node=data.get("node"), value=data.get("value"), max=data.get("max"))
        elif mine:   # the run's end, or executing with node None after it
            _running = None


def running_state():
    """A copy of the captured state of the running run, or None."""
    with _lock:
        return dict(_running) if _running is not None else None


def estimate(item, cache=None):
    """{"estimate_ms", "basis", "runs"} for a queue item, or None: the median duration of its
    workflow's newest successful runs with the same time signature (basis "settings"), else of
    any of its runs (basis "workflow"). cache memoises per (workflow, workflow_id, signature)."""
    workflow, workflow_id = persistence.run_workflow(item[3])
    if not workflow and not workflow_id:
        return None
    sig = persistence.time_signature(item[2])
    key = (workflow, workflow_id, sig)
    if cache is not None and key in cache:
        return cache[key]
    basis, durations = "settings", persistence.recent_durations(workflow, workflow_id, sig, RECENT_RUNS)
    if not durations:
        basis, durations = "workflow", persistence.recent_durations(workflow, workflow_id, None, RECENT_RUNS)
    result = {"estimate_ms": round(statistics.median(durations)), "basis": basis, "runs": len(durations)} if durations else None
    if cache is not None:
        cache[key] = result
    return result


def snapshot(prompt_queue, now_ms=None):
    """The estimates of the queue as it is now: the route's JSON answer. All times in ms on the
    server's clock, so devices with a wrong clock still add them up right."""
    now = _now_ms() if now_ms is None else now_ms
    running_items, pending_items = prompt_queue.get_current_queue_volatile()
    cache = {}
    remaining = unknown = 0
    running = None
    if running_items:
        item = running_items[0]
        est = estimate(item, cache)
        captured = running_state()
        live = captured if captured is not None and captured["prompt_id"] == item[1] else {}
        running = {"prompt_id": item[1], **(est or _NO_ESTIMATE), "started_at": live.get("started_at"),
                   "node": live.get("node"), "value": live.get("value"), "max": live.get("max")}
        if est is None:
            unknown += 1
        else:
            elapsed = now - running["started_at"] if running["started_at"] is not None else 0
            remaining += max(0, est["estimate_ms"] - elapsed)
    pending = {}
    for item in pending_items:
        est = pending[item[1]] = estimate(item, cache)
        if est is None:
            unknown += 1
        else:
            remaining += est["estimate_ms"]
    return {"now": now, "running": running, "pending": pending, "remaining_ms": remaining, "unknown": unknown}


def register_routes(server):
    @server.routes.get("/queue_workbench/estimates")
    async def get_estimates(request):
        """Estimated durations of the queued runs and the running run's progress (see snapshot)."""
        return web.json_response(snapshot(server.prompt_queue))
