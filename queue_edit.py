"""
ComfyUI Queue Workbench — edit queued runs in place
-------------------------------------------------
Swaps the graph of a pending run, or renumbers pending runs, under the
PromptQueue lock. Runs keep their prompt_id and position, so nothing in the
queue disappears and re-appears (which is what delete + re-submit did).

Queue items are (number, prompt_id, prompt, extra_data, outputs_to_execute,
sensitive); the heap is ordered by number, then prompt_id.
"""
import heapq

import execution
from aiohttp import web

from . import persistence

# Stamps the frontend adds at queue time; an edit must not overwrite them with
# the temporary edit tab's name.
_KEPT_STAMPS = ("qm_name", "qm_queued_at")


async def validate_items(items):
    """Validate every replacement first. Returns (validated, None) or (None, error_body)."""
    validated = []
    for it in items:
        valid, error, outputs, node_errors = await execution.validate_prompt(it["prompt_id"], it["prompt"], None)
        # valid is True as long as one output survives; failing outputs only show up in node_errors
        if not valid or node_errors:
            return None, {"prompt_id": it["prompt_id"], "error": error, "node_errors": node_errors}
        validated.append((it["prompt_id"], it["prompt"], it["workflow"], outputs))
    return validated, None


def replace_items(prompt_queue, validated):
    """Swap prompt/workflow/outputs of still-pending items in place.
    Returns (replaced_ids, not_pending_ids)."""
    replaced, not_pending = [], []
    with prompt_queue.mutex:
        index = {item[1]: i for i, item in enumerate(prompt_queue.queue)}
        for prompt_id, prompt, workflow, outputs in validated:
            i = index.get(prompt_id)
            if i is None:
                not_pending.append(prompt_id)
                continue
            item = list(prompt_queue.queue[i])
            extra_data = item[3] or {}
            pnginfo = extra_data.get("extra_pnginfo") or {}
            old_extra = (pnginfo.get("workflow") or {}).get("extra") or {}
            workflow = {**workflow, "extra": {**(workflow.get("extra") or {}),
                                              **{k: old_extra[k] for k in _KEPT_STAMPS if k in old_extra}}}
            item[2] = prompt
            item[3] = {**extra_data, "extra_pnginfo": {**pnginfo, "workflow": workflow}}
            item[4] = outputs
            prompt_queue.queue[i] = tuple(item)
            replaced.append(prompt_id)
    return replaced, not_pending


def reorder_items(prompt_queue, prompt_ids):
    """Give the pending items listed in prompt_ids their existing queue numbers in
    the requested order. Unknown IDs are ignored. Returns how many were placed."""
    with prompt_queue.mutex:
        index = {item[1]: i for i, item in enumerate(prompt_queue.queue)}
        picked = [index[p] for p in dict.fromkeys(prompt_ids) if p in index]
        numbers = sorted(prompt_queue.queue[i][0] for i in picked)
        for k in range(1, len(numbers)):   # tied numbers would let prompt_id decide the order
            if numbers[k] <= numbers[k - 1]:
                numbers[k] = numbers[k - 1] + 1e-6
        items = list(prompt_queue.queue)
        for i, number in zip(picked, numbers):
            items[i] = (number, *items[i][1:])
        prompt_queue.queue[:] = items
        heapq.heapify(prompt_queue.queue)
    return len(picked)


def register_routes(server):
    routes = server.routes

    @routes.post("/queue_workbench/replace")
    async def replace(request):
        """Body {"items": [{"prompt_id", "prompt", "workflow"}]}. All items are validated
        before any is swapped; items no longer pending are reported, not failed."""
        body = await request.json()
        validated, error = await validate_items(body.get("items", []))
        if error:
            return web.json_response(error, status=400)
        replaced, not_pending = replace_items(server.prompt_queue, validated)
        if replaced:
            persistence.resync_queue()
            server.queue_updated()
        return web.json_response({"replaced": replaced, "not_pending": not_pending})

    @routes.post("/queue_workbench/reorder")
    async def reorder(request):
        """Body {"prompt_ids": [...]}: the pending runs in their new order."""
        body = await request.json()
        moved = reorder_items(server.prompt_queue, body.get("prompt_ids", []))
        if moved:
            persistence.resync_queue()
            server.queue_updated()
        return web.json_response({"reordered": moved})

