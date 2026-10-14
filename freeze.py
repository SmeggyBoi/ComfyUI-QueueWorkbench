"""
ComfyUI Queue Workbench — freeze the queue
------------------------------------------
While the queue is frozen ComfyUI's worker takes no new run: the running one finishes,
the pending ones keep their places in ComfyUI's queue (nothing is deleted or re-submitted).
Reasons to freeze: Pause, and every open edit tab (token -> prompt_id). An edit counts only
while its run is still pending, so deleting that run can't hold the queue.
"""
import json
import threading
import time

from aiohttp import web

_lock    = threading.Lock()    # "frozen?" + taking a run, and starting an edit, happen under it
_changed = threading.Event()   # set by every put and every unfreeze: wakes a waiting worker
_paused  = False
_edits   = {}                  # token -> prompt_id
_queue   = None


def _pending_ids():
    return {item[1] for item in _queue.get_current_queue_volatile()[1]}


def _frozen():
    """Call with _lock held."""
    return _paused or (bool(_edits) and bool(set(_edits.values()) & _pending_ids()))


def paused():
    return _paused


def state():
    with _lock:
        pending = _pending_ids()
        return {"paused": _paused, "editing": sorted({p for p in _edits.values() if p in pending})}


def set_paused(on):
    global _paused
    with _lock:
        _paused = on
    _changed.set()


def start_edit(token, prompt_id):
    """Freeze while prompt_id is edited; False (nothing held) when it isn't pending anymore."""
    with _lock:
        if prompt_id not in _pending_ids():
            return False
        _edits[token] = prompt_id
    return True


def end_edit(token):
    with _lock:
        _edits.pop(token, None)
    _changed.set()


def clear_edits():
    with _lock:
        _edits.clear()
    _changed.set()


def install(prompt_queue):
    """Gate the worker's get(): while frozen it takes nothing and returns None once its timeout
    passes, as for an empty queue, or at once when a flag (ComfyUI's /free) waits for the worker.
    It waits in slices of at most 1 s, so an edited run that is deleted lets the queue go on
    without anyone setting the event."""
    global _queue
    _queue = prompt_queue
    orig_put, orig_get, orig_set_flag = prompt_queue.put, prompt_queue.get, prompt_queue.set_flag

    def put(item):
        orig_put(item)
        _changed.set()

    def set_flag(name, data):
        orig_set_flag(name, data)
        _changed.set()

    def get(timeout=None):
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            with _lock:
                if prompt_queue.queue and not _frozen():
                    taken = orig_get(timeout=0)
                    if taken is not None:
                        return taken
            if prompt_queue.flags:
                return None
            left = None if deadline is None else deadline - time.monotonic()
            if left is not None and left <= 0:
                return None
            _changed.wait(1.0 if left is None else min(left, 1.0))
            _changed.clear()

    prompt_queue.put = put
    prompt_queue.get = get
    prompt_queue.set_flag = set_flag


def register_routes(server):
    routes = server.routes

    @routes.get("/queue_workbench/freeze")
    async def get_freeze(request):
        return web.json_response(state())

    @routes.post("/queue_workbench/freeze")
    async def post_freeze(request):
        """{"pause": bool} | {"edit": prompt_id, "token": str, "on": true} | {"token": str, "on": false}
        | {"edits": "clear"}. Read as text: sendBeacon posts text/plain when a page is left."""
        try:
            body = json.loads(await request.text())
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return web.json_response({"error": "expected a JSON object"}, status=400)
        if "pause" in body:
            set_paused(body["pause"] is True)
        elif body.get("edits") == "clear":
            clear_edits()
        elif isinstance(body.get("token"), str) and body.get("on") is True:
            if not start_edit(body["token"], body.get("edit")):
                return web.json_response({"not_pending": True, **state()}, status=409)
        elif isinstance(body.get("token"), str):
            end_edit(body["token"])
        else:
            return web.json_response({"error": "nothing to do"}, status=400)
        return web.json_response(state())
