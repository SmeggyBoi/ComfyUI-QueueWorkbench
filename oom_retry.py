"""
ComfyUI Queue Workbench — retry a run once after CUDA out-of-memory
------------------------------------------------------------------
ComfyUI unloads every model when a run fails with out-of-memory, so a second try
right away often succeeds. The failed run is queued again once, at the front,
under a new prompt_id that names the original (extra_data["qm_retry_of"]).
Never while the queue is paused, never a retry of a retry.
"""
import traceback
import uuid

from . import persistence

_OOM_TIP = "ran out of memory on your GPU"   # part of ComfyUI's OOM tip in exception_message


def _oom_error(data):
    return isinstance(data, dict) and (str(data.get("exception_type", "")).endswith("OutOfMemoryError")
                                       or _OOM_TIP in str(data.get("exception_message", "")))


def is_oom(messages):
    return any(event == "execution_error" and _oom_error(data) for event, data in messages or [])


def retry_blocker(item):
    """Why a failed run is not retried, or None if it may be."""
    if (item[3] or {}).get("qm_retry_of"):
        return "already a retry"
    if persistence.has_held():
        return "queue paused"
    workflow = ((item[3] or {}).get("extra_pnginfo") or {}).get("workflow") or {}
    if not (workflow.get("extra") or {}).get("qm_queued_at"):
        return "queued by a script"
    if any((node or {}).get("class_type") == "VHS_BatchManager" for node in (item[2] or {}).values()):
        return "part of a meta batch"
    return None


def should_retry(item, status):
    return (status is not None and status.status_str == "error" and is_oom(status.messages)
            and retry_blocker(item) is None)


def _requeue_front(prompt_queue, item):
    number, prompt_id, prompt, extra_data, outputs, *sensitive = item
    with prompt_queue.mutex:
        front = min((queued[0] for queued in prompt_queue.queue), default=number) - 1
    retry = (front, str(uuid.uuid4()), prompt, {**(extra_data or {}), "qm_retry_of": prompt_id}, outputs, *sensitive)
    prompt_queue.set_flag("free_memory", True)   # clear caches too before the next prompt
    prompt_queue.put(retry)
    print(f"[QueueWorkbench] out of memory: queued {prompt_id[:8]} again once as {retry[1][:8]}")


def install(prompt_queue):
    """Wrap task_done; install after persistence so its mirror + history wrapper runs inside."""
    inner = prompt_queue.task_done

    def task_done(item_id, history_result, status, process_item=None):
        running = prompt_queue.currently_running.get(item_id)   # the inner task_done pops it
        inner(item_id, history_result, status, process_item=process_item)
        try:
            if running is not None and should_retry(running, status):
                _requeue_front(prompt_queue, running)
        except Exception:
            print(f"[QueueWorkbench] out-of-memory retry error:\n{traceback.format_exc()}")

    prompt_queue.task_done = task_done


def failure_note(prompt_queue, data, enabled):
    """Suffix for the failure notification of the run an execution_error event belongs to."""
    if not enabled or not _oom_error(data):
        return ""
    item = next((it for it in list(prompt_queue.currently_running.values()) if it[1] == data.get("prompt_id")), None)
    if item is None:
        return ""
    return {None: " — retrying once",
            "queue paused": " — not retried (queue paused)",
            "already a retry": " — failed again after a retry",
            "queued by a script": " — not retried (queued by a script)",
            "part of a meta batch": " — not retried (meta batch)"}[retry_blocker(item)]
