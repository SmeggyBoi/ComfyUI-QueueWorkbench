"""
ComfyUI Queue Workbench — persistence layer
-------------------------------------------
Mirrors ComfyUI's in-memory prompt queue to a small local SQLite database so
that pending (and paused/held) workflows survive a backend shutdown/crash.

ComfyUI keeps its queue entirely in RAM (execution.PromptQueue), so a restart
normally discards every unprocessed job. We keep a live mirror on disk by
wrapping the PromptQueue mutation methods. On the next startup, anything that
was still unprocessed is marked as a "saved" backlog that the user can restore
manually from the Queue Workbench panel (manual restore — nothing auto-runs).

A queue item is the tuple:
    (number, prompt_id, prompt, extra_data, outputs_to_execute, sensitive)
We never write the 6th `sensitive` element (Comfy.org auth/api tokens) to disk —
ComfyUI itself strips it from /queue and history, and it is stale after restart.

row origin values:
  'queue' — live mirror of the current in-RAM queue (this session)
  'held'  — items the Queue Workbench paused (deleted from the native queue,
            held client-side); persisted so a pause+shutdown doesn't lose them
  'saved' — backlog from a previous session, awaiting manual restore/discard
"""
import os
import json
import time
import sqlite3
import threading
import traceback

from aiohttp import web

_DB_PATH = os.path.join(os.path.dirname(__file__), "queue_persist.db")
_db_lock = threading.Lock()

# Set by setup_persistence()
_prompt_queue = None


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
def _connect():
    conn = sqlite3.connect(_DB_PATH, timeout=10.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _init_db():
    """Create the table and roll any leftover live/held rows from a previous
    session over to the 'saved' backlog."""
    with _db_lock, _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS saved_jobs (
                prompt_id TEXT PRIMARY KEY,
                number    REAL,
                origin    TEXT NOT NULL,
                item_json TEXT NOT NULL,
                saved_at  INTEGER NOT NULL
            )
        """)
        # Anything still marked live/held when we boot was orphaned by the last
        # shutdown — promote it to the restorable backlog.
        cur = conn.execute(
            "UPDATE saved_jobs SET origin='saved' WHERE origin IN ('queue','held')"
        )
        if cur.rowcount:
            print(f"[QueueWorkbench] {cur.rowcount} job(s) from previous session "
                  f"available to restore")


def _strip_sensitive(item):
    """Return a JSON-serializable 5-element item with the sensitive field dropped."""
    # item may be a tuple/list of length 5 or 6
    seq = list(item)
    number = seq[0] if len(seq) > 0 else 0
    prompt_id = seq[1] if len(seq) > 1 else None
    prompt = seq[2] if len(seq) > 2 else {}
    extra_data = seq[3] if len(seq) > 3 else {}
    outputs = seq[4] if len(seq) > 4 else []
    return number, prompt_id, [number, prompt_id, prompt, extra_data, outputs]


# ---------------------------------------------------------------------------
# Live mirror
# ---------------------------------------------------------------------------
def resync_queue():
    """Rewrite all origin='queue' rows to match the current in-RAM queue
    (both running and pending items count as unprocessed/in-flight)."""
    if _prompt_queue is None:
        return
    try:
        running, pending = _prompt_queue.get_current_queue_volatile()
        items = list(running) + list(pending)
        now = int(time.time())
        with _db_lock, _connect() as conn:
            conn.execute("DELETE FROM saved_jobs WHERE origin='queue'")
            for it in items:
                try:
                    number, prompt_id, payload = _strip_sensitive(it)
                    if prompt_id is None:
                        continue
                    conn.execute(
                        "INSERT OR REPLACE INTO saved_jobs "
                        "(prompt_id, number, origin, item_json, saved_at) "
                        "VALUES (?,?, 'queue', ?, ?)",
                        (prompt_id, number, json.dumps(payload), now),
                    )
                except Exception:
                    print(f"[QueueWorkbench] skip item during resync:\n{traceback.format_exc()}")
    except Exception:
        print(f"[QueueWorkbench] resync_queue error:\n{traceback.format_exc()}")


def _install_queue_hooks(prompt_queue):
    """Wrap the PromptQueue mutation methods so the mirror stays in sync no
    matter how a job enters or leaves the queue."""
    orig_put = prompt_queue.put
    orig_get = prompt_queue.get
    orig_task_done = prompt_queue.task_done
    orig_delete = prompt_queue.delete_queue_item
    orig_wipe = prompt_queue.wipe_queue

    def put(item):
        orig_put(item)
        resync_queue()

    def get(timeout=None):
        result = orig_get(timeout=timeout)
        resync_queue()
        return result

    def task_done(item_id, history_result, status, process_item=None):
        orig_task_done(item_id, history_result, status, process_item=process_item)
        resync_queue()

    def delete_queue_item(function):
        result = orig_delete(function)
        resync_queue()
        return result

    def wipe_queue():
        orig_wipe()
        resync_queue()

    prompt_queue.put = put
    prompt_queue.get = get
    prompt_queue.task_done = task_done
    prompt_queue.delete_queue_item = delete_queue_item
    prompt_queue.wipe_queue = wipe_queue


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------
def _register_routes(server):
    routes = server.routes

    @routes.get("/queue_workbench/saved")
    async def get_saved(request):
        """List the backlog of jobs saved from previous sessions (origin='saved')."""
        with _db_lock, _connect() as conn:
            rows = conn.execute(
                "SELECT item_json FROM saved_jobs WHERE origin='saved' "
                "ORDER BY number ASC"
            ).fetchall()
        jobs = []
        for (item_json,) in rows:
            try:
                jobs.append(json.loads(item_json))
            except Exception:
                pass
        return web.json_response({"jobs": jobs, "count": len(jobs)})

    @routes.post("/queue_workbench/restore")
    async def restore(request):
        """Re-enqueue saved jobs into the live queue. Body may contain
        {"prompt_ids": [...]} to restore a subset; omit to restore all."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        wanted = body.get("prompt_ids")

        with _db_lock, _connect() as conn:
            if wanted:
                placeholders = ",".join("?" * len(wanted))
                rows = conn.execute(
                    f"SELECT prompt_id, number, item_json FROM saved_jobs "
                    f"WHERE origin='saved' AND prompt_id IN ({placeholders}) "
                    f"ORDER BY number ASC",
                    wanted,
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT prompt_id, number, item_json FROM saved_jobs "
                    "WHERE origin='saved' ORDER BY number ASC"
                ).fetchall()

        restored = 0
        for prompt_id, number, item_json in rows:
            try:
                number, _pid, prompt, extra_data, outputs = json.loads(item_json)
                # Re-enqueue. Empty sensitive dict — stale tokens are not restored.
                _prompt_queue.put((number, prompt_id, prompt, extra_data, outputs, {}))
                restored += 1
            except Exception:
                print(f"[QueueWorkbench] restore failed for {prompt_id}:\n{traceback.format_exc()}")

        # The mirror hook re-saves them as origin='queue'; drop the 'saved' rows.
        if rows:
            ids = [r[0] for r in rows]
            placeholders = ",".join("?" * len(ids))
            with _db_lock, _connect() as conn:
                conn.execute(
                    f"DELETE FROM saved_jobs WHERE origin='saved' "
                    f"AND prompt_id IN ({placeholders})",
                    ids,
                )
        return web.json_response({"restored": restored})

    @routes.post("/queue_workbench/saved/discard")
    async def discard(request):
        """Delete saved jobs without restoring. Body {"prompt_ids":[...]} or
        {"all": true}."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        with _db_lock, _connect() as conn:
            if body.get("all"):
                cur = conn.execute("DELETE FROM saved_jobs WHERE origin='saved'")
            else:
                ids = body.get("prompt_ids", [])
                if not ids:
                    return web.json_response({"discarded": 0})
                placeholders = ",".join("?" * len(ids))
                cur = conn.execute(
                    f"DELETE FROM saved_jobs WHERE origin='saved' "
                    f"AND prompt_id IN ({placeholders})",
                    ids,
                )
        return web.json_response({"discarded": cur.rowcount})

    @routes.post("/queue_workbench/held")
    async def set_held(request):
        """Replace the persisted set of paused/held items. Body
        {"items": [ [number, prompt_id, prompt, extra_data, outputs], ... ]}.
        Called by the frontend when the queue is paused."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        items = body.get("items", [])
        now = int(time.time())
        with _db_lock, _connect() as conn:
            conn.execute("DELETE FROM saved_jobs WHERE origin='held'")
            for it in items:
                try:
                    number, prompt_id, payload = _strip_sensitive(it)
                    if prompt_id is None:
                        continue
                    conn.execute(
                        "INSERT OR REPLACE INTO saved_jobs "
                        "(prompt_id, number, origin, item_json, saved_at) "
                        "VALUES (?,?, 'held', ?, ?)",
                        (prompt_id, number, json.dumps(payload), now),
                    )
                except Exception:
                    pass
        return web.json_response({"held": len(items)})

    @routes.post("/queue_workbench/held/clear")
    async def clear_held(request):
        """Clear the persisted held set (called on resume)."""
        with _db_lock, _connect() as conn:
            conn.execute("DELETE FROM saved_jobs WHERE origin='held'")
        return web.json_response({"ok": True})



# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def setup_persistence(server):
    global _prompt_queue
    try:
        _init_db()
        _prompt_queue = getattr(server, "prompt_queue", None)
        if _prompt_queue is None:
            print("[QueueWorkbench] server.prompt_queue not available — persistence disabled")
            return
        _install_queue_hooks(_prompt_queue)
        _register_routes(server)
        # Sync once at startup in case a queue already exists (it normally won't).
        resync_queue()
    except Exception:
        print(f"[QueueWorkbench] setup failed:\n{traceback.format_exc()}")
