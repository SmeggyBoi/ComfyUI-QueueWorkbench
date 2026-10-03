# Changelog

## 1.1.0

- History tab: the last 200 finished runs, newest first, kept across restarts. Same rows as the queue plus the first output, a ✓ / ✕ / ⏹ status mark, finish time and duration; the detail card shows every output and the error of a failed run.
- Queue a finished run again (same settings, same seed) or remove it from the history.
- Pending runs slide to their new place when the order changes (drag and drop, a reorder on another device, the next run starting); the run you dragged flashes briefly.
- While dragging, the row the run would move to is highlighted red (replaces the flickering drop line).
- Reorder on phones: long-press ⠿ and drag (same red target, slide and flash), or ⤒ Move to top in a pending run's detail.

## 1.0.0

First public release.

- Queue panel next to the Run button: running and pending runs, delete, pause/resume, drag to reorder (in place — runs keep their IDs).
- Tell queued runs apart: workflow name, queue time, a colour stripe per workflow, input thumbnails, and colour-coded setting chips (sampling, time, LoRA, size). Bright chips differ from the workflow's other queued runs, dimmed ones are shared.
- Detail card on hover (desktop) or tap (touch): all inputs, settings, seeds and the full prompt, with the part that differs from the other runs highlighted.
- Edit queued runs in place: open a run in its own tab, change it, and write it back into the same queue slot — optionally copying the change into the workflow's other queued runs that still have the old values.
- Queue survives restarts: pending and paused runs are mirrored to a local SQLite file and can be restored or discarded.
- Live preview in the panel, also for clients that didn't queue the run (e.g. a phone).
- Optional ntfy push notification when a generation finishes.
