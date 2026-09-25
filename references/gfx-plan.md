# The graphics plan (`gfx-plan.json`)

This is the one description of the plan that joins the two halves of a graphics pass. This skill
writes and checks the plan; ae-motion-live builds from it (see `reference/gfx-for-edit.md` there).
Workflow I in SKILL.md says when each step runs; `references/after-effects-link.md` has the Dynamic
Link traps.

## Files of one film

Each sequence gets a folder `<sequence>_gfx/` next to the `.prproj`. In the name, each of
`\ / : * ? " < > |` becomes `_`. The folder never moves: Dynamic Link keeps the absolute path of the
`.aep`. The `.aep` is `<sequence>_gfx.aep`, and its file name must be unique within the project.
Premiere names each linked item `<comp>/<aep file name>`, and `gfxplace.mjs` finds items by that
name. `gfxexport.mjs` names both the folder's .aep and the plan's paths this way: when the folder
has no `gfx-plan.json` yet, it starts one with `sequence`, `plate`, `aep` and an empty `slots`.

| File | Written by | What |
|---|---|---|
| `plate.mov` | `gfxexport.mjs` | the edit as it plays, WITHOUT linked graphics (AE's guide layer). After a re-edit it can be `plate.b.mov`: AE holds `plate.mov` open, so the new render takes the other name. `edit.json` and the plan name the current file. |
| `edit.json` | `gfxexport.mjs` | the sequence in whole frames: size, fps, clips, markers |
| `words.json` | `gfxexport.mjs` | `[{w, s, e, p}]` in seconds of the sequence. A run with `--no-words` moves an old one to `words.prev.json`, because its times belong to the earlier cut. |
| `gfx-plan.json` | `gfxexport.mjs` starts it, Claude fills in the slots | the plan (below) |
| `preview.mp4`, `preview_sheet.png` | `gfxpreview.py` | boxes over the plate, for approval |
| `<sequence>_gfx.aep`, `qa/` | ae-motion-live `gfx-build.js` | the comps, the QA frames |
| `gfx-state.json` | `gfxplace.mjs` | chosen tracks and placed slots |
| `check.mov`, `check_sheet.png`, `check.json` | `gfxcheck.mjs` | the sequence as rendered, one frame per slot, levels |

## Format

```json
{
  "version": 1,
  "sequence": { "id": "<sequenceID>", "name": "Интервью", "fps": 25, "w": 1920, "h": 1080, "frames": 7500 },
  "style": "cloudru",
  "plate": "D:/Проект/Интервью_gfx/plate.mov",
  "aep": "D:/Проект/Интервью_gfx/Интервью_gfx.aep",
  "slots": [
    { "id": "LT_01", "type": "lower_third", "layer": "overlay", "in": 25, "out": 125,
      "text": { "name": "Иван Петров", "role": "CTO, Cloud.ru" },
      "anchor": { "kind": "words", "text": "меня зовут Иван Петров", "offset": -12 },
      "why": "первое появление спикера" }
  ]
}
```

- **`sequence`** is copied from `edit.json`. A plan made for another cut (different id or frames)
  is refused.
- **`in` / `out`** are whole frames of the sequence, with `out` excluded. Fractions are refused:
  Premiere rounds a half frame up, AE keeps it, and the two would disagree.
- **`id`** matches `^[A-Z][A-Z0-9_]{1,39}$`. It names the AE comp and the Premiere item
  `<id>/<aep file>`.
- **`layer`** is one of:
  - `overlay`: over the picture;
  - `logo`: on its own track, may span the film;
  - `insert`: full screen, with the edit's sound running under it.
- **`anchor`** says what the slot belongs to, so it can be found again after a re-edit
  (`gfxresync.mjs`):
  - `words`: a phrase of `words.json`. `in` = anchor frame + `offset`.
  - `marker`: a sequence marker, by name. `in` = marker frame + `offset`.
  - `time`, or no anchor: the slot follows its own placed clip(s), which the ripple tools move. A
    clip that a ripple split is re-joined over its span.

  After a re-edit, `words` and `marker` slots keep their length. A slot whose anchor was cut gets
  `lost: true` and is not placed, but it is never deleted.
- **Several lines of text**: put `\n` inside the string (AE gets `\r`).

## Types (v1)

| type | layer | fields (`?` = optional) | in the chat table | planner's minimum |
|---|---|---|---|---|
| `lower_third` | overlay | name, role | плашка | 3 s |
| `quote` | overlay | quote, author? | ключевая мысль | 3.5 s |
| `callout` | overlay | value, caption? | выноска | 3 s |
| `logo` | logo | — | логотип | 3 s |
| `chapter` | insert | title, subtitle?, number? | карточка главы | 3 s |
| `intro` | insert | title, subtitle? | заставка | 3.5 s |
| `outro` | insert | title, subtitle? | концовка | 3.5 s |

AE checks the exact minimum from the template (entrance + exit + 1.5 s to read) and checks the text
against the template's boxes. The limits in this table only stop a plan that cannot work; they are
set to the Cloud.ru kit's own minimums, rounded up.

## Where graphics go (defaults; the task overrides them)

- **Lower third:** on each speaker's first appearance. The name and role come from the transcript
  or the task. When neither has them, ask in the plan (write `?` in the table).
- **Chapter card:** where the topic changes, on the same chapters that Workflow A §5 / B §4 set as
  markers.
- **Key thought:** on the most quotable lines, at most one every 1–2 minutes.
- **Callout:** on a figure or a term the speaker names.
- **Never within 0.5 s of a cut, never over a face.**
  - `gfxplan.mjs validate` warns about any slot edge within 0.5 s of a cut, on every video track.
    Through edits do not count as cuts.
  - An insert may sit exactly on a cut. "At 12 s" means the nearest cut: a card placed 0.4 s after
    a cut flashes the new shot first.
  - Check faces on the preview sheet, and again on the AE QA frames.
- **`why` gives the reason, never the time.** Write «на склейке, где начинается итог». Do not write
  «на склейке 11.6 с»: after a resync the slot moves and the time goes stale. The table shows the
  time already.
- **After each film**, turn the corrections the user made to the plan into rules here (no client
  names).

## Commands

The Premiere steps run with this skill's root as cwd. The AE step runs with the ae-motion-live root
as cwd.

| Step | Command | Gives |
|---|---|---|
| open | `node scripts/propen.mjs --project <path.prproj> [--timeout 240]` | the project focused in Premiere, no clicks |
| hand over | `node scripts/gfxexport.mjs --seq-id <id> --dir <project folder>/<sequence>_gfx [--no-words] [--lang ru] [--model large-v3]` | `plate.mov`, `edit.json`, `words.json`, and a started `gfx-plan.json` if there was none |
| check the plan | `node scripts/gfxplan.mjs validate --plan <dir>/gfx-plan.json --edit <dir>/edit.json` | `{ ok, errors, warnings }` |
| chat table | `node scripts/gfxplan.mjs table --plan <dir>/gfx-plan.json` | markdown table |
| preview | `python scripts/gfxpreview.py --plan <dir>/gfx-plan.json --out <dir>/preview.mp4 --sheet <dir>/preview_sheet.png` | video + sheet for approval |
| build (AE) | `node scripts/gfx-build.js --plan <dir>/gfx-plan.json [--only A,B] [--refresh-plate] [--rebuild-kit] [--no-capture]` | comps, `.aep` saved, `qa/sheet.png` |
| place | `node scripts/gfxplace.mjs --plan <dir>/gfx-plan.json [--prune]` | linked clips on their frames, `gfx-state.json`; `orphans`: clips of the .aep whose slot left the plan, removed only with `--prune` |
| check | `node scripts/gfxcheck.mjs --plan <dir>/gfx-plan.json [--tol 0.5]` | `check_sheet.png`, the level under every overlay |
| after a re-edit | `node scripts/gfxresync.mjs --plan <dir>/gfx-plan.json --dry-run`, read `moved`/`lost`/errors, then `--apply`. Then build with `--refresh-plate --no-capture`, then place + check. Place after the build: a slot that grew needs the longer comp first. | re-anchored plan (the old one kept as `gfx-plan.prev.json`) |

A dry run writes `gfx-plan.resync.json` and replaces nothing. So does a resync that does not
validate: typically a cut through a time-anchored slot left it shorter than its type's minimum.
Fix that file by the rules below, check it with `gfxplan.mjs validate`, then run
`gfxresync.mjs --apply`. `--apply` installs the file against the `edit.json` just written, with
no second render. Tell the user which slots moved and which one you changed by hand.

To take a graphic out after placement, delete its slot from the plan, then run place with
`--prune`. Its comp stays in the .aep, unused. Without `--prune`, place only reports the orphan.

A failed level check means a linked comp carries sound, and the dialogue plays twice: about +6 dB
under the slot whose comp has it. Long slots over it, such as the logo, rise less. Run place again: it
strips the audio of every clip from the .aep. Then check again. Muting the audio in AE does not reach
Premiere (`references/after-effects-link.md`).

The approval steps are to validate, print the table, render the preview, then send the table, the
sheet and the video to the chat and wait for «ок» or corrections. The user can skip approval by
writing «без согласования» in the task.
