# AGENTS.md

Instructions for any coding agent working in this repository (Claude Code, Cursor,
Codex, Copilot). Read this first.

## What this repo is

`premiere-autopilot` — tooling that drives a **live, already-open Adobe Premiere Pro**
through the LLM-Chat_Pr CEP panel over CDP port 8098. It does not render or export
video itself; it makes editorial decisions and applies them to the running app.

**Start by reading [`SKILL.md`](SKILL.md).** It holds the workflows, the CLI payload
contracts and the non-obvious constraints. `references/vertical-reels.md` has the
multicam→vertical-reel technique in full.

## Non-negotiables

1. **Every operation mutates the user's live project.** There is no dry run and no
   undo stack you control. Take a backup (`node scripts/pr.mjs backup`, record the
   returned `backupId`) before the first mutating call, and confirm with the user
   before anything destructive.
2. **Check which project is focused first.** `app.project` is whatever Premiere has
   focused right now. If several projects are open, ask the user to close the others
   rather than guessing which one they meant.
3. **Work in duplicates. Never edit the source sequence.** Clone it, edit the clone,
   leave the original as the backup.
4. **`gen-out/` is gitignored scratch.** Whatever you find there belongs to a previous
   session on a different project. It is evidence, not method — never build a plan on
   it and never assume it will exist.
5. **A bridge timeout is not a failure.** The edit keeps running inside Premiere after
   the call gives up. Poll for the result; re-issuing applies the edit twice.
6. **Verify on pixels, not on numbers.** The panel cannot return a rendered frame, so
   re-derive every visual claim from the source media with ffmpeg and look at it.
7. **Confirm before removing anything.** Deleting intermediate `_wip` sequences,
   restoring a backup over current work or clearing a bin are destructive, and none of
   them are implied by a request to produce an edit. Leave intermediates and ask.
8. **Do not commit without the user asking.** Do not edit the two upstream source repos.

## Environment

- Node ≥ 18, `ffmpeg` and `ffprobe` on PATH. No install step; there are no dependencies.
- `node scripts/preflight.mjs` — run it first; do not proceed unless `ready:true`.
- Shell is bash (Windows). Use forward slashes and quote paths containing spaces or
  Cyrillic.

## Tools

| Command | Purpose |
|---|---|
| `scripts/preflight.mjs` | Check panel + auth are live |
| `scripts/pr.mjs` | `snapshot backup transcribe cut markers reframe overlay import activate` |
| `scripts/audio.mjs` | RMS envelope / pause detection / cut-boundary check |
| `scripts/shots.mjs` | Contact sheet of the active sequence's shots; crop probe |
| `scripts/vframe.mjs` | 9:16 reframe arithmetic and plan builder |
| `scripts/checkreframe.mjs` | Invert stored Motion values back to pixels and tile them |
| `scripts/gen.mjs` | Paid generation — always `--dry-run` and confirm first |
| `scripts/cloudtr.mjs` | Cloud transcription split at the clip's own pauses (no dropped windows, cuttable edges) |
| `scripts/cloudsplit.mjs` | Find a cut inside a phrase: the pause after a given word, by cloud-transcribed prefixes |
| `scripts/cloudedges.mjs` | Read the head and tail of every piece back through the cloud model |
| `scripts/mogrtcard.py` | Editable title cards: one .mogrt per card from Premiere's Basic Title |
| `scripts/_ev.mjs` | Evaluate ExtendScript in the Premiere host |
| `scripts/_pev.mjs` | Evaluate JS in the panel's DOM context |

`scripts/_ev.mjs` runs **ES3**. No arrow functions, no `let`/`const`, no template
literals, no `Array.prototype.find`/`forEach`/`map` — use plain `for` loops. And
`short`, `int`, `class`, `enum`, `char` and friends are reserved words that cannot appear
even as object-literal keys. All of these fail at parse time with an opaque
`EvalScript error`, with no line number, that `try/catch` cannot intercept.
