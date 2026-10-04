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

Finished runs are also kept (table `history`, newest HISTORY_LIMIT) for the
panel's History tab, since ComfyUI's own history is RAM-only as well.
"""
import os
import re
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
        conn.execute("""
            CREATE TABLE IF NOT EXISTS history (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                prompt_id   TEXT UNIQUE NOT NULL,
                run_json    TEXT NOT NULL,
                entry_json  TEXT NOT NULL,
                workflow    TEXT,
                workflow_id TEXT,
                status      TEXT,
                sig         TEXT,
                duration_ms INTEGER
            )
        """)
        _migrate_history(conn)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS history_estimates ON history(workflow, workflow_id, sig, status, duration_ms)"
        )
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
        running = prompt_queue.currently_running.get(item_id)   # the original pops it
        orig_task_done(item_id, history_result, status, process_item=process_item)
        resync_queue()
        if running is not None:
            _record_finished(prompt_queue, running[1])

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
# Run history — finished runs, kept across restarts (ComfyUI's own history is
# RAM-only). run_json is what the panel lists, entry_json the full entry.
# ---------------------------------------------------------------------------
HISTORY_LIMIT = 200

# Derived columns, filled from each run's entry: what the time estimates (estimates.py)
# and history filters query without parsing every stored entry. NULL where a run doesn't say.
HISTORY_COLUMNS = (("workflow", "TEXT"), ("workflow_id", "TEXT"), ("status", "TEXT"),
                   ("sig", "TEXT"), ("duration_ms", "INTEGER"))

# Inputs that change how long a run takes. Primitive nodes carry the input's name in their
# title, read like the panel's setting chips do: "Float (duration, seconds)" -> "duration"
TIME_INPUT_RE = re.compile(r"^(steps|frames|num_frames|frame_count|length|video_length|duration|seconds"
                           r"|width|height|fps|frame_rate|batch_size)$")
_PRIMITIVE_TITLE_RE = re.compile(r"^\w+\s*\(([^,)]*).*\)$", re.ASCII)
_END_EVENTS = ("execution_success", "execution_error", "execution_interrupted")


def _dict(value):
    return value if isinstance(value, dict) else {}


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def time_signature(prompt):
    """Sorted "name=value" pairs of a prompt's numeric time-relevant inputs, joined with "|".
    Two runs of a workflow with the same signature should take about as long."""
    pairs = []
    for node in _dict(prompt).values():
        node = _dict(node)
        for key, value in _dict(node.get("inputs")).items():
            if not _number(value):
                continue
            name = key
            if key == "value":
                title = _dict(node.get("_meta")).get("title") or node.get("class_type") or ""
                name = _PRIMITIVE_TITLE_RE.sub(r"\1", str(title))
            name = name.lower()
            if TIME_INPUT_RE.fullmatch(name):
                pairs.append(f"{name}={value:g}")
    return "|".join(sorted(pairs))


def _first_messages(status):
    """event -> data of the first status message of each event type."""
    messages = _dict(status).get("messages")
    found = {}
    for message in messages if isinstance(messages, (list, tuple)) else []:
        if isinstance(message, (list, tuple)) and len(message) == 2 and isinstance(message[0], str):
            found.setdefault(message[0], _dict(message[1]))
    return found


def run_status(status):
    """success / error / interrupted, the panel's runResult rule: ComfyUI reports an interrupt
    as status_str "error" with an execution_interrupted message. None without a status."""
    if not isinstance(status, dict):
        return None
    if status.get("status_str") == "success":
        return "success"
    return "interrupted" if "execution_interrupted" in _first_messages(status) else "error"


def run_duration_ms(status):
    """execution_start to the run's end message, from their timestamps; None if one is missing."""
    found = _first_messages(status)
    start = found.get("execution_start", {}).get("timestamp")
    end = next((found[event].get("timestamp") for event in _END_EVENTS if event in found), None)
    if not (_number(start) and _number(end)) or end < start:
        return None
    return int(end - start)


_UNSAVED_NAME_RE = re.compile(r"^Unsaved Workflow( \(\d+\))?$")


def run_workflow(extra_data):
    """(workflow name without .json, GUI workflow id) of a run's extra_data; None where unknown.
    The GUI's placeholder tab name for an unsaved workflow counts as no name — otherwise it would
    pool every unrelated unsaved workflow under the same key and split a saved workflow's history
    from its re-run-from-output copy (same GUI id, placeholder name)."""
    workflow = _dict(_dict(_dict(extra_data).get("extra_pnginfo")).get("workflow"))
    name = _dict(workflow.get("extra")).get("qm_name")
    name = name.removesuffix(".json") if isinstance(name, str) else None
    if name and _UNSAVED_NAME_RE.match(name):
        name = None
    workflow_id = workflow.get("id")
    return (name or None), (str(workflow_id) if workflow_id else None)


def history_columns(entry):
    """The HISTORY_COLUMNS values of a history entry: (workflow, workflow_id, status, sig, duration_ms)."""
    entry = _dict(entry)
    prompt = entry.get("prompt")
    prompt = prompt if isinstance(prompt, (list, tuple)) else []
    graph = prompt[2] if len(prompt) > 2 else None
    extra_data = prompt[3] if len(prompt) > 3 else None
    status = entry.get("status")
    return (*run_workflow(extra_data), run_status(status), time_signature(graph), run_duration_ms(status))


def _migrate_history(conn):
    """Give a history table from before the derived columns those columns, and back-fill every
    row still missing them (WHERE sig IS NULL — a parsed entry always gets a string signature,
    "" at minimum). Runs on every start, not just when the ALTER just added the columns: the
    ALTER autocommits immediately, so a crash between it and the one-time backfill used to leave
    those rows NULL for good. A row whose entry can't be read keeps NULLs and is retried next start."""
    present = {row[1] for row in conn.execute("PRAGMA table_info(history)")}
    missing = [(name, kind) for name, kind in HISTORY_COLUMNS if name not in present]
    for name, kind in missing:
        conn.execute(f"ALTER TABLE history ADD COLUMN {name} {kind}")
    assignments = ", ".join(f"{name}=?" for name, _ in HISTORY_COLUMNS)
    rows = conn.execute("SELECT id, entry_json FROM history WHERE sig IS NULL").fetchall()
    filled = 0
    for row_id, entry_json in rows:
        try:
            columns = history_columns(json.loads(entry_json))
        except ValueError:
            continue
        conn.execute(f"UPDATE history SET {assignments} WHERE id=?", (*columns, row_id))
        filled += 1
    if filled:
        print(f"[QueueWorkbench] history: backfilled {', '.join(name for name, _ in HISTORY_COLUMNS)} "
              f"for {len(rows)} finished run(s)")


def _list_row(entry):
    """The entry with its GUI workflow cut down to the id and extra stamps the panel rows
    use: a saved workflow can be ~700 KB and a page lists 50 runs."""
    number, prompt_id, prompt, extra_data, outputs = entry["prompt"]
    extra_data = dict(extra_data or {})
    workflow = (extra_data.pop("extra_pnginfo", None) or {}).get("workflow")
    if workflow:
        extra_data["extra_pnginfo"] = {"workflow": {"id": workflow.get("id"), "extra": workflow.get("extra") or {}}}
    return {"prompt": [number, prompt_id, prompt, extra_data, outputs],
            "outputs": entry.get("outputs") or {}, "status": entry.get("status")}


def _clean_status(status):
    """A copy of a ComfyUI status dict whose messages have current_inputs/current_outputs
    removed. Those two execution_error fields carry the failing node's raw inputs — which,
    for the PROMPT/EXTRA_PNGINFO hidden inputs, is the full API prompt and workflow as
    strings, and for some V1 nodes an API_KEY_COMFY_ORG / AUTH_TOKEN_COMFY_ORG — so they
    must never reach disk. Leaves the caller's status untouched."""
    if status is None:
        return None
    cleaned = dict(status)
    cleaned["messages"] = [
        [event, {k: v for k, v in (data or {}).items() if k not in ("current_inputs", "current_outputs")}]
        for event, data in (cleaned.get("messages") or [])
    ]
    return cleaned


def record_history(entry):
    """Store a finished run (a ComfyUI history entry) and keep the newest HISTORY_LIMIT."""
    cleaned = dict(entry)
    cleaned["status"] = _clean_status(entry.get("status"))
    full = {key: cleaned.get(key) for key in ("prompt", "outputs", "status")}
    run_json = json.dumps(_list_row(cleaned))
    entry_json = json.dumps(full)
    with _db_lock, _connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO history (prompt_id, run_json, entry_json, workflow, workflow_id, status, sig, "
            "duration_ms) VALUES (?,?,?,?,?,?,?,?)",
            (entry["prompt"][1], run_json, entry_json, *history_columns(cleaned)),
        )
        conn.execute(
            "DELETE FROM history WHERE id NOT IN "
            "(SELECT id FROM history ORDER BY id DESC LIMIT ?)",
            (HISTORY_LIMIT,),
        )


def list_history(limit=50, before=None, after=None):
    """Finished runs, newest first: every run newer than `after`, else the newest `limit`
    (older than `before` if given). Returns (runs, more); more = older runs exist."""
    if after is not None:
        sql, args = "WHERE id > ? ORDER BY id DESC", (after,)
    elif before is not None:
        sql, args = "WHERE id < ? ORDER BY id DESC LIMIT ?", (before, limit + 1)
    else:
        sql, args = "ORDER BY id DESC LIMIT ?", (limit + 1,)
    with _db_lock, _connect() as conn:
        rows = conn.execute(f"SELECT id, run_json FROM history {sql}", args).fetchall()
    more = after is None and len(rows) > limit
    runs = []
    for row_id, run_json in (rows[:limit] if more else rows):
        try:
            runs.append({"id": row_id, **json.loads(run_json)})
        except ValueError:
            pass
    return runs, more


def get_history_entry(prompt_id):
    """The full entry of a finished run (with the whole workflow), or None."""
    with _db_lock, _connect() as conn:
        row = conn.execute("SELECT entry_json FROM history WHERE prompt_id=?", (prompt_id,)).fetchone()
    return json.loads(row[0]) if row else None


def delete_history(prompt_ids):
    if not prompt_ids:
        return 0
    placeholders = ",".join("?" * len(prompt_ids))
    with _db_lock, _connect() as conn:
        return conn.execute(f"DELETE FROM history WHERE prompt_id IN ({placeholders})", prompt_ids).rowcount


def has_held():
    """True while the panel holds paused runs, i.e. the queue is paused."""
    with _db_lock, _connect() as conn:
        return conn.execute("SELECT 1 FROM saved_jobs WHERE origin='held' LIMIT 1").fetchone() is not None


def recent_durations(workflow, workflow_id, sig=None, limit=5):
    """duration_ms of a workflow's newest `limit` successful runs, newest first. Matched by name
    when the run has one, else by GUI workflow id among the unnamed runs; with `sig`, only runs
    with that time signature. [] without a name or id."""
    if workflow:
        where, args = "workflow = ?", [workflow]
    elif workflow_id:
        where, args = "workflow IS NULL AND workflow_id = ?", [workflow_id]
    else:
        return []
    if sig is not None:
        where += " AND sig = ?"
        args.append(sig)
    with _db_lock, _connect() as conn:
        rows = conn.execute(
            f"SELECT duration_ms FROM history WHERE status = 'success' AND duration_ms IS NOT NULL AND {where} "
            f"ORDER BY id DESC LIMIT ?",
            (*args, limit),
        ).fetchall()
    return [duration_ms for (duration_ms,) in rows]


def _record_finished(prompt_queue, prompt_id):
    try:
        entry = prompt_queue.get_history(prompt_id=prompt_id).get(prompt_id)
        if entry:
            record_history(entry)
    except Exception:
        print(f"[QueueWorkbench] history record error:\n{traceback.format_exc()}")


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

    @routes.get("/queue_workbench/history")
    async def get_history(request):
        """Finished runs, newest first: ?limit=50[&before=<id>] pages back, ?after=<id>
        returns the runs recorded since. Workflows are cut down (see _list_row)."""
        query = request.rel_url.query
        try:
            limit = int(query.get("limit", 50))
            before = int(query["before"]) if "before" in query else None
            after = int(query["after"]) if "after" in query else None
        except ValueError:
            return web.json_response({"error": "limit, before and after must be integers"}, status=400)
        runs, more = list_history(limit, before, after)
        return web.json_response({"runs": runs, "more": more})

    @routes.get("/queue_workbench/history/{prompt_id}")
    async def get_history_run(request):
        """The full entry of one finished run, to load it onto the canvas or queue it again."""
        entry = get_history_entry(request.match_info["prompt_id"])
        if entry is None:
            return web.json_response({"error": "not in history"}, status=404)
        return web.json_response({"run": entry})

    @routes.post("/queue_workbench/history/delete")
    async def history_delete(request):
        """Body {"prompt_ids": [...]}: remove these runs from the history."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        return web.json_response({"deleted": delete_history(body.get("prompt_ids", []))})


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
