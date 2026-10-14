# ComfyUI Queue Workbench

A queue panel for ComfyUI that lets you see what's actually in your queue, tell
runs of the same workflow apart, and fix a queued run without re-queueing it.

![Queue panel: running job with progress, queued runs with thumbnails, setting chips and start times](docs/media/01-queue-overview.gif)

▶ [Watch the 2½-minute walkthrough](docs/media/walkthrough.mp4) — every feature below, on desktop and on a phone.

## Features

- **Tell queued runs apart.** Each row shows the workflow name, when it was
  queued, a colour stripe per workflow, the input images, and colour-coded chips
  for the key settings: sampling (steps, CFG, sampler, …), time (duration,
  frames, FPS), active LoRAs with their strength, and size (aspect ratio,
  megapixels, width×height). **Bright chips differ from the workflow's other
  queued runs; dimmed ones are the same for all of them.** Images follow the
  same rule.
- **Detail card.** Hover a row (desktop) or tap it (touch) to see every input
  image, all settings, the seeds and the full prompt. When runs of a workflow
  have different prompts, the shared part is greyed out and the box scrolls to
  where they start to differ.
- **Edit queued runs in place.** Click ✎ to open a queued run in its own tab,
  change anything, and press **Update queued run**. The run keeps its place in
  the queue. If other queued runs of the same workflow still have the old values,
  you can copy the change into them in one go. Each keeps its own seed, image
  and other values. The change can also go back into the workflow you queued
  from: its open tab (you save it) or, when it isn't open, its saved file.
- **Reorder, pause, delete.** Drag rows to reorder (runs keep their IDs), pause
  the queue while the current run finishes, delete single runs.
- **History.** The *History* tab lists the last 200 finished runs, newest first,
  with the same rows as the queue plus the first output, a ✓ / ✕ / ⏹ status mark,
  finish time and duration. The detail card shows every output and, for a failed
  run, the error. Queue a run again with ⤴ (same settings, same seed) or remove it
  with ✕. Filter by status, workflow or text in the prompts; pin a run with ☆ to
  keep it beyond the 200. The history survives restarts.
- **Gallery and viewer.** ▦ in the *History* tab shows the finished runs as a
  grid, one tile per run with its first output (+N when it has more). A tile
  opens its outputs full screen: swipe or use ‹ › / ← → between them, pinch or
  double-tap to zoom, and download the file.
- **Compare two runs.** *⇄ Compare…* in a finished run's detail card, then tap
  another run, or *⇄ vs previous* for the workflow's run before it: their
  outputs side by side, only the settings that differ, and the prompts with
  removed words struck out and added ones in green.
- **Survives restarts.** Pending and paused runs are mirrored to a local SQLite
  file. After a restart or crash they show up as *Saved from previous session*,
  where you can restore or discard them. Nothing re-runs on its own.
- **Unattended queues.** A run that fails because the GPU ran out of memory is
  queued again once, right away. With ntfy configured, a *Queue finished*
  summary arrives when two or more runs are done.
- **Time estimates.** Pending runs show when they will start (*starts ~21:10*),
  the status bar when the queue will be empty, and the running run a progress
  bar with the time left — on every device, also your phone. With the panel
  closed, the 🗂️ button shows the time left as a badge. An estimate is the median
  of the workflow's last five successful runs with the same time settings (steps,
  frames, duration, size, FPS, batch size), else of any of its runs; a workflow
  that never finished has none yet.
- **Live preview everywhere.** The running row shows the sampler preview, also
  on devices that didn't queue the run (e.g. your phone on the same server).
- **Optional push notification** via [ntfy](https://ntfy.sh) when a generation
  finishes, with the result attached.

## See it in action

**Details of a run** — every setting, seed and the full prompt

![Hover card with settings, seeds and prompt](docs/media/02-detail-card.gif)

**Reorder** — drag a run; the target row lights up red and the rows slide to their new places

![Drag and drop reorder](docs/media/03-reorder.gif)

**Edit a queued run** — the queue freezes while you edit; copy the change to the workflow's other runs and back into the workflow

![Edit in place with the queue frozen, then the Update dialog](docs/media/04-edit-freeze.gif)

**Pause** — every run keeps its place and stays editable

![Pause and resume](docs/media/05-pause.gif)

**History and variations** — finished runs with their outputs; queue a run again with new seeds

![History tab and variations](docs/media/06-history-variations.gif)

**Filters and pins** — status, workflow and text search over every stored run; ☆ keeps a run

![History filters and pinning](docs/media/07-filters-pin.gif)

**Gallery and viewer** — one tile per run, a full-screen viewer for every output

![Gallery grid and full-screen viewer](docs/media/08-gallery-viewer.gif)

**Compare two runs** — outputs side by side, the settings that differ, a word-level prompt diff

![Compare view](docs/media/09-compare.gif)

**On a phone** — long-press ⠿ to reorder, tap a run for its details, swipe through outputs

![Phone: drag, details, gallery](docs/media/10-phone.gif)

## Installation

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/SmeggyBoi/ComfyUI-QueueWorkbench
```

Restart ComfyUI, then reload the browser tab. Open the panel with the 🗂️ button
next to *Run*.

There are no Python dependencies to install.

To update, run `git pull` in the folder, restart ComfyUI and hard-reload the
browser (Ctrl+Shift+R). If the browser still runs an old copy of the script, a
red banner at the top tells you so.

## Usage

| What | How |
|---|---|
| Open the panel | 🗂️ button next to *Run* |
| See everything about a run | Hover a row (desktop) or tap it (touch) |
| Open a run as a normal copy | Click its short ID |
| Edit a run in place | ✎ on the row or *✎ Edit* in the detail card, change the graph, then **Update queued run** (or **Cancel**). While you edit, the queue is frozen: the running job finishes and nothing else starts until you update or cancel. An edit left open elsewhere shows as *FROZEN — editing #n*; **▶ Unfreeze** lets the queue go on. |
| Keep an edit in the workflow too | Tick *Also update workflow* in the Update dialog. Values you changed in the workflow since queueing are listed; tick the ones to overwrite. The open tab is marked modified (save it yourself); a closed workflow's file is saved. |
| Reorder | Drag a row onto another. On a phone: long-press ⠿ and drag, or ⤒ Move to top in the run's detail |
| Pause / resume | *Pause* in the panel header. The running job finishes; nothing else starts until you resume. Paused runs keep their places and can still be edited, moved or deleted. Every device sees the same state. |
| Restore after a restart | *Saved from previous session* section: restore one or all, or discard |
| See finished runs | *History* tab; *Show more* loads older ones |
| See finished runs as a gallery | ▦ in the *History* tab's filter bar (☰ for the list again). Tap a tile to see its outputs full screen: swipe or ‹ › / ← → between them, pinch or double-tap to zoom, ⬇ to download, Esc or a tap beside the image to close. |
| Compare two finished runs | *⇄ Compare…* in a run's detail card, then tap the other run (Esc or *Cancel* to stop), or *⇄ vs previous* for the run of the same workflow before it |
| Run a finished run again | ⤴ on its history row (same seed) |
| Run a finished run with new seeds | *🎲 New seed* in its detail card, or *🎲 ×* next to a number (1–20) for that many variations. They go to the end of the queue. |
| Duplicate a queued run with new seeds | *⧉ ×* next to a number in a pending or running run's detail card |
| Remove a run from the history | ✕ on its history row (output files stay) |
| Find a finished run | Filters at the top of the *History* tab: status, workflow, and a search over prompts and workflow names. They cover every stored run, not just the loaded ones. |
| Keep a run for good | ☆ on its history row (★ = pinned). Pinned runs are never trimmed and don't count toward the 200. |

### How editing works

- Your edit is compared with the run as it was loaded into the tab. Only the
  values you changed count, so anything you didn't touch stays exactly as it was
  queued.
- **Update** applies the edit only if the server accepts the whole graph, with
  every output valid. Otherwise you get an error naming the node, and the tab
  stays open.
- Other queued runs of the same workflow are offered only where they still have
  the *old* value. Changing a seed never spreads, while fixing a typo in a shared
  prompt reaches every run that has it.
- Adding or removing nodes or links applies to the edited run only.
- If the run starts while you're editing, you can queue your edit as a new run
  or keep the tab as a copy.

## Configuration (optional)

Push notifications are off unless you configure an ntfy topic. Copy
`config.example.json` to `config.json` in this folder and fill in:

| Key | Meaning |
|---|---|
| `ntfy_url` | Full topic URL, e.g. `https://ntfy.sh/my-secret-topic` or your own server |
| `public_url` | The address your phone uses to reach ComfyUI. If set, the notification attaches the finished file and gets a *Save* button that downloads it to your phone. |
| `ntfy_quiet_seconds` | Waits this long after the last finished run before notifying. Workflows that finish in several passes then send one notification for the final file. Default 90. The *Queue finished* summary (two or more runs) waits for the queue to stay empty this long. |
| `oom_retry` | Queue a run again once, at the front, when it fails because the GPU ran out of memory. Never twice, not while the queue is paused. Only runs queued from the ComfyUI page; runs queued by scripts or the API are left to the script. Not for VHS meta-batch runs. Default `true`. |

Environment variables `QUEUE_WORKBENCH_NTFY_URL` and
`QUEUE_WORKBENCH_PUBLIC_URL` override the file. Restart ComfyUI after changes.

### Notifications and downloads on your phone with Tailscale

The attachment in a notification is a link to your ComfyUI, so your phone has
to be able to reach it, including when you're away from home.
[Tailscale](https://tailscale.com) puts your PC and your phone in a private
network (a *tailnet*) without opening any ports to the internet.

1. Install Tailscale on the ComfyUI machine and on your phone, and sign in to
   both with the same account.
2. Make ComfyUI reachable in the tailnet. The simplest way keeps ComfyUI on its
   default `127.0.0.1:8188`, and Tailscale serves it over HTTPS:

   ```bash
   tailscale serve --bg 8188
   ```

   The first time, Tailscale asks you to enable HTTPS certificates for your
   tailnet. It then prints the address, e.g. `https://my-pc.tail1234.ts.net`.
   `tailscale serve off` stops it.

   Alternatively, start ComfyUI with `--listen 100.x.y.z` (the machine's
   Tailscale IP) and use `http://100.x.y.z:8188`, or the MagicDNS name
   `http://my-pc:8188`.
3. Put that address in `config.json`:

   ```json
   {
     "ntfy_url": "https://ntfy.sh/a-long-random-topic-name",
     "public_url": "https://my-pc.tail1234.ts.net"
   }
   ```

4. Install the ntfy app on your phone and subscribe to the same topic.

The ntfy app keeps attachments in its own storage: its *Open* button shows the
file but doesn't add it to your gallery. *Save* opens a link your browser
downloads instead of displaying, into the phone's `Download` folder (in Google
Photos under Library → Download). Firefox asks once more before every download
(*Download*), and the tab it opened for the link stays behind.

The download link only works on devices in your tailnet, so it's useless to
anyone else even when the notification goes through the public ntfy.sh server.
Still pick a long, random topic name: anyone who knows it can read your
notifications. You can also self-host ntfy on the same machine and reach it
through the tailnet. The same address also opens ComfyUI itself on your phone,
including this panel and its live preview.

## Compatibility

- Tested with ComfyUI 0.37.4 and frontend 1.52.7.
- Needs the current (Vue-based) ComfyUI frontend.
- Editing in place uses parts of the frontend's workflow-tab handling that
  aren't a public API, so a future frontend update could break it. The rest of
  the panel works independently.
- If ComfyUI wasn't restarted after installing or updating, ✎ stays hidden,
  reordering falls back to deleting and re-queueing, and the History tab can't
  load (after an update: its filters and ☆ do nothing).

## Known limitations

- Updating a run re-reads the graph, so `{a|b}` random prompt syntax is rolled
  again, as it would be on a normal re-queue. Wildcard nodes in "populate" mode
  don't re-run on update.
- A run queued with "queue selected output nodes" runs all outputs after it has
  been edited.
- Queueing a finished run again or a variation doesn't carry your Comfy.org
  login, so runs with paid API nodes fail when queued again from the history.
- Variations (🎲 / ⧉) always run with their new seeds, but the workflow saved in
  their outputs keeps the old seed where it can't find the seed's widget, e.g.
  inside a legacy group node.
- A seed fed from a plain Int *Primitive* node isn't re-rolled: its input is
  named `value`, not `seed`. Name the seed input or use a seed node instead.
- *Also update workflow* patches a tab that isn't the active one in memory only;
  reload the page before visiting it and the change is gone (the queued run keeps
  it). The same workflow open on another device updates when it is reloaded there.
- A ComfyUI restart ends Pause and edit freezes (the queue is empty afterwards; restored runs start right away).

## Privacy

Everything stays on your machine. The only network request this extension makes
is the ntfy notification, and only if you configure it. The persistence file
`queue_persist.db` (in this folder) contains your queued prompts and workflows, and those of your last 200 finished runs plus the ones you pinned. Since it keeps the full workflow of each of those runs, it can grow to tens of MB with large workflows.

## Development

```bash
node tests/test_edit_diff.mjs                 # frontend logic (Node 18+)
node tests/test_history.mjs                   # history tab logic
node tests/test_variations.mjs                # variations (new seeds)
node tests/test_compare.mjs                   # gallery, viewer and compare
python -m unittest discover -s tests -v       # backend logic (needs aiohttp)
```

The tests stub ComfyUI, so they run without a GPU or a ComfyUI install.

## License

MIT, see [LICENSE](LICENSE).
