"""
ComfyUI Queue Workbench — Python backend
- Captures live preview frames server-side so any connected client can poll them.
- Optional ntfy push notification when a generation finishes (see config.example.json).
- Queue persistence and run history (persistence.py), in-place edit / reorder routes (queue_edit.py).
"""
import base64
import json
import os
import re
import threading
import time
import traceback
import urllib.parse
import urllib.request
from pathlib import Path

import folder_paths
from aiohttp import web
from server import PromptServer

from . import oom_retry, summary

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


# ---------------------------------------------------------------------------
# Optional settings: config.json next to this file (see config.example.json),
# overridden by QUEUE_WORKBENCH_NTFY_URL / QUEUE_WORKBENCH_PUBLIC_URL.
# ---------------------------------------------------------------------------
def _load_config():
    config = {"ntfy_url": "", "public_url": "", "ntfy_quiet_seconds": 90, "oom_retry": True}
    path = Path(__file__).parent / "config.json"
    if path.exists():
        try:
            config.update(json.loads(path.read_text()))
        except ValueError as e:
            print(f"[QueueWorkbench] ignoring config.json: {e}")
    config["ntfy_url"] = os.environ.get("QUEUE_WORKBENCH_NTFY_URL", config["ntfy_url"]).strip()
    config["public_url"] = os.environ.get("QUEUE_WORKBENCH_PUBLIC_URL", config["public_url"]).strip().rstrip("/")
    return config


_config = _load_config()


# ---------------------------------------------------------------------------
# Live preview capture
# ---------------------------------------------------------------------------
_latest_preview  = None
_step_frames     = []       # frames for the current diffusion step
_step_id         = 0        # increments each time a new step starts
_last_frame_time = 0.0
_STEP_GAP_S      = 0.4      # 400ms silence = new step boundary
_preview_lock    = threading.Lock()


def _find_jpeg(data):
    """Extract raw JPEG/PNG bytes from the shapes preview events come in."""
    if isinstance(data, (bytes, bytearray)):
        raw = bytes(data)
        for i in range(min(64, len(raw) - 1)):
            if raw[i:i + 2] == b'\xff\xd8' or raw[i:i + 4] == b'\x89PNG':
                return raw[i:]
    elif isinstance(data, (list, tuple)) and data:
        return _find_jpeg(data[0])
    elif isinstance(data, dict):
        for key in ('images', 'image', 'data', 'preview'):
            val = data.get(key)
            if val is None:
                continue
            if isinstance(val, list) and val:
                val = val[0]
            result = _find_jpeg(val)
            if result:
                return result
    return None


def _capture_preview(event, data):
    """Buffer a preview frame for the current diffusion step."""
    global _latest_preview, _step_frames, _step_id, _last_frame_time
    if event != "b_preview" and event != 1:
        return
    jpeg = _find_jpeg(data)
    if not jpeg:
        return
    now = time.time()
    with _preview_lock:
        if now - _last_frame_time > _STEP_GAP_S and _step_frames:   # gap in frames = new step
            _step_frames = []
            _step_id += 1
        _last_frame_time = now
        _latest_preview = jpeg
        _step_frames.append(jpeg)


# ---------------------------------------------------------------------------
# ntfy notifications (only when ntfy_url is configured)
# ---------------------------------------------------------------------------
_pending_outputs = []

# TRAILING-EDGE debounce: a workflow can fire many execution_success events (e.g. one per VHS
# meta_batch iteration, then an enhance pass). Send ONE notification carrying the final output:
# remember the newest collected output on every success and fire once the burst has been quiet
# for ntfy_quiet_seconds.
_ntfy_timer  = [None]
_ntfy_lock   = threading.Lock()
_best_output = [None]       # newest (fname, subfolder, ftype) seen in the current burst


def _send_ntfy(title, message, priority="high", tags="white_check_mark", attach_url=None, filename=None):
    # Everything goes in query parameters: no header encoding issues with emoji titles
    params = {"title": title, "priority": priority, "tags": tags}
    if attach_url:
        params["attach"] = attach_url
        params["actions"] = f"view, Open in browser, {attach_url}"
    if filename:
        params["filename"] = filename
    request = urllib.request.Request(f"{_config['ntfy_url']}?{urllib.parse.urlencode(params)}",
                                     data=message.encode("utf-8"), method="POST")
    try:
        urllib.request.urlopen(request, timeout=10).close()
    except (OSError, ValueError) as e:
        print(f"[QueueWorkbench] ntfy error: {e}")


def _collect_outputs(data):
    if not isinstance(data, dict):
        return
    outputs = data.get("output") or {}        # 'output' can be present but None (subgraphs/bypassed)
    for key in ("images", "gifs", "videos", "files"):
        for item in (outputs.get(key) or []):
            if isinstance(item, dict) and "filename" in item:
                _pending_outputs.append((item["filename"], item.get("subfolder", ""), item.get("type", "output")))


def _cancel_ntfy_timer():
    with _ntfy_lock:
        if _ntfy_timer[0]:
            _ntfy_timer[0].cancel()
            _ntfy_timer[0] = None
        _best_output[0] = None


def _notify_complete():
    global _pending_outputs
    with _ntfy_lock:
        if _pending_outputs:                 # the last pass of a burst wins
            _best_output[0] = _pending_outputs[-1]
        _pending_outputs = []
        if _ntfy_timer[0]:
            _ntfy_timer[0].cancel()          # push the fire time out; only the quiet tail sends
        timer = threading.Timer(_config["ntfy_quiet_seconds"], _fire_ntfy)
        timer.daemon = True
        _ntfy_timer[0] = timer
        timer.start()


def _fire_ntfy():
    with _ntfy_lock:
        out = _best_output[0]
        _best_output[0] = None
        _ntfy_timer[0] = None
    if not out:
        _send_ntfy("Generation complete ✅", "Your ComfyUI workflow finished.")
        return
    fname = out[0]
    if not _config["public_url"]:
        _send_ntfy("Generation complete ✅", f"Finished: {fname}")
        return
    attach_url = _view_url(out)
    _send_ntfy("Generation complete ✅", f"Tap to download {fname}.", attach_url=attach_url, filename=fname)


def _view_url(out):
    fname, subfolder, ftype = out
    params = {"filename": fname, "type": ftype}
    if subfolder:
        params["subfolder"] = subfolder
    return f"{_config['public_url']}/view?{urllib.parse.urlencode(params)}"


def _send_summary(title, message, out):
    if out and _config["public_url"]:
        _send_ntfy(title, message, tags="checkered_flag", attach_url=_view_url(out), filename=out[0])
    else:
        _send_ntfy(title, message, tags="checkered_flag")


# ---------------------------------------------------------------------------
# Hooks into the server's outgoing events
# ---------------------------------------------------------------------------
server = PromptServer.instance
_orig_send_sync = server.send_sync
_summary = summary.QueueSummary(_config["ntfy_quiet_seconds"], server.prompt_queue.get_tasks_remaining, _send_summary)


def _run_info(data):
    """(name, prompt_id, retry_of) of the run an event belongs to; it is still in currently_running
    while its events fire. retry_of is the prompt_id this run was itself queued again from, if any."""
    prompt_id = data.get("prompt_id") if isinstance(data, dict) else None
    for item in list(server.prompt_queue.currently_running.values()):
        if item[1] == prompt_id:
            workflow = ((item[3] or {}).get("extra_pnginfo") or {}).get("workflow") or {}
            name = (workflow.get("extra") or {}).get("qm_name")
            retry_of = (item[3] or {}).get("qm_retry_of")
            return (name.removesuffix(".json") if name else "Unnamed run"), prompt_id, retry_of
    return "Unnamed run", prompt_id, None


def _hooked_send_sync(event, data, sid=None):
    try:
        _capture_preview(event, data)
        if _config["ntfy_url"]:
            if event == "execution_start":
                _summary.on_start()
            elif event == "executed":
                _collect_outputs(data)
                if _pending_outputs:
                    _summary.on_output(_pending_outputs[-1])
            elif event == "execution_success":
                name, prompt_id, retry_of = _run_info(data)
                _summary.on_finished(name, "success", prompt_id, retry_of)
                _notify_complete()
            elif event == "execution_interrupted":
                name, prompt_id, retry_of = _run_info(data)
                _summary.on_finished(name, "interrupted", prompt_id, retry_of)
            elif event == "execution_error":
                name, prompt_id, retry_of = _run_info(data)
                _summary.on_finished(name, "error", prompt_id, retry_of)
                _pending_outputs.clear()
                _cancel_ntfy_timer()             # drop any armed success timer from this burst
                error_msg = data.get("exception_message", "Unknown error") if isinstance(data, dict) else "Unknown error"
                try:
                    note = oom_retry.failure_note(server.prompt_queue, data, _config["oom_retry"]) if isinstance(data, dict) else ""
                except Exception:
                    note = ""
                threading.Thread(target=_send_ntfy, args=("Generation failed ❌", error_msg[:100] + note, "high", "x"),
                                 daemon=True).start()
    except Exception:
        print(f"[QueueWorkbench] event hook error:\n{traceback.format_exc()}")
    return _orig_send_sync(event, data, sid)


server.send_sync = _hooked_send_sync

if hasattr(server, "send_bytes_sync"):
    _orig_send_bytes_sync = server.send_bytes_sync

    def _hooked_send_bytes_sync(event, data, sid=None):
        try:
            _capture_preview(event, data)
        except Exception:
            print(f"[QueueWorkbench] preview hook error:\n{traceback.format_exc()}")
        return _orig_send_bytes_sync(event, data, sid)

    server.send_bytes_sync = _hooked_send_bytes_sync


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------
routes = server.routes


@routes.get("/queue_workbench/preview")
async def get_preview(request):
    with _preview_lock:
        data = _latest_preview
    if data is None:
        return web.Response(status=404)
    return web.Response(body=data, content_type="image/jpeg", headers={"Cache-Control": "no-store"})


@routes.get("/queue_workbench/frames")
async def get_frames(request):
    """All frames of the current diffusion step as base64 JSON."""
    with _preview_lock:
        frames  = list(_step_frames)
        step_id = _step_id
    if not frames:
        return web.Response(status=404)
    encoded = [base64.b64encode(f).decode() for f in frames]
    return web.json_response({"frames": encoded, "step_id": step_id, "count": len(encoded)})


@routes.post("/queue_workbench/preview/clear")
async def clear_preview(request):
    global _latest_preview, _step_frames, _step_id
    with _preview_lock:
        _latest_preview = None
        _step_frames = []
        _step_id = 0
    return web.Response(status=200)


@routes.get("/queue_workbench/build")
async def build_stamp(request):
    """BUILD stamp of the JS file on disk — lets the frontend detect a stale (cached) bundle."""
    js = Path(__file__).parent / "web" / "queue_workbench.js"
    m = re.search(r'const BUILD = "([^"]+)"', js.read_text())
    return web.json_response({"build": m.group(1) if m else None})


_wf_names_cache = {}   # workflows dir -> (signature, names)


@routes.get("/queue_workbench/workflow_names")
async def workflow_names(request):
    """Saved-workflow uuid -> [relative filenames] for the requesting user, so the panel can
    name queued runs that weren't stamped at queue time. Re-parsed only when files change."""
    try:
        user = server.user_manager.get_request_user_id(request)
    except KeyError:
        return web.json_response({"names": {}})
    root  = Path(folder_paths.get_user_directory()) / user / "workflows"
    files = sorted(f for f in root.rglob("*.json") if ".bak" not in f.name)
    sig   = [(str(f), f.stat().st_mtime) for f in files]
    cached = _wf_names_cache.get(root)
    if not cached or cached[0] != sig:
        names = {}
        for f in files:
            try:
                wf_id = json.loads(f.read_text()).get("id")
            except (ValueError, OSError, AttributeError):
                continue
            if wf_id:
                names.setdefault(wf_id, []).append(str(f.relative_to(root)))
        cached = _wf_names_cache[root] = (sig, names)
    return web.json_response({"names": cached[1]})


# ---------------------------------------------------------------------------
# Queue persistence — mirror unprocessed jobs to a local SQLite DB so they
# survive a backend shutdown/crash (see persistence.py).
# ---------------------------------------------------------------------------
try:
    from .persistence import setup_persistence
    setup_persistence(server)
except Exception:
    print(f"[QueueWorkbench] persistence setup error:\n{traceback.format_exc()}")

# ---------------------------------------------------------------------------
# Edit queued runs in place + in-place reorder (see queue_edit.py)
# ---------------------------------------------------------------------------
try:
    from .queue_edit import register_routes as register_edit_routes
    register_edit_routes(server)
except Exception:
    print(f"[QueueWorkbench] queue edit setup error:\n{traceback.format_exc()}")

# ---------------------------------------------------------------------------
# Retry a run once after CUDA out-of-memory (see oom_retry.py). Installed after
# persistence, so its task_done wrapper (mirror + history) runs inside this one.
# ---------------------------------------------------------------------------
if _config["oom_retry"]:
    try:
        oom_retry.install(server.prompt_queue)
    except Exception:
        print(f"[QueueWorkbench] out-of-memory retry setup error:\n{traceback.format_exc()}")
