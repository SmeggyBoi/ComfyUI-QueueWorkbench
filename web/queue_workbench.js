/**
 * ComfyUI Queue Workbench
 * - Pause / resume queue execution
 * - Drag-and-drop reorder of pending items
 * - Delete individual pending items
 * - Live polling of queue state
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const BUILD = "2026-10-03d";

// Stale-JS detection (PWA caches extension JS hard): compare this bundle's BUILD
// against the stamp the backend reads from web/queue_workbench.js ON DISK.
function qmCheckBuild() {
    fetch("/queue_workbench/build").then(r => (r.ok ? r.json() : null)).then(d => {
        if (!d || !d.build || d.build === BUILD) return;
        const b = document.createElement("div");
        b.id = "qm-stale";
        b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;background:#b3261e;" +
            "color:#fff;font:600 13px system-ui;padding:8px 12px;text-align:center;cursor:pointer";
        b.textContent = `⚠ Queue Workbench JS is stale — running ${BUILD}, disk has ${d.build}. ` +
            "Hard-reload / clear PWA site data. (tap to dismiss)";
        b.addEventListener("click", () => b.remove());
        document.body.appendChild(b);
    }).catch(() => {});
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let isPaused       = false;
let panelOpen      = false;
let pollTimer      = null;
let queueData      = { queue_running: [], queue_pending: [] };
let livePreviewUrl = null;   // current object URL for the latest preview frame
let isGenerating   = false;  // true while a job is actively running
let savedJobs      = [];     // backlog persisted from a previous session
let activeTab      = "queue"; // panel tab: "queue" | "history"

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function fetchQueue() {
    const res = await api.fetchApi("/queue");
    return await res.json();
}

async function deleteItem(promptId) {
    await api.fetchApi("/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: [promptId] }),
    });
}

async function interruptCurrent() {
    await api.fetchApi("/interrupt", { method: "POST" });
}

// ---------------------------------------------------------------------------
// Persistence API helpers — saved backlog from previous sessions
// ---------------------------------------------------------------------------
async function fetchSaved() {
    try {
        const res  = await api.fetchApi("/queue_workbench/saved");
        const data = await res.json();
        return data.jobs || [];
    } catch (e) {
        return [];
    }
}

async function restoreSaved(promptIds) {
    // promptIds omitted => restore all
    await api.fetchApi("/queue_workbench/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(promptIds ? { prompt_ids: promptIds } : {}),
    });
}

async function discardSaved(promptIds) {
    await api.fetchApi("/queue_workbench/saved/discard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(promptIds ? { prompt_ids: promptIds } : { all: true }),
    });
}

async function persistHeld(items) {
    // Mirror the paused/held items server-side so a pause+shutdown won't lose them
    try {
        await api.fetchApi("/queue_workbench/held", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items }),
        });
    } catch (e) { /* non-fatal */ }
}

async function clearHeld() {
    try {
        await api.fetchApi("/queue_workbench/held/clear", { method: "POST" });
    } catch (e) { /* non-fatal */ }
}

/**
 * Reorder pending items by deleting all of them and re-submitting
 * in the new order with ascending queue numbers.
 */
async function reorderQueue(newOrder) {
    // newOrder: array of full queue item tuples in desired order
    // Each item: [number, prompt_id, prompt, extra_data, outputs_to_execute]

    // Delete all pending
    const ids = newOrder.map(item => item[1]);
    if (ids.length === 0) return;
    await api.fetchApi("/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: ids }),
    });

    // Re-submit in new order with new ascending numbers
    // Use negative numbers so they go to the front of the built-in queue heap
    // ComfyUI uses a min-heap on the number field, so lower = higher priority
    const baseNumber = -9000;
    for (let i = 0; i < newOrder.length; i++) {
        await api.fetchApi("/prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(resubmitBody(newOrder[i], baseNumber + i)),
        });
    }
}

// Re-submits keep the run's prompt_id, so open edit tabs and other clients still
// recognise it after pause/resume
function resubmitBody(item, number) {
    const [, promptId, prompt, extra_data, outputs_to_execute] = item;
    return { prompt_id: promptId, prompt, extra_data: extra_data || {}, outputs_to_execute: outputs_to_execute || [], number };
}

// ---------------------------------------------------------------------------
// Pause / resume
// Pause works by snapshotting all pending items, deleting them from ComfyUI's
// queue (so it doesn't auto-start them), and holding them in memory.
// Resume re-submits them in the original order.
// The currently running item is always allowed to finish.
// ---------------------------------------------------------------------------
let heldItems = []; // pending items held while paused

async function setPaused(val) {
    isPaused = val;
    updatePauseButton();

    if (isPaused) {
        // Snapshot and delete all pending items
        const data    = await fetchQueue();
        const pending = (data.queue_pending || []).sort((a, b) => a[0] - b[0]);
        if (pending.length === 0) return;

        heldItems = pending;

        // Persist held items before deleting them from the native queue, so a
        // pause-then-shutdown still leaves them restorable next session.
        await persistHeld(pending);

        // Delete them all from ComfyUI so it won't auto-start them
        const ids = pending.map(item => item[1]);
        await api.fetchApi("/queue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ delete: ids }),
        });
        await refreshQueue();
    } else {
        // Resume — re-submit held items in original order
        if (heldItems.length === 0) { await clearHeld(); return; }
        await reorderQueue(heldItems);
        heldItems = [];
        await clearHeld(); // they're back in the native queue (and re-mirrored)
        await refreshQueue();
    }
}

// queuePrompt is passed through natively; setup() only stamps the tab's
// filename + queue time into a copy of the workflow extra (qm_name / qm_queued_at)

// ---------------------------------------------------------------------------
// Panel UI
// ---------------------------------------------------------------------------
const TAB        = "background:none;border:none;border-bottom:2px solid transparent;color:#888;padding:4px 10px 6px;cursor:pointer;font-size:12px;";
const TAB_ACTIVE = "color:#ddd;border-bottom-color:#7b5cfa;";

function createPanel() {
    const panel = document.createElement("div");
    panel.id    = "qm-panel";
    panel.style.cssText = `
        position: fixed;
        top: 60px;
        right: 16px;
        width: min(420px, calc(100vw - 32px));
        max-height: 70vh;
        background: #1a1a1a;
        border: 1px solid #444;
        border-radius: 8px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.6);
        z-index: 9999;
        display: flex;
        flex-direction: column;
        font-family: sans-serif;
        font-size: 13px;
        color: #ddd;
        overflow: hidden;
    `;

    // Position panel below the toolbar button dynamically
    function repositionPanel() {
        const btn = document.getElementById("qm-toolbar-btn");
        if (!btn) return;
        const rect = btn.getBoundingClientRect();
        panel.style.top  = (rect.bottom + 8) + "px";
        panel.style.right = (window.innerWidth - rect.right) + "px";
    }
    panel._reposition = repositionPanel;

    // Header
    const header = document.createElement("div");
    header.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: #252525;
        border-bottom: 1px solid #444;
        flex-shrink: 0;
    `;
    header.innerHTML = `<span style="font-weight:600;font-size:14px;">🗂️ Queue Workbench</span>`;

    // Pause button
    const pauseBtn = document.createElement("button");
    pauseBtn.id = "qm-pause-btn";
    pauseBtn.style.cssText = `
        padding: 4px 12px;
        border-radius: 5px;
        border: none;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        background: #e07b00;
        color: #fff;
    `;
    pauseBtn.textContent = "⏸ Pause";
    pauseBtn.onclick = () => setPaused(!isPaused).catch(console.error);
    header.appendChild(pauseBtn);

    // Close button
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = `
        background: none;
        border: none;
        color: #aaa;
        font-size: 16px;
        cursor: pointer;
        margin-left: 8px;
    `;
    closeBtn.onclick = togglePanel;
    header.appendChild(closeBtn);

    // Status bar
    const statusBar = document.createElement("div");
    statusBar.id = "qm-status";
    statusBar.style.cssText = `
        padding: 6px 14px;
        background: #1e1e1e;
        border-bottom: 1px solid #333;
        font-size: 11px;
        color: #888;
        flex-shrink: 0;
    `;
    statusBar.textContent = "Loading...";

    // Saved (previous session) section — hidden unless there is a backlog
    const savedSection = document.createElement("div");
    savedSection.id = "qm-saved-section";
    savedSection.style.cssText = `display:none; flex-shrink:0; border-bottom:1px solid #333; background:#1d1b12;`;

    const savedHeader = document.createElement("div");
    savedHeader.style.cssText = `display:flex; align-items:center; justify-content:space-between; gap:6px; padding:8px 14px 4px;`;
    savedHeader.innerHTML = `
        <span id="qm-saved-title" style="font-size:11px;color:#d9b54a;text-transform:uppercase;letter-spacing:0.05em;">💾 Saved</span>
        <span style="display:flex;gap:6px;flex-shrink:0;">
            <button id="qm-restore-all" style="background:#2a7a2a;border:none;color:#fff;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;">Restore all</button>
            <button id="qm-discard-all" style="background:#5a1a1a;border:none;color:#f88;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;">Discard</button>
        </span>`;

    const savedList = document.createElement("div");
    savedList.id = "qm-saved-list";
    savedList.style.cssText = `padding: 0 10px 8px; max-height: 26vh; overflow-y:auto;`;

    savedSection.appendChild(savedHeader);
    savedSection.appendChild(savedList);

    // Running section
    const runningLabel = document.createElement("div");
    runningLabel.style.cssText = `padding: 8px 14px 4px; font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; flex-shrink:0;`;
    runningLabel.textContent = "Currently Running";

    const runningEl = document.createElement("div");
    runningEl.id = "qm-running";
    runningEl.style.cssText = `padding: 0 10px 8px; flex-shrink:0;`;

    // Pending section
    const pendingLabel = document.createElement("div");
    pendingLabel.style.cssText = `padding: 8px 14px 4px; font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #333; flex-shrink:0;`;
    pendingLabel.textContent = "Pending (drag to reorder)";

    const pendingEl = document.createElement("div");
    pendingEl.id = "qm-pending";
    pendingEl.style.cssText = `overflow-y: auto; flex: 1; padding: 0 10px 10px;`;

    // Tabs: the live queue and the finished runs
    const tabs = document.createElement("div");
    tabs.id = "qm-tabs";
    tabs.style.cssText = `display:flex;gap:4px;padding:6px 10px 0;background:#1e1e1e;border-bottom:1px solid #333;flex-shrink:0;`;
    tabs.innerHTML = `<button data-tab="queue"></button><button data-tab="history"></button>`;
    tabs.addEventListener("click", (e) => {
        const tab = e.target.closest("button[data-tab]")?.dataset.tab;
        if (tab && tab !== activeTab) setTab(tab);
    });

    const queueView = document.createElement("div");
    queueView.id = "qm-queue-view";
    queueView.style.cssText = `display:flex;flex-direction:column;flex:1;min-height:0;`;
    queueView.append(savedSection, runningLabel, runningEl, pendingLabel, pendingEl);

    const historyView = document.createElement("div");
    historyView.id = "qm-history-view";
    historyView.style.cssText = `display:none;flex-direction:column;flex:1;min-height:0;overflow-y:auto;padding:4px 10px 10px;`;
    historyView.innerHTML = `
        <div id="qm-history"></div>
        <button id="qm-history-more" style="display:none;${BTN}width:100%;margin-top:6px;">Show more</button>`;
    historyView.querySelector("#qm-history-more").addEventListener("click", () =>
        loadMoreHistory().catch(e => console.warn("[QueueWorkbench] Failed to fetch history:", e)));

    panel.append(header, statusBar, tabs, queueView, historyView);
    document.body.appendChild(panel);
    updateTabs();

    // Saved-section bulk actions
    savedHeader.querySelector("#qm-restore-all").addEventListener("click", async () => {
        await restoreSaved();          // restore all
        await refreshSaved();
        await refreshQueue();
    });
    savedHeader.querySelector("#qm-discard-all").addEventListener("click", async () => {
        if (!confirm(`Discard ${savedJobs.length} saved job(s)? This cannot be undone.`)) return;
        await discardSaved();          // discard all
        await refreshSaved();
    });

    return panel;
}

function setTab(tab) {
    activeTab = tab;
    hideDetailCard();
    updateTabs();
    if (tab === "history") refreshHistory();
}

function updateTabs() {
    const queueView   = document.getElementById("qm-queue-view");
    const historyView = document.getElementById("qm-history-view");
    if (!queueView || !historyView) return;
    queueView.style.display   = activeTab === "queue" ? "flex" : "none";
    historyView.style.display = activeTab === "history" ? "flex" : "none";
    const count = (queueData.queue_running || []).length + (queueData.queue_pending || []).length;
    for (const btn of document.querySelectorAll("#qm-tabs button[data-tab]")) {
        btn.textContent   = btn.dataset.tab === "queue" ? `Queue (${count})` : "History";
        btn.style.cssText = TAB + (btn.dataset.tab === activeTab ? TAB_ACTIVE : "");
    }
}

// ---------------------------------------------------------------------------
// Saved (previous session) backlog rendering
// ---------------------------------------------------------------------------
async function refreshSaved() {
    savedJobs = await fetchSaved();
    renderSaved();
}

function renderSaved() {
    const section = document.getElementById("qm-saved-section");
    const list    = document.getElementById("qm-saved-list");
    const title   = document.getElementById("qm-saved-title");
    if (!section || !list) return;

    if (!savedJobs || savedJobs.length === 0) {
        section.style.display = "none";
        list.innerHTML = "";
        return;
    }

    section.style.display = "block";
    if (title) title.textContent = `💾 Saved from previous session (${savedJobs.length})`;

    list.innerHTML = "";
    const info = groupInfo(savedJobs);
    for (const item of savedJobs) {
        // item shape: [number, prompt_id, prompt, extra_data, outputs]
        const id       = item[1];
        const name     = workflowName(item);
        const { chips, thumbs } = info.get(id);

        const el = document.createElement("div");
        el.style.cssText = `
            background:#262217; border:1px solid #4a4020; border-radius:5px;
            border-left:3px solid ${stripeColor(groupKey(item))};
            padding:6px 10px; margin:3px 0; display:flex; flex-wrap:wrap; align-items:center;
            justify-content:space-between; min-height:52px;
        `;
        el.innerHTML = `
            <span style="display:flex;align-items:center;gap:6px;overflow:hidden;flex:1;min-width:0;">
                <span style="display:flex;gap:3px;flex-shrink:0;">${thumbsHtml(thumbs, 40, "#5a4a1a", "#3a3320")}</span>
                <span style="display:flex;flex-direction:column;gap:2px;overflow:hidden;min-width:0;">
                    <span style="font-size:11px;color:#776;white-space:nowrap;"><span class="qm-saved-load" style="color:#d9b54a;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;" title="Load this workflow onto canvas">${shortId(id)}</span> · ${queuedAt(item)}</span>
                    ${nameHtml(name)}
                </span>
            </span>
            <span style="display:flex;gap:4px;flex-shrink:0;">
                <button class="qm-saved-restore" title="Restore to queue" style="background:#2a7a2a;border:none;color:#fff;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;">⤴</button>
                <button class="qm-saved-discard" title="Discard" style="background:#5a1a1a;border:none;color:#f88;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;">✕</button>
            </span>
            ${chipsRowHtml(chips)}`;

        el.querySelector(".qm-saved-load").addEventListener("click", async (e) => {
            e.stopPropagation();
            await loadWorkflowFromItem(item);
        });
        el.querySelector(".qm-saved-restore").addEventListener("click", async (e) => {
            e.stopPropagation();
            await restoreSaved([id]);
            await refreshSaved();
            await refreshQueue();
        });
        el.querySelector(".qm-saved-discard").addEventListener("click", async (e) => {
            e.stopPropagation();
            await discardSaved([id]);
            await refreshSaved();
        });
        attachDetail(el, item, info.get(id), renderSaved, "Saved");

        list.appendChild(el);
    }
}

function updatePauseButton() {
    const btn = document.getElementById("qm-pause-btn");
    if (!btn) return;
    if (isPaused) {
        btn.textContent   = "▶ Resume";
        btn.style.background = "#2a7a2a";
    } else {
        btn.textContent   = "⏸ Pause";
        btn.style.background = "#e07b00";
    }
}

function shortId(id) {
    return id ? id.slice(0, 8) + "…" : "?";
}

// ---------------------------------------------------------------------------
// Load a queued workflow onto the canvas
// item[3] = extra_data which contains extra_pnginfo.workflow (full format)
// Falls back to a best-effort load of the API format prompt if not present
// ---------------------------------------------------------------------------
async function loadWorkflowFromItem(item) {
    const extra_data = item[3];
    const workflow   = extra_data?.extra_pnginfo?.workflow;

    if (workflow) {
        // Full workflow format — load directly
        await app.loadGraphData(workflow);
    } else {
        // API format only — no position data, but still loadable as a
        // best-effort using the app's built-in API format import if available
        const prompt = item[2];
        if (app.loadApiJson) {
            await app.loadApiJson(prompt);
        } else {
            // Last resort: show a notification and do nothing
            alert("This queue item does not contain full workflow data and cannot be loaded onto the canvas.");
        }
    }
}

// ---------------------------------------------------------------------------
// Thumbnail extraction — any node input that names an image/video file
// Returns array of {url, label, video} objects, one per distinct file
// ---------------------------------------------------------------------------
const MEDIA_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?|mp4|webm|mov|mkv|avi)$/i;
const VIDEO_RE = /\.(mp4|webm|mov|mkv|avi)$/i;

const viewUrl  = (filename, type, subfolder) =>
    `/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}`;

// "sub/file.png [output]" -> { subfolder: "sub", filename: "file.png", type: "output" }
function mediaRef(value) {
    if (typeof value !== "string") return null;
    const [, path, type] = value.match(/^([\s\S]*?)(?: \[(input|output|temp)\])?$/);
    if (!MEDIA_RE.test(path)) return null;
    const slash = path.lastIndexOf("/");
    return { subfolder: slash >= 0 ? path.slice(0, slash) : "", filename: path.slice(slash + 1), type };
}

function extractThumbnails(prompt) {
    const results = [];
    const seen    = new Set();
    for (const node of Object.values(prompt || {})) {
        for (const value of Object.values(node?.inputs || {})) {
            const ref = mediaRef(value);
            if (!ref || seen.has(value)) continue;
            seen.add(value);
            const type = ref.type || (node.class_type === "FramePickerNode" ? "output" : "input");
            results.push({
                url:   viewUrl(ref.filename, type, ref.subfolder),
                label: ref.filename,
                video: VIDEO_RE.test(ref.filename),
            });
        }
    }
    return results;
}

const MAX_THUMBS = 2; // max row thumbnails before the +N overflow indicator (detail shows all)

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

function thumbHtml(t, size, border) {
    // Images shared by every run of the workflow fade; the ones that tell runs apart stay bright
    const style = `width:${size}px;height:${size}px;object-fit:cover;border-radius:4px;flex-shrink:0;border:1px solid ${border};${t.shared ? "opacity:0.45;" : ""}`;
    return t.video
        ? `<video src="${t.url}#t=0.1" title="${esc(t.label)}" muted preload="metadata" style="${style}" onerror="this.style.display='none'"></video>`
        : `<img src="${t.url}" title="${esc(t.label)}" style="${style}" onerror="this.style.display='none'">`;
}

function thumbsHtml(thumbs, size, border, bg) {
    const visible  = thumbs.slice(0, MAX_THUMBS);
    const overflow = thumbs.length - visible.length;
    if (visible.length === 0) {
        return `<div style="width:${size}px;height:${size}px;border-radius:4px;background:${bg};flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#555;font-size:18px;">?</div>`;
    }
    return visible.map(t => thumbHtml(t, size, border)).join("")
        + (overflow > 0 ? `<div style="width:${size - 12}px;height:${size}px;border-radius:4px;background:${bg};flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:11px;font-weight:600;">+${overflow}</div>` : "");
}

// ---------------------------------------------------------------------------
// Telling items apart — workflow name, queue time, colour stripe, chips for
// the widget values that differ between items of the same workflow, and a
// detail card (hover beside the panel on mouse devices, tap-to-expand on touch)
// ---------------------------------------------------------------------------
let workflowNames = {};   // saved-workflow uuid -> [relative filenames], from the backend
let expandedId    = null; // prompt_id whose detail is expanded inline (touch devices)
const HOVER       = window.matchMedia("(hover: hover)").matches;

async function refreshWorkflowNames() {
    try {
        const res = await api.fetchApi("/queue_workbench/workflow_names");
        if (res.ok) workflowNames = (await res.json()).names || {};
    } catch (e) { /* non-fatal — items stay unnamed */ }
}

function workflowName(item) {
    const wf = item[3]?.extra_pnginfo?.workflow;
    if (wf?.extra?.qm_name) return wf.extra.qm_name.replace(/\.json$/, "");
    // Save As keeps the uuid, so only trust an unambiguous match
    const files = workflowNames[wf?.id];
    return files?.length === 1 ? files[0].split("/").pop().replace(/\.json$/, "") : null;
}

function groupKey(item) {
    return workflowName(item) || item[3]?.extra_pnginfo?.workflow?.id || null;
}

function stripeColor(key) {
    if (!key) return "#555";
    let h = 0;
    for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360} 55% 55%)`;
}

// "14:32" today, "02.10 14:32" on other days
function fmtTime(t) {
    const d    = new Date(t);
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString()
        ? time
        : `${d.toLocaleDateString([], { day: "2-digit", month: "2-digit" })} ${time}`;
}

// qm_queued_at survives reorder/pause (which re-POST and reset create_time)
function queuedAt(item) {
    const t = item[3]?.extra_pnginfo?.workflow?.extra?.qm_queued_at ?? item[3]?.create_time;
    return t ? fmtTime(t) : "";
}

// Prompt-like text: several words, not a model filename, not serialized JSON (e.g. crop boxes)
const isJson   = v => typeof v === "string" && /^\s*[\[{]/.test(v);
const isPrompt = v => typeof v === "string" && v.length > 30 && (v.match(/\s/g) || []).length >= 3
    && !isJson(v) && !/\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i.test(v);

// Setting chips. Bright = differs between runs of the same workflow, dimmed = shared by all.
const CATEGORIES = {
    sampling: { label: "Sampling", color: "#6cc68a" },
    time:     { label: "Time",     color: "#e3ad54" },
    lora:     { label: "LoRA",     color: "#a78bfa" },
    size:     { label: "Size",     color: "#60a5e8" },
    other:    { label: "Other",    color: "#b4b4b4" },
};
const CATEGORY_ORDER = Object.keys(CATEGORIES);
const MAX_CHIPS      = 12;

// [input name or primitive title, category, label, unit, accept(value)]
const SETTINGS = [
    [/^steps$/,                                               "sampling", "Steps"],
    [/^(cfg|cfg_scale|guidance)$/,                            "sampling", "CFG"],
    [/^(sampler|sampler_name)$/,                              "sampling", "Sampler"],
    [/^scheduler$/,                                           "sampling", "Scheduler"],
    [/^denoise$/,                                             "sampling", "Denoise"],
    [/^(duration|seconds)$/,                                  "time",     "Duration", "s"],
    [/^(frames|num_frames|frame_count|length|video_length)$/, "time",     "Frames", "", v => v > 1],  // length 1 = single-frame slice
    [/^(fps|frame_rate)$/,                                    "time",     "FPS"],
    [/^(aspect|aspect_ratio)$/,                               "size",     ""],
    [/^(megapixels?|mp)$/,                                    "size",     "", " MP"],
];

const fmtNumber   = v => String(+v.toFixed(2));
const fmtStrength = v => { const s = fmtNumber(v); return s.includes(".") ? s : `${s}.0`; };
const loraName    = v => String(v).split("/").pop().replace(/\.safetensors$/, "");

// [{ cat, text }] for one run. Key categories always; the "other" ones are
// filtered to the differing ones later. Links, seeds, media and prompt text are left out.
function settingChips(prompt) {
    const chips = [];
    const add = (cat, text) => { if (!chips.some(c => c.cat === cat && c.text === text)) chips.push({ cat, text }); };
    for (const node of Object.values(prompt || {})) {
        const inputs  = node?.inputs || {};
        const isLora  = typeof inputs.lora_name === "string";   // LoraLoader / LoraLoaderModelOnly
        const hasSize = typeof inputs.width === "number" && typeof inputs.height === "number";
        if (isLora)  add("lora", `${loraName(inputs.lora_name)} · ${fmtStrength(inputs.strength_model ?? inputs.strength ?? 1)}`);
        if (hasSize) add("size", `${inputs.width}×${inputs.height}`);
        for (const [key, value] of Object.entries(inputs)) {
            if (value && typeof value === "object" && !Array.isArray(value)) {
                // rgthree Power Lora Loader slot — only active ones
                if (value.on && "lora" in value) add("lora", `${loraName(value.lora)} · ${fmtStrength(value.strength)}`);
                continue;
            }
            if (Array.isArray(value) || /seed/i.test(key) || mediaRef(value) || isPrompt(value) || isJson(value)) continue;
            if ((isLora && /^(lora_name|strength)/.test(key)) || (hasSize && /^(width|height)$/.test(key))) continue;
            // Primitive nodes carry their meaning in the title: "Float (duration, seconds)" -> "duration"
            const name  = key === "value" ? (node._meta?.title || node.class_type).replace(/^\w+\s*\(([^,)]*).*\)$/, "$1") : key;
            const shown = typeof value === "number" ? fmtNumber(value) : typeof value === "boolean" ? (value ? "on" : "off") : String(value);
            const rule  = SETTINGS.find(([re]) => re.test(name.toLowerCase()));
            if (!rule) {
                add("other", `${name.charAt(0).toUpperCase()}${name.slice(1).replace(/_/g, " ")} ${shown}`);
                continue;
            }
            const [, cat, label, unit = "", accept] = rule;
            if (accept && !accept(value)) continue;
            // "9:16 (Portrait Widescreen)" -> "9:16"
            const v = cat === "size" && typeof value === "string" ? (value.match(/\d+(?:\.\d+)?:\d+(?:\.\d+)?/)?.[0] ?? value) : shown;
            add(cat, `${label ? label + " " : ""}${v}${unit}`);
        }
    }
    return chips;
}

// Long text inputs (prompts), labelled with their node title
function promptTexts(prompt) {
    return Object.entries(prompt || {}).flatMap(([nodeId, node]) =>
        Object.entries(node?.inputs || {}).filter(([, v]) => isPrompt(v) && !mediaRef(v))
            .map(([key, text]) => ({ key: `${nodeId}.${key}`, label: node._meta?.title || node.class_type, text })));
}

function commonPrefixLength(strings) {
    if (strings.length === 0) return 0;
    let n = 0;
    while (n < strings[0].length && strings.every(s => s[n] === strings[0][n])) n++;
    return n;
}

const wordStart = (s, n) => n === 0 ? 0 : Math.max(s.lastIndexOf(" ", n), s.lastIndexOf("\n", n)) + 1;

// prompt_id -> { chips, thumbs, texts }, compared within each workflow group:
// chip.diff / !thumb.shared mark what tells a run apart from its siblings,
// text.divergeAt is where its prompt starts to differ from theirs (0 = no difference).
function groupInfo(items) {
    const groups = new Map();
    for (const item of items) {
        const key = groupKey(item) ?? item[1];   // unnamed API prompts stay on their own
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    const info = new Map();
    for (const group of groups.values()) {
        const multi  = group.length > 1;
        const thumbs = group.map(item => extractThumbnails(item[2]));
        const chips  = group.map(item => settingChips(item[2]));
        const texts  = group.map(item => promptTexts(item[2]));
        group.forEach((item, i) => info.set(item[1], {
            thumbs: thumbs[i].map(t => ({ ...t, shared: multi && thumbs.every(ts => ts.some(o => o.url === t.url)) }))
                .sort((a, b) => a.shared - b.shared),
            chips: chips[i].map(c => ({ ...c, diff: multi && !chips.every(cs => cs.some(o => o.cat === c.cat && o.text === c.text)) }))
                .filter(c => c.cat !== "other" || c.diff)
                .sort((a, b) => CATEGORY_ORDER.indexOf(a.cat) - CATEGORY_ORDER.indexOf(b.cat)),
            texts: texts[i].map(t => {
                const variants = texts.map(ts => ts.find(o => o.key === t.key)?.text ?? "");
                return { ...t, divergeAt: new Set(variants).size > 1 ? wordStart(t.text, commonPrefixLength(variants)) : 0 };
            }),
        }));
    }
    return info;
}

function nameHtml(name) {
    return name ? `<span title="${esc(name)}" style="color:#ddd;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}</span>` : "";
}

function chipHtml(c, maxWidth = 150, fontSize = 10) {
    const color = CATEGORIES[c.cat].color;
    const look  = c.diff
        ? `background:${color}33;color:${color};border:1px solid ${color}99;`
        : `background:${color}14;color:${color}b3;border:1px solid transparent;`;
    return `<span title="${esc(c.text)}" style="${look}border-radius:3px;padding:0 5px;font-size:${fontSize}px;line-height:${fontSize + 5}px;white-space:nowrap;max-width:${maxWidth}px;overflow:hidden;text-overflow:ellipsis;">${esc(c.text)}</span>`;
}

function chipsRowHtml(chips) {
    if (!chips?.length) return "";
    const shown = chips.slice(0, MAX_CHIPS);
    return `<div style="width:100%;display:flex;flex-wrap:wrap;gap:3px;margin-top:5px;">${shown.map(c => chipHtml(c)).join("")}${chips.length > shown.length ? chipHtml({ cat: "other", text: `+${chips.length - shown.length}` }) : ""}</div>`;
}

// ---------------------------------------------------------------------------
// Finished runs (History tab) — status, timing and outputs read from a ComfyUI
// history entry, the row built from them, and the body to queue a run again.
// A run is { id, item, outputs, status }; item has the queue-item shape.
// ---------------------------------------------------------------------------
const OUTPUT_BORDER = "#7b5cfa";
const STATUS_MARKS  = {
    success:     { mark: "✓", color: "#6f6", label: "Finished" },
    error:       { mark: "✕", color: "#f66", label: "Failed" },
    interrupted: { mark: "⏹", color: "#999", label: "Interrupted" },
};

// ComfyUI reports an interrupt as status_str "error" with an execution_interrupted message
function runResult(status) {
    const messages = status?.messages || [];
    const find     = type => messages.find(([t]) => t === type)?.[1];
    const end      = find("execution_success") || find("execution_error") || find("execution_interrupted");
    const error    = find("execution_error");
    return {
        state:      !status ? null : status.status_str === "success" ? "success" : find("execution_interrupted") ? "interrupted" : "error",
        startedAt:  find("execution_start")?.timestamp ?? null,
        finishedAt: end?.timestamp ?? null,
        error:      error ? { node: error.node_type, message: error.exception_message } : null,
    };
}

function fmtDuration(ms) {
    const s   = Math.round(ms / 1000);
    const pad = n => String(n).padStart(2, "0");
    if (s < 60)   return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
    return `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m`;
}

// Mark, label and "14:32 · 3m 12s" of a finished run
function finishedInfo(run) {
    const result = runResult(run.status);
    const look   = STATUS_MARKS[result.state] || { mark: "", color: "#888", label: "Finished" };
    const { startedAt, finishedAt } = result;
    const text   = [finishedAt && fmtTime(finishedAt), startedAt && finishedAt && fmtDuration(finishedAt - startedAt)]
        .filter(Boolean).join(" · ");
    return { ...result, ...look, text };
}

// Every output file of a run (any output list of {filename, subfolder, type}); saved
// outputs before temp previews such as image-compare halves
function outputMedia(outputs) {
    const seen = new Set();
    return Object.values(outputs || {}).flatMap(node => Object.values(node || {}))
        .filter(Array.isArray).flat()
        .filter(f => typeof f?.filename === "string" && MEDIA_RE.test(f.filename))
        .map(f => ({ ...f, type: f.type || "output" }))
        .sort((a, b) => (a.type !== "output") - (b.type !== "output"))
        .map(f => ({ url: viewUrl(f.filename, f.type, f.subfolder || ""), label: f.filename, video: VIDEO_RE.test(f.filename) }))
        .filter(m => !seen.has(m.url) && seen.add(m.url));
}

// A finished run queued again as a new run: same graph and seed. The server picks the
// prompt_id, the queue time is stamped fresh and the live preview goes to clientId.
function requeueBody(item, clientId) {
    const { client_id, create_time, ...extra } = structuredClone(item[3] || {});
    const workflow = extra.extra_pnginfo?.workflow;
    if (workflow) workflow.extra = { ...workflow.extra, qm_queued_at: Date.now() };
    return { prompt: item[2], extra_data: extra, client_id: clientId, partial_execution_targets: item[4] };
}

// New runs (newest first) go on top; a prompt_id that finished again keeps only its newest run
function mergeNewRuns(runs, incoming) {
    const ids = new Set(incoming.map(r => r.item[1]));
    return [...incoming, ...runs.filter(r => !ids.has(r.item[1]))];
}

function historyRowHtml(run, info) {
    const f   = finishedInfo(run);
    const out = outputMedia(run.outputs)[0];
    return `
        <span style="display:flex;align-items:center;gap:6px;overflow:hidden;flex:1;min-width:0;">
            <span style="display:flex;gap:3px;flex-shrink:0;">${out ? thumbHtml(out, 44, OUTPUT_BORDER) : ""}${out && !info.thumbs.length ? "" : thumbsHtml(info.thumbs, 44, "#444", "#333")}</span>
            <span style="display:flex;flex-direction:column;gap:2px;overflow:hidden;min-width:0;">
                <span style="color:#aaa;font-size:12px;white-space:nowrap;"><span style="color:${f.color};">${f.mark}</span> ${esc(f.text)} <span style="color:#666;font-size:11px;">· <span class="qm-load-workflow" style="color:#7b9cfa;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;" title="Load this workflow onto canvas">${shortId(run.item[1])}</span></span></span>
                ${nameHtml(workflowName(run.item))}
            </span>
        </span>
        <span style="display:flex;gap:4px;flex-shrink:0;">
            <button class="qm-requeue-btn" title="Queue this run again (same seed)" style="background:#2a7a2a;border:none;color:#fff;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;">⤴</button>
            <button class="qm-history-delete" title="Remove from history" style="background:#5a1a1a;border:none;color:#f88;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;">✕</button>
        </span>
        ${chipsRowHtml(info.chips)}`;
}

// where: "#3 of 22" / "Running" / "Saved" / "✓ Finished 14:32 · 3m 12s"; run (History tab)
// adds the run's outputs and error
function detailHtml(item, info, where, run = null) {
    const prompt  = item[2] || {};
    const outputs = run ? outputMedia(run.outputs) : [];
    const error   = run ? runResult(run.status).error : null;
    const gallery = (label, thumbs, border) => thumbs.length ? `
        ${label ? `<div style="margin-top:12px;font-size:11px;color:#8a8a8a;">${label}</div>` : ""}
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:${label ? 4 : 12}px;">${thumbs.map(t => thumbHtml(t, 112, border)).join("")}</div>` : "";
    // Unique non-zero seeds (nodes with per-clip seed slots often leave unused ones at 0)
    const seeds  = [...new Set(Object.values(prompt).flatMap(n => Object.entries(n?.inputs || {}))
        .filter(([k, v]) => /seed/i.test(k) && typeof v === "number" && v !== 0).map(([, v]) => v))];
    const row = (label, color, body) => `
        <div style="display:grid;grid-template-columns:64px 1fr;gap:8px;align-items:baseline;margin-top:6px;">
            <span style="color:${color};font-size:11px;">${label}</span>
            <div style="display:flex;flex-wrap:wrap;gap:4px;min-width:0;">${body}</div>
        </div>`;
    const settings = CATEGORY_ORDER
        .map(cat => [cat, info.chips.filter(c => c.cat === cat)])
        .filter(([, cs]) => cs.length)
        .map(([cat, cs]) => row(CATEGORIES[cat].label, CATEGORIES[cat].color, cs.map(c => chipHtml(c, 420, 11)).join("")));
    if (seeds.length) {
        settings.push(row("Seeds", "#8a8a8a", seeds.map(s => `<span style="font-family:monospace;font-size:11px;color:#cfcfcf;">${s}</span>`).join("")));
    }
    // Prompt boxes: the part shared with the sibling runs is greyed, the differing rest stays bright
    const texts = info.texts.map(t => `
        <div title="${esc(t.label)}" style="margin-top:12px;font-size:11px;color:#8a8a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(t.label)}</div>
        <div class="qm-prompt" style="position:relative;margin-top:4px;max-height:220px;overflow-y:auto;background:#141414;border:1px solid #333;border-radius:4px;padding:8px 10px;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.5;user-select:text;cursor:text;color:${t.divergeAt ? "#777" : "#cfcfcf"};">${t.divergeAt
            ? `${esc(t.text.slice(0, t.divergeAt))}<span class="qm-div" style="color:#ececec;">${esc(t.text.slice(t.divergeAt))}</span>`
            : esc(t.text)}</div>`);
    return `
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;">
            <span style="font-size:14px;font-weight:600;color:#e6e6e6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(workflowName(item) || "Unnamed workflow")}</span>
            <span style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
                <span style="font-size:12px;color:#9a9a9a;">${esc(where)}</span>
                ${where.startsWith("#") && !where.startsWith("#1 ") ? `<button class="qm-detail-top" style="${BTN}padding:2px 10px;">⤒ Move to top</button>` : ""}
                ${canEdit && where.startsWith("#") ? `<button class="qm-detail-edit" style="${BTN}padding:2px 10px;">✎ Edit</button>` : ""}
            </span>
        </div>
        <div style="margin-top:2px;font-size:11px;color:#777;">Queued ${esc(queuedAt(item))}<span style="margin-left:10px;font-family:monospace;">${esc(item[1])}</span></div>
        ${error ? `<div style="margin-top:8px;max-height:120px;overflow-y:auto;color:#f88;font-size:12px;white-space:pre-wrap;word-break:break-word;user-select:text;">${esc([error.node, error.message].filter(Boolean).join(": "))}</div>` : ""}
        ${gallery("Outputs", outputs, OUTPUT_BORDER)}
        ${gallery(outputs.length ? "Inputs" : "", info.thumbs, "#3a3a3a")}
        ${settings.length ? `<div style="margin-top:8px;">${settings.join("")}</div>` : ""}
        ${texts.join("")}`;
}

// Scroll each prompt box so the start of the differing part is in view
function revealDivergence(container) {
    for (const span of container.querySelectorAll(".qm-div")) {
        span.parentElement.scrollTop = Math.max(0, span.offsetTop - 40);
    }
}

let cardHideTimer = null;
let cardItemId    = null; // prompt_id shown in the hover card

function detailCard() {
    let card = document.getElementById("qm-detail");
    if (!card) {
        card = document.createElement("div");
        card.id = "qm-detail";
        card.style.cssText = `display:none;position:fixed;box-sizing:border-box;overflow-y:auto;background:#1e1e1e;border:1px solid #444;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.65);z-index:10000;padding:14px;font:12px sans-serif;color:#bbb;`;
        // Moving from the row into the card keeps it open, so the prompt can be scrolled / selected
        card.addEventListener("mouseenter", () => clearTimeout(cardHideTimer));
        card.addEventListener("mouseleave", scheduleHideCard);
        document.body.appendChild(card);
    }
    return card;
}

// Buttons inside a detail card (hover card or inline on touch)
function wireDetailButtons(container, item) {
    container.querySelector(".qm-detail-edit")?.addEventListener("click", e => { e.stopPropagation(); editQueuedRun(item).catch(console.error); });
    container.querySelector(".qm-detail-top")?.addEventListener("click", e => {
        e.stopPropagation();
        hideDetailCard();
        expandedId = null;
        moveRun(item[1], "top").catch(console.error);
    });
}

function showDetailCard(row, item, info, where, run = null) {
    clearTimeout(cardHideTimer);
    const card      = detailCard();
    const wasHidden = card.style.display === "none";
    card.innerHTML  = detailHtml(item, info, where, run);
    wireDetailButtons(card, item);
    cardItemId      = item[1];
    // Left of the panel; rows in the lower half anchor the card's bottom so it grows upward
    const panelRect = document.getElementById("qm-panel").getBoundingClientRect();
    const rowRect   = row.getBoundingClientRect();
    const lower     = rowRect.top > window.innerHeight / 2;
    card.style.width     = Math.min(500, panelRect.left - 16) + "px";
    card.style.right     = (window.innerWidth - panelRect.left + 8) + "px";
    card.style.top       = lower ? "auto" : rowRect.top + "px";
    card.style.bottom    = lower ? (window.innerHeight - rowRect.bottom) + "px" : "auto";
    card.style.maxHeight = (lower ? rowRect.bottom : window.innerHeight - rowRect.top) - 8 + "px";
    card.style.display   = "block";
    revealDivergence(card);
    if (wasHidden && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100 });
    }
}

function scheduleHideCard() {
    clearTimeout(cardHideTimer);
    cardHideTimer = setTimeout(hideDetailCard, 250);
}

function hideDetailCard() {
    clearTimeout(cardHideTimer);
    cardItemId = null;
    const card = document.getElementById("qm-detail");
    if (card) card.style.display = "none";
}

function attachDetail(el, item, info, rerender, where, run = null) {
    if (HOVER) {
        el.addEventListener("mouseenter", () => showDetailCard(el, item, info, where, run));
        el.addEventListener("mouseleave", scheduleHideCard);
        return;
    }
    el.addEventListener("click", () => {
        expandedId = expandedId === item[1] ? null : item[1];
        rerender();
    });
    if (expandedId === item[1]) {
        const detail = document.createElement("div");
        detail.style.cssText = "width:100%;margin-top:8px;padding-top:10px;border-top:1px solid #3a3a3a;font-size:12px;color:#bbb;cursor:auto;user-select:text;";
        detail.innerHTML = detailHtml(item, info, where, run);
        wireDetailButtons(detail, item);
        // Scrolling / selecting the prompt shouldn't collapse the row
        detail.addEventListener("click", e => e.stopPropagation());
        el.appendChild(detail);
        requestAnimationFrame(() => revealDivergence(detail));
    }
}

// ---------------------------------------------------------------------------
// Edit queued runs in place — change detection. An edit is compared with the
// run it came from; its value changes can then be copied into sibling runs
// that still hold the old values.
// ---------------------------------------------------------------------------
const same   = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isLink = v => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && Number.isInteger(v[1]);

// API-prompt value changes: { changes: [{ nodeId, input, old, new }], structural }.
// structural = nodes, class types or links differ (such edits aren't copied to other runs).
function diffPrompts(before, after) {
    const changes  = [];
    let structural = !same(Object.keys(before).sort(), Object.keys(after).sort());
    for (const [nodeId, node] of Object.entries(after)) {
        const prev = before[nodeId];
        if (!prev || prev.class_type !== node.class_type) { structural = true; continue; }
        const inputs = new Set([...Object.keys(prev.inputs || {}), ...Object.keys(node.inputs || {})]);
        for (const input of inputs) {
            const a = prev.inputs?.[input], b = node.inputs?.[input];
            if (same(a, b)) continue;
            if (a === undefined || b === undefined || isLink(a) || isLink(b)) { structural = true; continue; }
            changes.push({ nodeId, input, old: a, new: b });
        }
    }
    return { changes, structural };
}

// GUI nodes by "<graph>:<id>" — the root graph and every subgraph definition
function workflowNodes(workflow) {
    const nodes = new Map();
    for (const n of workflow?.nodes || []) nodes.set(`root:${n.id}`, n);
    for (const sg of workflow?.definitions?.subgraphs || []) {
        for (const n of sg.nodes || []) nodes.set(`${sg.id}:${n.id}`, n);
    }
    return nodes;
}

// widgets_values changes (array index or object key): [{ key, index, old, new }]
function diffWidgets(before, after) {
    const prev    = workflowNodes(before);
    const changes = [];
    for (const [key, node] of workflowNodes(after)) {
        const old = prev.get(key)?.widgets_values, now = node.widgets_values;
        if (!old || !now || typeof old !== "object" || Array.isArray(old) !== Array.isArray(now)) continue;
        for (const [index, value] of Object.entries(now)) {
            if (index in old && !same(old[index], value)) changes.push({ key, index, old: old[index], new: value });
        }
    }
    return changes;
}

// Copy each change into a sibling run where it still has the old value
// (force: apply regardless — used for the edited run itself).
// Returns { prompt, workflow, applied } or null when nothing applies.
function patchRun(item, changes, widgetChanges, force = false) {
    const prompt   = structuredClone(item[2] || {});
    const workflow = structuredClone(item[3]?.extra_pnginfo?.workflow || {});
    const applied  = changes.filter(c => {
        const inputs = prompt[c.nodeId]?.inputs;
        if (!inputs || !(c.input in inputs) || !(force || same(inputs[c.input], c.old))) return false;
        inputs[c.input] = structuredClone(c.new);
        return true;
    });
    if (applied.length === 0) return null;
    const nodes = workflowNodes(workflow);
    for (const c of widgetChanges) {
        const values = nodes.get(c.key)?.widgets_values;
        if (values && c.index in values && (force || same(values[c.index], c.old))) values[c.index] = structuredClone(c.new);
    }
    return { prompt, workflow, applied };
}

// What the edited run itself is replaced with. Value-only edits land on its queued graph, so
// everything the user didn't touch stays exactly as queued; structural edits, or changes the
// queued graph has no place for, need the editor's full graph.
function editedRunPayload(item, output, workflow, changes, widgetChanges, structural) {
    const patched = structural ? null : patchRun(item, changes, widgetChanges, true);
    return patched && patched.applied.length === changes.length ? patched : { prompt: output, workflow };
}

// "Steps", "PROMPTS", "KSampler › cfg" or a LoRA name
function changeName(c, prompt) {
    if (c.new && typeof c.new === "object" && "lora" in c.new) return loraName(c.new.lora);
    const node  = prompt[c.nodeId] || {};
    const title = node._meta?.title || node.class_type || c.nodeId;
    // Primitives and prompt text are named by their node title alone
    return c.input === "value" || (typeof c.new === "string" && c.new.length > 30) ? title : `${title} › ${c.input}`;
}

function changeLabel(c, prompt) {
    const name = changeName(c, prompt);
    if (c.new && typeof c.new === "object" && "lora" in c.new) {
        const state = v => v?.on ? fmtStrength(v.strength) : "off";
        return `${name}: ${state(c.old)} → ${state(c.new)}`;
    }
    if (typeof c.new === "string" && c.new.length > 30) return `${name} (text)`;
    const fmt = v => typeof v === "number" ? fmtNumber(v) : typeof v === "string" ? v : JSON.stringify(v);
    return `${name}: ${fmt(c.old)} → ${fmt(c.new)}`;
}

// ---------------------------------------------------------------------------
// Edit queued runs in place — a run opens in its own tab; "Update queued run"
// writes the edited graph back into the same queue entry via the backend.
// ---------------------------------------------------------------------------
let canEdit        = false;       // backend has /queue_workbench/replace (needs a ComfyUI restart after install)
const editSessions = new Map();   // prompt_id -> { promptId, item, path, name, baseline }
let editBusy       = false;
let lastBarRefresh = 0;

const BTN         = "background:#333;border:1px solid #444;color:#ddd;border-radius:5px;padding:5px 12px;cursor:pointer;font-size:12px;";
const BTN_PRIMARY = "background:#7b5cfa;border:1px solid #7b5cfa;color:#fff;border-radius:5px;padding:5px 12px;cursor:pointer;font-size:12px;font-weight:600;";

const workflowStore  = () => app.extensionManager?.workflow;
const editSessionFor = wf => wf ? [...editSessions.values()].find(s => s.path === wf.path) : undefined;

function toast(severity, summary, detail) {
    app.extensionManager?.toast?.add({ severity, summary, detail, life: severity === "error" ? 8000 : 4000 });
}

async function probeEditSupport() {
    try {
        const res = await api.fetchApi("/queue_workbench/replace", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [] }),
        });
        canEdit = res.ok;
    } catch (e) {
        canEdit = false;
    }
}

function pendingSorted() {
    return [...(queueData.queue_pending || [])].sort((a, b) => a[0] - b[0]);
}

function queuePosition(promptId) {
    const i = pendingSorted().findIndex(it => it[1] === promptId);
    return i >= 0 ? `#${i + 1}` : null;
}

// Unique per run: positions shift and sibling runs share the workflow name, and the frontend
// reuses an open tab whose name and workflow match
function editTabName(item, where) {
    return `✎ ${where ?? ""} ${workflowName(item) || "queued run"} (${item[1].slice(0, 8)})`.replace(/\s+/g, " ");
}

// Runs an edit may be copied into: same workflow, not the run itself, not open in an edit tab
// of their own (its Update would overwrite the copy), and never runs without a workflow
// identity (prompts queued by scripts would all match each other)
function siblingCandidates(item, pending, editingIds) {
    const key = groupKey(item);
    if (key == null) return [];
    return pending.filter(it => it[1] !== item[1] && !editingIds.has(it[1]) && groupKey(it) === key);
}

async function editQueuedRun(item) {
    const open = editSessions.get(item[1]);
    if (open) {
        toast("info", "Already open for editing", `Switch to the tab "${open.name}".`);
        return;
    }
    const workflow = item[3]?.extra_pnginfo?.workflow;
    if (!workflow) {
        toast("warn", "Can't edit this run", "It was queued without a workflow, for example by a script.");
        return;
    }
    const name = editTabName(item, queuePosition(item[1]));
    hideDetailCard();
    if (panelOpen && !HOVER) togglePanel();   // on touch screens the panel would cover the graph and the edit bar
    const store      = workflowStore();
    const openBefore = new Set((store.openWorkflows || []).map(w => w.path));
    await app.loadGraphData(workflow, true, true, name);
    // A failed load leaves the previous tab active; never turn that tab into the edit session
    const tab = store.activeWorkflow;
    if (!tab || openBefore.has(tab.path)) {
        toast("error", "Couldn't open the run for editing", "ComfyUI didn't open a new tab for it.");
        return;
    }
    // Edits are diffed against the editor's own read-back of the run, not the queued graph:
    // some widgets re-serialize differently on load, and that drift must not count as a change.
    const baseline = await app.graphToPrompt();
    editSessions.set(item[1], { promptId: item[1], item, path: tab.path, name, baseline });
    renderEditBar();
}

// Close an edit tab without the "save changes?" prompt: the edit lives in the
// queue, the tab was only the editor. The workflow service reopens the tab used before.
async function closeEditTab(session) {
    editSessions.delete(session.promptId);
    renderEditBar();
    const store = workflowStore();
    const wf    = store.openWorkflows.find(w => w.path === session.path);
    if (!wf) return;
    wf.changeTracker?.reset();
    wf.isModified = false;
    if (store.activeWorkflow?.path === wf.path) await app.extensionManager.command.execute("Workspace.CloseWorkflow");
}

// Modal dialog. buttons: [{ label, value: dialogEl => result, primary }]. Escape or a
// click on the backdrop resolves to cancelValue; onMount(dialogEl) wires live behaviour.
function showDialog(title, bodyHtml, buttons, cancelValue = null, onMount = null) {
    return new Promise(resolve => {
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px;";
        overlay.innerHTML = `
            <div role="dialog" aria-modal="true" aria-label="${esc(title)}" style="width:min(480px,100%);max-height:85vh;overflow-y:auto;box-sizing:border-box;background:#1e1e1e;border:1px solid #444;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.65);padding:16px 18px;font:13px/1.45 sans-serif;color:#ccc;">
                <div style="font-size:15px;font-weight:600;color:#e6e6e6;margin-bottom:10px;">${esc(title)}</div>
                ${bodyHtml}
                <div style="display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:16px;">
                    ${buttons.map((b, i) => `<button data-i="${i}"${b.primary ? " data-primary" : ""} style="${b.primary ? BTN_PRIMARY : BTN}">${esc(b.label)}</button>`).join("")}
                </div>
            </div>`;
        const dialog = overlay.firstElementChild;
        const onKey  = e => { if (e.key === "Escape") { e.stopPropagation(); close(cancelValue); } };
        const close  = value => { overlay.remove(); document.removeEventListener("keydown", onKey, true); resolve(value); };
        overlay.addEventListener("click", e => { if (e.target === overlay) close(cancelValue); });
        dialog.querySelectorAll("button[data-i]").forEach(btn =>
            btn.addEventListener("click", () => close(buttons[+btn.dataset.i].value(dialog))));
        document.addEventListener("keydown", onKey, true);
        document.body.appendChild(overlay);
        onMount?.(dialog);
        (dialog.querySelector("button[data-primary]") || dialog.querySelector("button"))?.focus({ preventScroll: true });
    });
}

// Resolves to the checked siblings, [] for "Only #n", or null for "Back to editing"
function chooseSiblings(session, prompt, changes, siblings) {
    const info  = groupInfo(pendingSorted());
    const where = queuePosition(session.promptId);
    const rows  = siblings.map((s, i) => {
        const thumb = info.get(s.item[1])?.thumbs[0];
        const gets  = [...new Set(s.patch.applied.map(c => changeName(c, prompt)))].join(", ");
        return `
            <label style="display:flex;align-items:center;gap:10px;padding:5px 0;cursor:pointer;">
                <input type="checkbox" data-i="${i}" checked style="accent-color:#a78bfa;">
                <span style="width:30px;color:#aaa;">${queuePosition(s.item[1])}</span>
                ${thumb ? thumbHtml({ ...thumb, shared: false }, 32, "#3a3a3a") : ""}
                <span style="color:#999;font-size:12px;min-width:0;">gets ${esc(gets)}</span>
            </label>`;
    }).join("");
    const body = `
        <div style="color:#999;">You changed</div>
        <ul style="margin:4px 0 12px 18px;padding:0;color:#ddd;">${changes.map(c => `<li>${esc(changeLabel(c, prompt))}</li>`).join("")}</ul>
        <div style="color:#999;margin-bottom:4px;">Also apply to the queued runs of this workflow that still have the old values</div>
        <div style="max-height:40vh;overflow-y:auto;">${rows}</div>`;
    const checked = dlg => siblings.filter((s, i) => dlg.querySelector(`input[data-i="${i}"]`).checked);
    const count   = n => `Update ${n} run${n > 1 ? "s" : ""}`;
    return showDialog(`Update queued run ${where}`, body, [
        { label: "Back to editing", value: () => null },
        { label: `Only ${where}`, value: () => [] },
        { label: count(siblings.length + 1), primary: true, value: checked },
    ], null, dlg => {
        const primary = dlg.querySelector("button[data-primary]");
        dlg.addEventListener("change", () => { primary.textContent = count(checked(dlg).length + 1); });
    });
}

// "Steps: Value 0 smaller than min of 1" from a 400 of /queue_workbench/replace; titles come
// from the run that failed (items = the request's items)
function validationMessage(data, items) {
    const prompt = items.find(it => it.prompt_id === data.prompt_id)?.prompt || {};
    const [nodeId, nodeError] = Object.entries(data.node_errors || {})[0] || [];
    const first = nodeError?.errors?.[0];
    if (first) {
        const title = prompt[nodeId]?._meta?.title || nodeError.class_type || nodeId;
        return `${title}: ${first.message}${first.details ? ` (${first.details})` : ""}`;
    }
    return data.error?.message || "The server rejected the edited graph.";
}

async function runAlreadyStarted(session) {
    const choice = await showDialog("This run has already started",
        `<p style="margin:0;">The queue picked up or removed the run while you were editing, so it can't be changed anymore. Your edit is still in this tab.</p>`,
        [{ label: "Keep tab as a copy", value: () => "keep" }, { label: "Queue as new run", primary: true, value: () => "queue" }], "keep");
    if (choice === "queue") {
        // false = node errors (ComfyUI shows them) or another queue request still in flight
        if (!(await app.queuePrompt(0, 1))) {   // stamp wrapper still sees the session -> original name
            editSessions.delete(session.promptId);
            toast("warn", "The edit wasn't queued", "It's still in this tab. Fix any errors and press Run.");
            return;
        }
        toast("success", "Queued the edited version as a new run");
        await closeEditTab(session);
    } else {
        editSessions.delete(session.promptId); // plain unsaved copy from now on
    }
}

async function updateQueuedRun(session) {
    if (editBusy) return;
    editBusy = true;
    renderEditBar();
    try {
        const { output, workflow } = await app.graphToPrompt();   // doesn't queue: seed controls don't fire
        queueData = await fetchQueue();
        if (isPaused && heldItems.some(it => it[1] === session.promptId)) {
            toast("warn", "This run is paused", "Resume the queue first, then update it.");
            return;
        }
        // Patch the run as it is queued now: another edit tab may have copied changes into it
        const current = pendingSorted().find(it => it[1] === session.promptId) ?? session.item;
        const { changes, structural } = diffPrompts(session.baseline.output, output);
        if (!structural && changes.length === 0) {
            toast("info", "No changes to update", `Run ${queuePosition(session.promptId) ?? ""} is unchanged.`);
            await closeEditTab(session);
            return;
        }
        const widgetChanges = structural ? [] : diffWidgets(session.baseline.workflow, workflow);
        const siblings = structural ? [] : siblingCandidates(current, pendingSorted(), new Set(editSessions.keys()))
            .map(it => ({ item: it, patch: patchRun(it, changes, widgetChanges) }))
            .filter(s => s.patch);
        let chosen = [];
        if (siblings.length) {
            chosen = await chooseSiblings(session, output, changes, siblings);
            if (chosen === null) return;
        }
        const edited = editedRunPayload(current, output, workflow, changes, widgetChanges, structural);
        const items  = [{ prompt_id: session.promptId, prompt: edited.prompt, workflow: edited.workflow },
            ...chosen.map(s => ({ prompt_id: s.item[1], prompt: s.patch.prompt, workflow: s.patch.workflow }))];
        const res  = await api.fetchApi("/queue_workbench/replace", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
        });
        const data = await res.json();
        if (!res.ok) {
            toast("error", `Couldn't update run ${queuePosition(data.prompt_id) ?? ""}`, validationMessage(data, items));
            return;
        }
        if (data.not_pending.includes(session.promptId)) {
            await runAlreadyStarted(session);
            return;
        }
        const others  = data.replaced.length - 1;
        const skipped = data.not_pending.length;
        const notes   = [
            structural && "The graph structure changed, so other runs were left as they were.",
            skipped && `${skipped} selected run${skipped > 1 ? "s" : ""} had already started and kept the old version.`,
        ].filter(Boolean).join(" ");
        toast("success", `Updated run ${queuePosition(session.promptId)}${others ? ` and ${others} other${others > 1 ? "s" : ""}` : ""}`, notes || undefined);
        await closeEditTab(session);
        await refreshQueue();
    } finally {
        editBusy = false;
        renderEditBar();
    }
}

function editBar() {
    let bar = document.getElementById("qm-edit-bar");
    if (bar) return bar;
    bar = document.createElement("div");
    bar.id = "qm-edit-bar";
    bar.style.cssText = `display:none;position:fixed;transform:translateX(-50%);z-index:9998;align-items:center;gap:10px;box-sizing:border-box;padding:8px 8px 8px 14px;background:#1e1e1e;border:1px solid #a78bfa;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,0.6);font:13px sans-serif;color:#ddd;`;
    bar.innerHTML = `
        <span class="qm-edit-label" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
        <button class="qm-edit-update" style="${BTN_PRIMARY}flex-shrink:0;">Update queued run</button>
        <button class="qm-edit-cancel" style="${BTN}flex-shrink:0;">Cancel</button>`;
    bar.querySelector(".qm-edit-update").addEventListener("click", () => {
        const session = editSessionFor(workflowStore()?.activeWorkflow);
        if (session) updateQueuedRun(session).catch(e => toast("error", "Couldn't update the run", String(e)));
    });
    bar.querySelector(".qm-edit-cancel").addEventListener("click", () => {
        const session = editSessionFor(workflowStore()?.activeWorkflow);
        if (session) closeEditTab(session);
    });
    document.body.appendChild(bar);
    return bar;
}

// Runs every 500ms: shows the bar on an edit tab and drops sessions whose tab was closed
function renderEditBar() {
    const store = workflowStore();
    if (!store) return;
    const openPaths = new Set((store.openWorkflows || []).map(w => w.path));
    for (const [id, s] of editSessions) if (!openPaths.has(s.path)) editSessions.delete(id);
    const session = editSessionFor(store.activeWorkflow);
    const bar     = editBar();
    if (!session) { bar.style.display = "none"; return; }
    if (!panelOpen && Date.now() - lastBarRefresh > 2000) {   // keep the position live while the panel isn't polling
        lastBarRefresh = Date.now();
        fetchQueue().then(d => { queueData = d; }).catch(() => {});
    }
    const where = queuePosition(session.promptId) ?? "(already started)";
    const name  = workflowName(session.item);
    bar.querySelector(".qm-edit-label").innerHTML = name
        ? `Editing <b>${esc(name)}</b> <span style="color:#999;">(queued ${esc(where)})</span>`
        : `Editing queued run <b>${esc(where)}</b>`;
    const update = bar.querySelector(".qm-edit-update");
    update.disabled    = editBusy;
    update.textContent = editBusy ? "Updating…" : "Update queued run";
    // Centred below the toolbar, in the space left of the panel when it's open
    const btn   = document.getElementById("qm-toolbar-btn");
    const right = panelOpen ? document.getElementById("qm-panel").getBoundingClientRect().left : window.innerWidth;
    bar.style.top      = ((btn?.getBoundingClientRect().bottom ?? 48) + 8) + "px";
    bar.style.left     = right / 2 + "px";
    bar.style.maxWidth = (right - 32) + "px";
    bar.style.display  = "flex";
}

let lastRenderKey = null; // skip rebuilding the DOM on polls where nothing changed

function renderQueue() {
    const statusEl  = document.getElementById("qm-status");
    const runningEl = document.getElementById("qm-running");
    const pendingEl = document.getElementById("qm-pending");
    if (!statusEl || !runningEl || !pendingEl) return;

    const running = queueData.queue_running || [];
    const pending = queueData.queue_pending || [];

    // In-place edits keep IDs and numbers, so the prompts themselves are part of the key
    const renderKey = JSON.stringify([running.map(i => i[1]), pending.map(i => [i[0], i[1], i[2]]),
        isPaused, expandedId, canEdit, Object.keys(workflowNames).length]);
    if (renderKey === lastRenderKey) return;
    lastRenderKey = renderKey;
    updateTabs();
    // Keep an open hover card across re-renders while its run is still listed
    const listed = [...running, ...pending, ...savedJobs, ...historyRuns.map(r => r.item)];
    if (cardItemId && !listed.some(it => it[1] === cardItemId)) hideDetailCard();
    const info = groupInfo([...running, ...pending]);

    // Status bar
    const pausedTag = isPaused ? " · <span style='color:#f90'>PAUSED</span>" : "";
    statusEl.innerHTML = `Running: ${running.length} · Pending: ${pending.length}${pausedTag}`;

    // Running item
    runningEl.innerHTML = "";
    if (running.length === 0) {
        runningEl.innerHTML = `<div style="color:#555;padding:4px 4px;font-size:12px;">Nothing running</div>`;
    } else {
        for (const item of running) {
            const id     = item[1];
            const { chips, thumbs } = info.get(id);

            const el = document.createElement("div");
            el.className = "qm-running-item";
            el.style.cssText = `
                background: #1f3520;
                border: 1px solid #3a5c3a;
                border-left: 3px solid ${stripeColor(groupKey(item))};
                border-radius: 5px;
                padding: 6px 10px;
                margin: 3px 0;
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                justify-content: space-between;
                min-height: 58px;
            `;
            el.innerHTML = `
                <span style="display:flex;align-items:center;gap:6px;overflow:hidden;flex:1;min-width:0;">
                    <span style="color:#6f6;font-size:14px;flex-shrink:0;">▶</span>
                    <span id="qm-thumb-container" style="position:relative;display:inline-flex;flex-shrink:0;width:44px;height:44px;overflow:hidden;border-radius:4px;">
                        ${thumbsHtml(thumbs, 44, "#3a5c3a", "#2a3a2a")}
                        <img id="qm-live-preview"
                             src=""
                             style="display:none;position:absolute;top:0;left:0;width:44px;height:44px;object-fit:cover;border-radius:4px;border:2px solid #7b5cfa;z-index:99;background:#000;"
                             >
                    </span>
                    <span style="display:flex;flex-direction:column;gap:2px;overflow:hidden;min-width:0;">
                        <span style="font-size:11px;color:#6a6;white-space:nowrap;"><span class="qm-load-workflow" data-running="true" style="color:#6f6;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;" title="Load this workflow onto canvas">${shortId(id)}</span> · ${queuedAt(item)}</span>
                        ${nameHtml(workflowName(item))}
                        <span id="qm-preview-label" style="color:#7b5cfa;font-size:10px;display:none;">● Live</span>
                    </span>
                </span>
                <button onclick="event.stopPropagation();window._qmInterrupt()" style="background:#8b0000;border:none;color:#fff;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;flex-shrink:0;">Interrupt</button>
                ${chipsRowHtml(chips)}
            `;

            // Show "Live" label when preview frame loads
            el.querySelector("#qm-live-preview")?.addEventListener("load", function() {
                if (this.src && this.src !== window.location.href) {
                    this.style.display = "block";
                    const label = el.querySelector("#qm-preview-label");
                    if (label) label.style.display = "block";
                }
            });

            // Apply live preview immediately if animation is running
            el.querySelector(".qm-load-workflow")?.addEventListener("click", async (e) => {
                e.stopPropagation();
                await loadWorkflowFromItem(item);
            });
            attachDetail(el, item, info.get(id), renderQueue, "Running");

            // If animation is active, apply current frame immediately
            if (animTimer && livePreviewUrl) {
                const previewEl = el.querySelector("#qm-live-preview");
                if (previewEl) {
                    previewEl.style.cssText = "display:block!important;position:absolute;top:0;left:0;width:44px;height:44px;object-fit:cover;border-radius:4px;border:2px solid #7b5cfa;z-index:99;background:#000;";
                    previewEl.src = livePreviewUrl;
                    const label = el.querySelector("#qm-preview-label");
                    if (label) label.style.display = "block";
                }
            }

            runningEl.appendChild(el);
        }
    }

    // Pending items — drag-and-drop list
    if (touchDrag) endTouchDrag();   // the rows are about to be replaced
    const tops = rowTops(pendingEl);   // where each row was, so rows that change slots can slide
    pendingEl.innerHTML = "";
    if (pending.length === 0) {
        pendingEl.innerHTML = `<div style="color:#555;padding:4px 4px;font-size:12px;">Queue is empty</div>`;
        return;
    }

    // Sort by queue number ascending (lower number = runs first)
    const sorted = [...pending].sort((a, b) => a[0] - b[0]);

    for (let i = 0; i < sorted.length; i++) {
        const item = sorted[i];
        const id   = item[1];
        const { chips, thumbs } = info.get(id);
        const el   = document.createElement("div");
        el.dataset.promptId = id;
        el.dataset.index    = i;
        el.draggable        = HOVER;   // touch screens use the pointer drag on the handle (no HTML5 drag)
        el.style.cssText = `
            background: #242424;
            border: 1px solid #3a3a3a;
            border-left: 3px solid ${stripeColor(groupKey(item))};
            border-radius: 5px;
            padding: 6px 10px;
            margin: 3px 0;
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
            cursor: grab;
            user-select: none;
            transition: background 0.1s;
            min-height: 58px;
        `;

        el.innerHTML = `
            <span style="display:flex;align-items:center;gap:6px;overflow:hidden;flex:1;min-width:0;">
                <span class="qm-drag-handle" style="color:#555;font-size:16px;cursor:grab;flex-shrink:0;touch-action:none;padding:8px 10px;margin:-8px -10px;">⠿</span>
                <span style="display:flex;gap:3px;flex-shrink:0;">${thumbsHtml(thumbs, 44, "#444", "#333")}</span>
                <span style="display:flex;flex-direction:column;gap:2px;overflow:hidden;min-width:0;">
                    <span style="color:#aaa;font-size:12px;white-space:nowrap;">#${i + 1} <span style="color:#666;font-size:11px;">· ${queuedAt(item)} · <span class="qm-load-workflow" data-index="${i}" style="color:#7b9cfa;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;" title="Load this workflow onto canvas">${shortId(id)}</span></span></span>
                    ${nameHtml(workflowName(item))}
                </span>
            </span>
            <span style="display:flex;gap:4px;flex-shrink:0;">
                ${canEdit ? `<button class="qm-edit-btn" title="Edit this queued run" style="background:#2f2750;border:none;color:#c9b8ff;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;">✎</button>` : ""}
                <button data-id="${id}" class="qm-delete-btn" style="background:#5a1a1a;border:none;color:#f88;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;">✕</button>
            </span>
            ${chipsRowHtml(chips)}
        `;

        // Delete button
        el.querySelector(".qm-delete-btn").addEventListener("click", async (e) => {
            e.stopPropagation();
            await deleteItem(id);
            await refreshQueue();
        });
        el.querySelector(".qm-edit-btn")?.addEventListener("click", (e) => {
            e.stopPropagation();
            editQueuedRun(item).catch(console.error);
        });

        // Load workflow button
        el.querySelector(".qm-load-workflow")?.addEventListener("click", async (e) => {
            e.stopPropagation();
            await loadWorkflowFromItem(item);
        });
        attachDetail(el, item, info.get(id), renderQueue, `#${i + 1} of ${sorted.length}`);

        // Drag events
        el.addEventListener("dragstart", onDragStart);
        el.addEventListener("dragover",  onDragOver);
        el.addEventListener("drop",      onDrop);
        el.addEventListener("dragend",   onDragEnd);
        const handle = el.querySelector(".qm-drag-handle");
        handle.addEventListener("pointerdown", onHandlePointerDown);
        handle.addEventListener("contextmenu", e => e.preventDefault());   // long press must not open the menu

        pendingEl.appendChild(el);
    }
    slideMovedRows(pendingEl, tops);
}

// ---------------------------------------------------------------------------
// History tab — finished runs persisted by the backend (persistence.py), newest
// first. Listed runs carry a cut-down workflow; loading or re-queueing a run
// fetches its full entry.
// ---------------------------------------------------------------------------
let historyRuns     = [];    // { id, item, outputs, status }, newest first
let historyMore     = false; // older runs exist beyond the loaded ones
let historyLoaded   = false;
let historyError    = false; // last fetch (first load or refresh) failed, e.g. 404 before a restart
let historyNewestId = 0;     // poll cursors, kept apart from the list so deleting rows never moves them
let historyOldestId = null;
let historyBusy     = false;
let historyMoreBusy = false;
let lastHistoryKey  = null;
const HISTORY_CLIENT_CAP = 200; // matches the backend's HISTORY_LIMIT; keeps the client list from growing forever

async function fetchHistory(query) {
    const res  = await api.fetchApi(`/queue_workbench/history?${query}`);
    const data = await res.json();
    const runs = data.runs.map(r => ({ id: r.id, item: r.prompt, outputs: r.outputs || {}, status: r.status }));
    for (const r of runs) {
        historyNewestId = Math.max(historyNewestId, r.id);
        historyOldestId = historyOldestId === null ? r.id : Math.min(historyOldestId, r.id);
    }
    return { runs, more: data.more };
}

// First page on first use, afterwards only the runs that finished since
async function refreshHistory() {
    if (historyBusy) return;
    historyBusy = true;
    try {
        if (!historyLoaded) {
            const { runs, more } = await fetchHistory("limit=50");
            historyRuns   = runs;
            historyMore   = more;
            historyLoaded = true;
        } else {
            const { runs } = await fetchHistory(`after=${historyNewestId}`);
            // cap at the client too: the backend only keeps HISTORY_LIMIT, so older rows
            // beyond it no longer exist server-side and would just sit there dead weight
            if (runs.length) historyRuns = mergeNewRuns(historyRuns, runs).slice(0, HISTORY_CLIENT_CAP);
        }
        historyError = false;
    } catch (e) {
        console.warn("[QueueWorkbench] Failed to fetch history:", e);   // e.g. backend not restarted since updating
        historyError = true;
    } finally {
        historyBusy = false;
    }
    renderHistory();   // also on failure, so the empty state shows
}

async function loadMoreHistory() {
    if (historyMoreBusy) return;
    historyMoreBusy = true;
    try {
        const { runs, more } = await fetchHistory(`limit=50&before=${historyOldestId}`);
        historyRuns = [...historyRuns, ...runs];
        historyMore = more;
        renderHistory();
    } finally {
        historyMoreBusy = false;
    }
}

async function fullHistoryItem(run) {
    const res = await api.fetchApi(`/queue_workbench/history/${encodeURIComponent(run.item[1])}`);
    if (!res.ok) throw new Error("This run is no longer in the history.");
    return (await res.json()).run.prompt;
}

async function requeueRun(run) {
    const item = await fullHistoryItem(run);
    const body = requeueBody(item, api.clientId);
    const res  = await api.fetchApi("/prompt", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast("error", "Couldn't queue the run again", validationMessage(data, [{ prompt_id: data.prompt_id, prompt: body.prompt }]));
        return;
    }
    toast("success", "Queued again", workflowName(item) || undefined);
    await refreshQueue();
}

async function deleteHistoryRun(run) {
    const res = await api.fetchApi("/queue_workbench/history/delete", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt_ids: [run.item[1]] }),
    });
    if (!res.ok) {
        toast("error", "Couldn't remove the run from the history");
        return;
    }
    if (cardItemId === run.item[1]) hideDetailCard();
    historyRuns = historyRuns.filter(r => r !== run);
    renderHistory();
}

function renderHistory() {
    const list = document.getElementById("qm-history");
    const more = document.getElementById("qm-history-more");
    if (!list || !more) return;
    const key = JSON.stringify([historyRuns.map(r => r.id), historyMore, expandedId, Object.keys(workflowNames).length, historyLoaded, historyError]);
    if (key === lastHistoryKey) return;
    lastHistoryKey = key;
    more.style.display = historyMore ? "block" : "none";
    list.innerHTML = "";
    if (historyRuns.length === 0) {
        const text = !historyLoaded
            ? (historyError ? "Couldn't load the history. Restart ComfyUI if you just updated." : "Loading…")
            : "No finished runs yet";
        list.innerHTML = `<div style="color:#555;padding:4px 4px;font-size:12px;">${text}</div>`;
        return;
    }
    const info = groupInfo(historyRuns.map(r => r.item));
    for (const run of historyRuns) {
        const id     = run.item[1];
        const f      = finishedInfo(run);
        const failed = f.state === "error";
        const el     = document.createElement("div");
        el.style.cssText = `
            background: ${failed ? "#2a1f1f" : "#242424"};
            border: 1px solid ${failed ? "#4a2a2a" : "#3a3a3a"};
            border-left: 3px solid ${stripeColor(groupKey(run.item))};
            border-radius: 5px;
            padding: 6px 10px;
            margin: 3px 0;
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
            min-height: 58px;
        `;
        el.innerHTML = historyRowHtml(run, info.get(id));
        el.querySelector(".qm-load-workflow").addEventListener("click", (e) => {
            e.stopPropagation();
            fullHistoryItem(run).then(loadWorkflowFromItem).catch(err => toast("error", "Couldn't load the run", err.message));
        });
        el.querySelector(".qm-requeue-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            requeueRun(run).catch(err => toast("error", "Couldn't queue the run again", err.message));
        });
        el.querySelector(".qm-history-delete").addEventListener("click", (e) => {
            e.stopPropagation();
            deleteHistoryRun(run).catch(err => toast("error", "Couldn't remove the run from the history", err.message));
        });
        attachDetail(el, run.item, info.get(id), renderHistory, `${f.mark} ${f.label} ${f.text}`.trim(), run);
        list.appendChild(el);
    }
}

// ---------------------------------------------------------------------------
// Drag-and-drop
// ---------------------------------------------------------------------------
let dragSrcId    = null; // prompt_id of the row being dragged (mouse)
let movedId      = null; // prompt_id of the dropped row, flashed once the server's new order lands

// prompt_id -> layout top of each pending row (offsetTop ignores the list's scroll position)
function rowTops(list) {
    return new Map([...list.querySelectorAll("[data-prompt-id]")].map(el => [el.dataset.promptId, el.offsetTop]));
}

// Rows that changed slots: prompt_id -> how far (px) the row starts from its new place
function slotShifts(before, after) {
    const shifts = new Map();
    for (const [id, top] of after) {
        if (before.has(id) && before.get(id) !== top) shifts.set(id, before.get(id) - top);
    }
    return shifts;
}

// After a re-render, rows that changed slots slide from their old place (FLIP), and the
// row just dropped flashes, so a reorder is visible at a glance
function slideMovedRows(list, before) {
    const shifts = slotShifts(before, rowTops(list));
    const still  = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const el of list.querySelectorAll("[data-prompt-id]")) {
        const dy = shifts.get(el.dataset.promptId);
        if (!dy) continue;
        if (!still) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 200, easing: "ease-out" });
        if (el.dataset.promptId === movedId) {
            el.animate([{ backgroundColor: "#3a2f6a", boxShadow: "0 0 0 2px #7b5cfa" }, { backgroundColor: "#242424", boxShadow: "0 0 0 2px #7b5cfa00" }],
                { duration: 700, easing: "ease-out" });
        }
    }
}

// Pending order (prompt ids) after moving `movedId` onto `targetId`'s slot ("top" = first),
// or null when nothing moves (dropped on itself, already first, or either run already started)
function reorderedIds(ids, movedId, targetId) {
    const from = ids.indexOf(movedId);
    const to   = targetId === "top" ? 0 : ids.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return null;
    const order = [...ids];
    order.splice(to, 0, order.splice(from, 1)[0]);
    return order;
}

// Mouse drop, touch drop and Move to top all end here. Positions come from the queue as it
// is now (a run may have started since the drag began), not from the indexes rendered then.
async function moveRun(promptId, targetId) {
    queueData   = await fetchQueue();
    const pending = pendingSorted();
    const order   = reorderedIds(pending.map(it => it[1]), promptId, targetId);
    if (!order) { renderQueue(); return; }   // nothing moved: still re-render (e.g. an inline detail that was left open)
    movedId = promptId;
    try {
        if (canEdit) {
            // Renumber in place: prompt IDs (and any open edit tab's link to its run) stay intact
            await api.fetchApi("/queue_workbench/reorder", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt_ids: order }),
            });
        } else {
            const byId = new Map(pending.map(it => [it[1], it]));
            await reorderQueue(order.map(id => byId.get(id)));
        }
        await refreshQueue();
    } finally {
        movedId = null;
    }
}

let dropTarget = null; // { el, anim }: the row a drop would move the dragged run to, highlighted red

function markDropTarget(el) {
    if ((dropTarget?.el ?? null) === el) return;
    dropTarget?.anim.cancel();
    dropTarget = el && { el, anim: el.animate({ backgroundColor: "#4a1f24", boxShadow: "0 0 0 2px #e05260" }, { duration: 120, fill: "forwards" }) };
}

// dragover keeps firing while the cursor is over a row's children (dragenter/dragleave pairs
// don't), so the highlight can't flicker. Nothing is red over the dragged row or off the list.
function trackDropTarget(e) {
    const row = e.target.closest?.("#qm-pending [data-prompt-id]");
    markDropTarget(row && row.dataset.promptId !== dragSrcId ? row : null);
}

function onDragStart(e) {
    dragSrcId = e.currentTarget.dataset.promptId;
    e.currentTarget.style.opacity = "0.4";
    e.dataTransfer.effectAllowed = "move";
    document.addEventListener("dragover", trackDropTarget);
}

function onDragEnd(e) {
    e.currentTarget.style.opacity = "1";
    document.removeEventListener("dragover", trackDropTarget);
    markDropTarget(null);
    dragSrcId = null;
}

function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
}

async function onDrop(e) {
    e.preventDefault();
    const dragged = dragSrcId;
    dragSrcId = null;
    if (dragged) await moveRun(dragged, e.currentTarget.dataset.promptId).catch(console.error);
}

// ---------------------------------------------------------------------------
// Touch drag — touch browsers don't fire HTML5 drag events, so on phones a long press on
// the ⠿ handle starts a pointer drag with the same red target, move, slide and flash
// ---------------------------------------------------------------------------
const LONG_PRESS_MS = 300;
let touchDrag = null; // { el, id, pointerId, x, y, startY, startScroll, maxScroll, active, armed, timer, raf }

function onHandlePointerDown(e) {
    if (e.pointerType !== "touch" || touchDrag) return;
    const el   = e.currentTarget.closest("[data-prompt-id]");
    const list = document.getElementById("qm-pending");
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.addEventListener("pointermove", onHandlePointerMove);
    e.currentTarget.addEventListener("pointerup", onHandlePointerUp);
    e.currentTarget.addEventListener("pointercancel", onHandlePointerCancel);
    touchDrag = { el, handle: e.currentTarget, id: el.dataset.promptId, pointerId: e.pointerId, x: e.clientX, y: e.clientY,
        startY: e.clientY, startScroll: list.scrollTop, active: false, armed: false, raf: null,
        timer: setTimeout(startTouchDrag, LONG_PRESS_MS) };
}

function startTouchDrag() {
    touchDrag.active = true;
    // The dragged row's own translateY grows the list's scrollHeight, so the real limit has to be
    // captured now, before any transform is applied, or auto-scroll would chase a moving target
    const list = document.getElementById("qm-pending");
    touchDrag.maxScroll = list.scrollHeight - list.clientHeight;
    navigator.vibrate?.(10);
    // Click-through so elementFromPoint finds the row underneath; pointer capture keeps the events coming
    Object.assign(touchDrag.el.style, { opacity: "0.6", pointerEvents: "none", position: "relative", zIndex: "1" });
    touchDrag.raf = requestAnimationFrame(autoScrollTouchDrag);
}

// Keep the dragged row under the finger (also while the list auto-scrolls) and mark the target
function placeTouchDrag() {
    const list = document.getElementById("qm-pending");
    touchDrag.el.style.transform = `translateY(${touchDrag.y - touchDrag.startY + list.scrollTop - touchDrag.startScroll}px)`;
    const row = document.elementFromPoint(touchDrag.x, touchDrag.y)?.closest("#qm-pending [data-prompt-id]");
    markDropTarget(row && row !== touchDrag.el ? row : null);
}

function onHandlePointerMove(e) {
    if (!touchDrag || e.pointerId !== touchDrag.pointerId) return;
    touchDrag.x = e.clientX;
    touchDrag.y = e.clientY;
    if (touchDrag.active) {
        // Auto-scroll only once the finger has actually moved: holding still right after the long
        // press fires on a row flush with the list's top/bottom edge must not start scrolling (and
        // so must not reorder on release) just because the handle happens to sit in the scroll zone
        if (!touchDrag.armed && Math.abs(e.clientY - touchDrag.startY) > 8) touchDrag.armed = true;
        placeTouchDrag();
    }
    else if (Math.abs(e.clientY - touchDrag.startY) > 8) endTouchDrag();   // moved before the long press: not a drag
}

function autoScrollTouchDrag() {
    if (!touchDrag?.active) return;
    const list = document.getElementById("qm-pending");
    const box  = list.getBoundingClientRect();
    const step = !touchDrag.armed ? 0 : touchDrag.y < box.top + 40 ? -8 : touchDrag.y > box.bottom - 40 ? 8 : 0;
    if (step) {
        // Clamp to the real max: the dragged row's transform must never be read back as extra scroll room
        const next = Math.max(0, Math.min(touchDrag.maxScroll, list.scrollTop + step));
        if (next !== list.scrollTop) {
            list.scrollTop = next;
            placeTouchDrag();
        }
    }
    touchDrag.raf = requestAnimationFrame(autoScrollTouchDrag);
}

function onHandlePointerUp(e) {
    if (!touchDrag || e.pointerId !== touchDrag.pointerId) return;
    const { id, active } = touchDrag;
    const target = dropTarget?.el.dataset.promptId;
    endTouchDrag();
    if (active && target) moveRun(id, target).catch(console.error);
}

function onHandlePointerCancel(e) {
    if (!touchDrag || e.pointerId !== touchDrag.pointerId) return;   // a second finger's own cancel isn't ours
    endTouchDrag();
}

function endTouchDrag() {
    if (!touchDrag) return;
    const { el, handle, active, timer, raf } = touchDrag;
    touchDrag = null;
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    handle.removeEventListener("pointermove", onHandlePointerMove);
    handle.removeEventListener("pointerup", onHandlePointerUp);
    handle.removeEventListener("pointercancel", onHandlePointerCancel);
    Object.assign(el.style, { opacity: "", pointerEvents: "", position: "", zIndex: "", transform: "" });
    markDropTarget(null);
    if (active) {
        // The finger lifting off ends in a click on the row; it must not toggle the detail
        const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 400);
    }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------
async function refreshQueue() {
    try {
        queueData = await fetchQueue();
        const hasRunning = (queueData.queue_running || []).length > 0;
        if (hasRunning && !isGenerating) {
            isGenerating     = true;
            wsFramesReceived = 0;
            startPreviewPolling();
        } else if (!hasRunning && isGenerating) {
            isGenerating = false;
            stopPreviewPolling();
            stopPollAnimation();
            setTimeout(() => { if (!isGenerating) stopAnimation(); }, 2000);
        }
        renderQueue();
    } catch (e) {
        console.warn("[QueueWorkbench] Failed to fetch queue:", e);
    }
    if (panelOpen && activeTab === "history") refreshHistory();
}

function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(refreshQueue, 2000);
    refreshQueue();
}

function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ---------------------------------------------------------------------------
// Toolbar button
// ---------------------------------------------------------------------------
function togglePanel() {
    panelOpen = !panelOpen;
    const panel = document.getElementById("qm-panel");
    if (panel) {
        panel.style.display = panelOpen ? "flex" : "none";
        if (panelOpen && panel._reposition) panel._reposition();
    }
    if (panelOpen) {
        startPolling();
        refreshSaved();   // refresh the previous-session backlog when opened
        Promise.all([refreshWorkflowNames(), probeEditSupport()]).then(() => { renderQueue(); renderSaved(); renderHistory(); });
    } else {
        stopPolling();
        hideDetailCard();
    }
    const btn = document.getElementById("qm-toolbar-btn");
    if (btn) btn.style.background = panelOpen ? "#7b5cfa" : "";
}

function createToolbarButton() {
    const btn = document.createElement("button");
    btn.id    = "qm-toolbar-btn";
    btn.title = "Queue Workbench";
    btn.textContent = "🗂️";
    btn.style.cssText = `
        border: 1px solid #555;
        border-radius: 5px;
        color: #ddd;
        font-size: 16px;
        padding: 3px 8px;
        cursor: pointer;
        margin: 0 4px;
        transition: background 0.15s;
        background: #1a1a1a;
        width: auto;
        flex-shrink: 0;
        align-self: center;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: unset;
        max-width: unset;
    `;
    btn.onmouseenter = () => { if (!panelOpen) btn.style.background = "#333"; };
    btn.onmouseleave = () => { if (!panelOpen) btn.style.background = "#1a1a1a"; };
    btn.onclick = togglePanel;

    const tryInsert = () => {
        if (document.getElementById("qm-toolbar-btn")) return true;

        // Most reliable anchor: the cancel button is a direct sibling of what
        // we want — insert our button right after it
        const cancelBtn = document.querySelector("button[aria-label='Cancel current run']");
        if (cancelBtn?.parentElement) {
            cancelBtn.parentElement.insertBefore(btn, cancelBtn.nextSibling);
            if (document.getElementById("qm-toolbar-btn")) return true;
        }

        // Fallback: inside the queue-button-group flex container
        const queueBtnGroup = document.querySelector(".queue-button-group.flex");
        if (queueBtnGroup) {
            queueBtnGroup.appendChild(btn);
            if (document.getElementById("qm-toolbar-btn")) return true;
        }

        // Last fallback: append to actionbar-container
        const actionbar = document.querySelector(".actionbar-container");
        if (actionbar) {
            actionbar.appendChild(btn);
            if (document.getElementById("qm-toolbar-btn")) return true;
        }

        return false;
    };

    let attempts = 0;
    const retry = setInterval(() => {
        attempts++;
        if (tryInsert() || attempts > 30) {
            clearInterval(retry);
            // Fallback: always-visible fixed button
            if (!document.getElementById("qm-toolbar-btn")) {
                btn.style.cssText = `
                    position: fixed;
                    top: 10px;
                    right: 10px;
                    z-index: 9998;
                    background: #1a1a1a;
                    border: 1px solid #555;
                    border-radius: 5px;
                    color: #ddd;
                    font-size: 16px;
                    padding: 3px 8px;
                    cursor: pointer;
                    width: auto;
                    display: inline-flex;
                    align-items: center;
                `;
                document.body.appendChild(btn);
            }

            // MutationObserver — re-inject button if DOM changes remove it
            // (e.g. side panel toggle re-renders the actionbar)
            const observer = new MutationObserver(() => {
                if (!document.getElementById("qm-toolbar-btn")) {
                    // Button was removed — retry insertion up to 10 times
                    // but never fall through to the fixed-position fallback
                    let retries = 0;
                    const reinsert = setInterval(() => {
                        retries++;
                        const cancelBtn = document.querySelector("button[aria-label='Cancel current run']");
                        if (cancelBtn?.parentElement) {
                            cancelBtn.parentElement.insertBefore(btn, cancelBtn.nextSibling);
                        }
                        if (document.getElementById("qm-toolbar-btn") || retries > 10) {
                            clearInterval(reinsert);
                        }
                    }, 100);
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }, 300);
}

// Pause no longer uses execution_start to interrupt — see setPaused() above.

// ---------------------------------------------------------------------------
// Live preview — open a second independent WebSocket connection
// This gives us raw binary frames without touching the frontend's own socket.
// The new ComfyUI frontend processes binary messages internally before
// dispatching them, so tapping api.socket doesn't work reliably.
// A second connection is clean, isolated, and guaranteed not to interfere.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Live preview — tap into ComfyUI's existing WebSocket via message listener
// Preview frames are only sent to the client that submitted the job.
// api.clientId is that client — we attach a passive listener to api.socket.
// We wait until the socket exists and is open before attaching.
// ---------------------------------------------------------------------------
let previewListenerAttached = false;

// Animation state
let frameBuffer      = [];   // frames being collected for the current step
let animFrames       = [];   // frames currently being animated
let animIndex        = 0;
let animTimer        = null;
let frameGapTimer    = null; // detects end of a burst
const ANIM_FPS       = 12;
const BURST_GAP_MS   = 200; // ms silence = new step starting
const MAX_BUFFER     = 50;  // trigger animation if buffer hits this size

function startAnimation(frames) {
    if (frames.length === 0) return;

    const wasRunning = !!animTimer;
    const oldFrames  = animFrames;
    animFrames = frames;
    animIndex  = 0;

    setTimeout(() => { oldFrames.forEach(u => URL.revokeObjectURL(u)); }, 3000);

    // Apply to DOM if panel is open and element exists
    function applyFrame() {
        const previewEl = document.getElementById("qm-live-preview");
        if (previewEl) {
            previewEl.style.cssText = "display:block!important;position:absolute;top:0;left:0;width:44px;height:44px;object-fit:cover;border-radius:4px;border:2px solid #7b5cfa;z-index:99;background:#000;";
            previewEl.src = animFrames[animIndex % animFrames.length] || "";
        }
        const label = document.getElementById("qm-preview-label");
        if (label) label.style.display = "block";
    }

    if (!wasRunning) {
        animTimer = setInterval(() => {
            if (animFrames.length === 0) return;
            const url = animFrames[animIndex % animFrames.length];
            animIndex++;
            livePreviewUrl = url;
            const el = document.getElementById("qm-live-preview");
            if (!el) return;
            // Preload before swapping to prevent flash
            const preloader = new Image();
            preloader.onload = () => {
                const target = document.getElementById("qm-live-preview");
                if (target) {
                    target.style.cssText = "display:block!important;position:absolute;top:0;left:0;width:44px;height:44px;object-fit:cover;border-radius:4px;border:2px solid #7b5cfa;z-index:99;background:#000;";
                    target.src = url;
                }
            };
            preloader.src = url;
        }, 1000 / ANIM_FPS);
    }

    // Apply immediately in case panel is already open
    applyFrame();
}

function stopAnimation() {
    if (animTimer) { clearInterval(animTimer); animTimer = null; }
    if (frameGapTimer) { clearTimeout(frameGapTimer); frameGapTimer = null; }
    animFrames.forEach(u => URL.revokeObjectURL(u));
    animFrames  = [];
    frameBuffer = [];
    animIndex   = 0;
    livePreviewUrl = null;
    const previewEl = document.getElementById("qm-live-preview");
    if (previewEl) { previewEl.style.display = "none"; previewEl.src = ""; }
    const label = document.getElementById("qm-preview-label");
    if (label) label.style.display = "none";
}

function handlePreviewMessage(event) {
    if (event.data instanceof ArrayBuffer) {
        processPreviewBuffer(event.data);
    } else if (event.data instanceof Blob) {
        const reader = new FileReader();
        reader.onload = () => {
            processPreviewBuffer(reader.result);
        };
        reader.onerror = (e) => console.error("[QueueWorkbench] FileReader error:", e);
        reader.readAsArrayBuffer(event.data);
    }
}

function processPreviewBuffer(buf) {
    if (buf.byteLength < 8) {
        console.warn("[QueueWorkbench] buffer too small:", buf.byteLength);
        return;
    }

    const view    = new DataView(buf);
    const msgType = view.getInt32(0);
    if (msgType !== 1 && msgType !== 2) return;

    wsFramesReceived++;

    let offset = -1;
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < Math.min(64, bytes.length - 1); i++) {
        const isJpeg = bytes[i] === 0xFF && bytes[i+1] === 0xD8;
        const isPng  = bytes[i] === 0x89 && bytes[i+1] === 0x50;
        if (isJpeg || isPng) { offset = i; break; }
    }
    if (offset === -1) return;

    const imageData = buf.slice(offset);
    const mimeType  = msgType === 2 ? "image/png" : "image/jpeg";
    const blob      = new Blob([imageData], { type: mimeType });
    const url       = URL.createObjectURL(blob);

    frameBuffer.push(url);

    // Safety valve — trigger animation immediately if buffer gets too large
    // This handles cases where frames arrive faster than BURST_GAP_MS continuously
    if (frameBuffer.length >= MAX_BUFFER) {
        if (frameGapTimer) { clearTimeout(frameGapTimer); frameGapTimer = null; }
        startAnimation([...frameBuffer]);
        frameBuffer = [];
        return;
    }

    if (frameGapTimer) clearTimeout(frameGapTimer);
    frameGapTimer = setTimeout(() => {
        if (frameBuffer.length > 0) {
            startAnimation([...frameBuffer]);
            frameBuffer = [];
        }
    }, BURST_GAP_MS);
}

function connectPreviewSocket() {
    if (previewListenerAttached) return;

    // Poll until api.socket exists and is open
    const waitForSocket = setInterval(() => {
        const socket = api.socket;
        if (!socket) return;
        if (socket.readyState !== WebSocket.OPEN) return;

        socket.addEventListener("message", handlePreviewMessage);
        previewListenerAttached = true;
        clearInterval(waitForSocket);
    }, 200);
}

function disconnectPreviewSocket() {
    if (api.socket) {
        api.socket.removeEventListener("message", handlePreviewMessage);
    }
    previewListenerAttached = false;
    stopAnimation();
}

api.addEventListener("execution_start", () => {
    isGenerating = true;
    wsFramesReceived = 0;
    startPreviewPolling();
});

api.addEventListener("execution_success", () => {
    isGenerating = false;
    stopPreviewPolling();
    stopPollAnimation();
    setTimeout(() => { if (!isGenerating) stopAnimation(); }, 2000);
    api.fetchApi("/queue_workbench/preview/clear", { method: "POST" }).catch(() => {});
});

api.addEventListener("execution_interrupted", () => {
    isGenerating = false;
    stopPreviewPolling();
    stopPollAnimation();
    stopAnimation();
});

// ---------------------------------------------------------------------------
// Fallback polling — polls server-side preview cache for non-submitting clients
// WebSocket frames update livePreviewUrl directly at ~12fps for the submitting
// client. For all other clients, we poll /queue_workbench/preview at 2fps.
// ---------------------------------------------------------------------------
let wsFramesReceived  = 0;  // count of WS preview frames received this job
let previewPollTimer  = null;
let lastPollUrl       = null;
let lastStepId        = -1;   // track which step we last animated
let pollFrameUrls     = [];   // blob URLs for current polled step

function base64ToUrl(b64) {
    const binary = atob(b64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
}

function startPreviewPolling() {
    if (previewPollTimer) return;
    let consecutive404s = 0;

    previewPollTimer = setTimeout(async function poll() {
        if (!isGenerating) return;

        // If WS frames are arriving we're the submitting client — no need to poll
        if (wsFramesReceived > 5) {
            previewPollTimer = null;
            return;
        }

        const interval = consecutive404s > 5 ? 1000 : 500;
        try {
            const res = await fetch(`/queue_workbench/frames?t=${Date.now()}`);
            if (res.ok) {
                consecutive404s = 0;
                const data = await res.json();

                if (data.step_id !== lastStepId && data.frames?.length > 0) {
                    lastStepId = data.step_id;

                    // Revoke old poll frame URLs
                    pollFrameUrls.forEach(u => URL.revokeObjectURL(u));
                    pollFrameUrls = data.frames.map(b64 => base64ToUrl(b64));

                    startAnimation([...pollFrameUrls]);
                }
            } else {
                consecutive404s++;
            }
        } catch (e) {
            console.error("[QueueWorkbench] fetch error:", e);
            consecutive404s++;
        }
        if (isGenerating) {
            previewPollTimer = setTimeout(poll, interval);
        }
    }, 2000);
}

function stopPreviewPolling() {
    if (previewPollTimer) { clearTimeout(previewPollTimer); previewPollTimer = null; }
    if (lastPollUrl) { URL.revokeObjectURL(lastPollUrl); lastPollUrl = null; }
    pollFrameUrls.forEach(u => URL.revokeObjectURL(u));
    pollFrameUrls = [];
    lastStepId    = -1;
}

// Poll-based animation — updates img src directly from endpoint, no blob URLs
let pollAnimTimer = null;
function startPollAnimation(initialUrl) {
    if (pollAnimTimer) return;
    const el = document.getElementById("qm-live-preview");
    if (!el) return;
    el.style.cssText = "display:block!important;position:absolute;top:0;left:0;width:44px;height:44px;object-fit:cover;border-radius:4px;border:2px solid #7b5cfa;z-index:99;background:#000;";
    el.removeAttribute("alt"); // remove alt text so broken frames show nothing
    el.src = initialUrl;
    const label = document.getElementById("qm-preview-label");
    if (label) label.style.display = "block";

    pollAnimTimer = setInterval(() => {
        const img = document.getElementById("qm-live-preview");
        if (!img) { clearInterval(pollAnimTimer); pollAnimTimer = null; return; }
        img.src = `/queue_workbench/preview?t=${Date.now()}`;
    }, 500);
}

function stopPollAnimation() {
    if (pollAnimTimer) { clearInterval(pollAnimTimer); pollAnimTimer = null; }
}

// NOTE: We deliberately do NOT listen to the "status" websocket event here for polling.
// That event fires on every preview frame during generation and is used by
// ComfyUI to stream live diffusion step previews to the canvas. Calling
// refreshQueue() on it causes async contention that breaks the preview stream.
// Polling via setInterval(refreshQueue, 2000) is sufficient.

// Expose interrupt for inline button
window._qmInterrupt = async () => {
    await interruptCurrent();
    await refreshQueue();
};

// ---------------------------------------------------------------------------
// Register extension
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "ComfyUI.QueueWorkbench",

    async setup() {

        // Stamp the open tab's filename + queue time so the panel can name the item.
        // Copies workflow/extra so the live graph (and its modified flag) stays untouched.
        const queuePrompt = api.queuePrompt.bind(api);
        api.queuePrompt = (number, data, options) => {
            if (data?.workflow) {
                const active  = app.extensionManager?.workflow?.activeWorkflow;
                // A run queued from an edit tab keeps the name of the run it came from
                const session = editSessionFor(active);
                const name    = session ? workflowName(session.item) : active?.filename;
                // qm_name always overwritten: a graph loaded from an output PNG carries its old stamp
                data = { ...data, workflow: { ...data.workflow, extra: {
                    ...data.workflow.extra, qm_name: name, qm_queued_at: Date.now() } } };
            }
            return queuePrompt(number, data, options);
        };

        createPanel();
        createToolbarButton();
        connectPreviewSocket(); // always attach, regardless of panel state
        qmCheckBuild();
        setInterval(renderEditBar, 500);

        // Hide panel initially
        const panel = document.getElementById("qm-panel");
        if (panel) panel.style.display = "none";
    },
});