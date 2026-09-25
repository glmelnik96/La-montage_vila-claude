# AGENTS.md

Instructions for any coding agent working in this repository (Claude Code, Cursor,
Codex, Copilot). Read this first.

## What this repo is

`premiere-autopilot` is tooling that drives a **live, already-open Adobe Premiere Pro**
through the LLM-Chat_Pr CEP panel over CDP port 8098. It makes editorial decisions, applies
them to the running app, and checks the result by rendering frames and audio.

**Start by reading [`SKILL.md`](SKILL.md).** It holds:
- the workflows, A–I;
- the rules by topic;
- the payload contracts.

Each workflow names the `references/*.md` file with its full technique. Read only the one the
task needs.

## Non-negotiables

1. **Every operation mutates the user's live project.** There is no dry run and no undo stack
   you control. Take a backup (`node scripts/pr.mjs backup`, record the `backupId`) before the
   first mutating call, and confirm with the user before anything destructive.
2. **Check which project is focused first.** `app.project` is whatever Premiere has focused
   right now. If several projects are open, ask the user to close the others rather than
   guessing which one they meant.
3. **Work in duplicates. Never edit the source sequence.** Clone it, edit the clone, and leave
   the original as the backup. Note that `pr.mjs backup` refocuses the original.
4. **Two folders are gitignored:**
   - `gen-out/` is scratch from other sessions and other projects. Treat it as evidence, never
     as method.
   - `projects/` holds local notes, one per client project, and is never pushed. Read
     `projects/INDEX.md`, then only the note of the project in front of you.
5. **A bridge timeout is not a failure.** The edit keeps running inside Premiere. Poll a cheap
   read until the host answers; re-issuing applies the edit twice.
6. **Verify on pixels and by ear, not on numbers.** Render frames and audio from the sequence
   (SKILL.md, «Rendering and looking»), crop the source for reframes, and look at the timeline
   panel.
7. **Confirm before removing anything.** Deleting intermediate `_wip` sequences, restoring a
   backup over current work and clearing a bin are all destructive. None of them is implied by
   a request to produce an edit. Leave intermediates and ask.
8. **Do not commit without the user asking.** Do not edit the two upstream source repos.

## Environment

- Node ≥ 22: `scripts/lib/cdp.mjs` uses the global `WebSocket`. There are no npm
  dependencies.
- `ffmpeg` and `ffprobe` on PATH.
- Python 3 for the `.py` tools:
  - numpy and Pillow;
  - PyMuPDF for decks;
  - faster-whisper for local transcription.
- `node scripts/preflight.mjs`: `ready:true` means the panel answers, which is all an edit
  needs. `--gen` also checks the Phygital sidecar, which only paid generation uses.
- The shell is bash on Windows. Use forward slashes, and quote paths that contain spaces or
  Cyrillic.

## Tools

Every script's header comment documents its flags. SKILL.md says which workflow uses which.
- **Premiere:** `pr.mjs` (snapshot, backup, transcribe, cut, markers, reframe, import,
  overlay, activate), `_ev.mjs` (host JSX from a file), `_pev.mjs` (JS in the panel).
- **Timeline:** `assemble`, `rearrange`, `ripplecut`, `placestills`, `trackorder`,
  `markercolors`, `fillmono`, `blockcut`.
- **Audio and transcription:** `audio`, `scan`, `mixdown`, `transcribe_local.py`,
  `transcribe_mixed.py`, `rewin.py`, `splicecheck.py`, `cloudtr`, `cloudsplit`, `cloudedges`,
  `subcues`.
- **Picture:** `shots`, `vframe`, `checkreframe`, `planpreview.py`, `prwindow.ps1`, and the
  slide tools (`slidetrack.py`, `slidealign.py`, `planverify.py`, …).
- **Generation (paid):** `gen.mjs`. Always run it with `--dry-run` first and get the user's
  yes.
- **Graphics (AE), Workflow I, `references/gfx-plan.md`:**
  - `propen.mjs`: opens a project with no clicks from the user;
  - `gfxexport.mjs`: writes the plate, `edit.json` and `words.json`;
  - `gfxplan.mjs`: validates a plan and prints its chat table;
  - `gfxpreview.py`: draws the plan's boxes over the plate;
  - `gfxplace.mjs`: imports the AE comps through Dynamic Link, places them by frame and strips
    their audio;
  - `gfxcheck.mjs`: renders the sequence, takes one frame per slot and compares the level under
    the overlays;
  - `gfxresync.mjs`: runs after a re-edit;
  - `scripts/win/*.ps1`: captures windows, clicks by name (guarded) and fills a file dialog.
- **Tests:** `node --test "scripts/tests/*.test.mjs"`. Pass a glob: a directory argument fails on
  Node 24.

Host code is **ES3** (SKILL.md, «Host scripting»). Arrow functions, `let`/`const`, template
literals, `Array.prototype.forEach`/`map`/`find`, and reserved words used as keys all fail at
parse time with an opaque `EvalScript error` that `try/catch` cannot intercept.
