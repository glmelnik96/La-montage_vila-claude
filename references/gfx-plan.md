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
  "plate": "./example_gfx/plate.mov",
  "aep": "./example_gfx/example_gfx.aep",
  "slots": [
    { "id": "LT_01", "type": "lower_third", "layer": "overlay", "in": 25, "out": 125,
      "text": { "name": "Пример имени", "role": "Ведущий" },
      "anchor": { "kind": "words", "text": "фраза из примера", "offset": -12 },
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

## Editorial types and the built-in Cloud.ru kit (v1)

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

## A local client kit

A client plan keeps version 1 and the editorial `slot.type` from the table above. Give it a
style name and a path to a local kit registry. Relative registry paths resolve from the plan's
directory. Keep the registry, client AEP, footage and fonts in the client's project. This
workflow accepts 16:9 edits, including documentaries, podcasts, product demos and edits with
finished AI shots. For a product callout, for example, a `feature_stat` role could map
`metric` and `unit` to `TXT_STAT` and `TXT_SUFFIX` in its own template.

An example `kits/portrait.json` maps the client role to a template directly under the root
`TEMPLATES` folder in the film's working AEP.

```json
{
  "version": 1,
  "style": "portrait",
  "roles": {
    "nameplate": {
      "layer": "overlay",
      "template": "Portrait label",
      "fields": {
        "name": { "target": "headline", "required": true },
        "role": { "target": "byline", "required": false }
      }
    }
  }
}
```

For example, set `"style": "portrait"` and `"kit": "kits/portrait.json"` in the plan.
Keep `sequence`, `plate` and `aep` as in the v1 example. The following slots share a visual role.
Their editorial types retain their meaning for the edit.

```json
[
  { "id": "SP_01", "type": "lower_third", "layer": "overlay", "visualRole": "nameplate",
    "in": 25, "out": 150, "text": { "name": "Анна Орлова", "role": "Редактор" } },
  { "id": "CH_02", "type": "chapter", "layer": "overlay", "visualRole": "nameplate",
    "in": 200, "out": 325, "text": { "name": "Эпилог" } }
]
```

A full-screen chapter would use a separate registered role with `layer: "insert"`. The
registry determines the required fields and target layer for each role. In this example
`name` writes to `TXT_HEADLINE` and uses the `BOX_HEADLINE` guide for overflow checks.
An omitted optional `role` clears the byline on the slot's template copy.

Before building, run `gfxplan.mjs preview` from the commands below. Each active slot lists
its ID, editorial type, layer, visual role, source template and writable fields with values.
The AE CLI provides the same JSON through `--preview`. Both commands can run with Adobe closed.
`gfxpreview.py` places a timing box over the plate according to the registered layer. Inspect exact
geometry, type and ornament on the AE capture.

For the actual build, import the approved design into a separate working AEP and prepare a
template copy directly in `TEMPLATES` with the registered name. Its top-level
`TXT_<TARGET>` layers, guide boxes, `in`/`out` markers, 1920×1080 canvas and silent audio
follow the template contract in ae-motion-live's `reference/gfx-for-edit.md`. Nested or
animated source-text controls need a template conversion on a copy before the build.
Offline preview checks the JSON declarations. AE checks the prepared composition.

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

## Reference-driven design and efficient motion review

Use this pass when matching a supplied design or revising graphics after visual feedback.

- Inspect the actual reference frames and reuse original vector assets. Record the palette,
  type weights, alignment, motif scale and edge cropping before building. A plausible new style
  can still miss the reference; successful placement and technical QA do not prove visual fidelity.
- Start with representative cases: one chapter, one speaker label over the full video frame,
  and any materially different layout. Render a short motion pilot before propagating a design
  across many comps. Existing authorization still applies; this does not add an approval gate.
- Check a speaker label with the face, subtitles and safe margins visible. Source footage is
  useful for an early study, but does not prove placement over Premiere's final reframe or grade.
  Label stand-in text/footage and check the actual timeline composite before claiming completion.
- When applying a new overlay style everywhere, inventory all overlay types as well as speaker
  labels: a chapter label over footage may share the old card design under a different type.
  Use a complete manifest across linked AEP files to verify coverage without altering accepted
  full-screen cards or historical backup sequences (live, 2026-11-03).
- For an ornament made of broad coloured bands, “draw the lines” can mean growing those bands
  at their existing width. Do not substitute thin outlines followed by a fill. For circular bands,
  reveal the original filled paths with angular masks about each arc's centre; for other bands,
  use a centreline reveal mask wide enough to cover the original shape. Keep the original asset
  stationary. A whole-pattern wipe or independent rotations change the requested motion/geometry.
- Inspect early, middle and settled frames as well as playback. Check progression along each
  band, spacing between starts, intact joins and the final match to the reference. Automatic
  centre fitting/tracing is a prototype aid: compound shapes and raster edges need visual checks.
- For varied starts, assign each element a reproducible delay, duration and easing curve once.
  Do not draw fresh random values inside `seek(t)` or per frame: previews and exports would diverge.
  When speeding up an entrance, shorten both individual durations and the overall stagger window;
  keep the settled reading hold. Cubic Bezier easing must solve its x/time coordinate, not simply
  evaluate its y coordinate at time. Any final asset swap must follow the latest element's finish.
- A deterministic HTML pilot with explicit `seek(t)` can shorten design iteration when live AE
  is unavailable. Record it as a pilot, not an installed AE/Premiere change. Port and check the
  native composition and timeline separately; a standalone preview does not verify Dynamic Link.
- When porting the pilot to AE, export the original paths together with their final transform
  matrices, per-element timings and easing parameters. Reuse shared animated precomps across slots
  instead of rebuilding hundreds of identical masks in each card. Native masks can reveal filled
  bands without changing the paths. Check intermediate renders against the pilot before batching.
- For another episode in an approved series, importing the approved AEP into a separate working
  project and duplicating its comps preserves accepted shapes, eases and element timing more
  reliably than rerunning an old builder. Inspect actual text/layers first; historical scratch
  manifests may have stale or damaged strings. After changing `TextDocument.text`, recalculate
  `sourceRectAtTime` and the text anchor, and fit long labels within the template's safe width.
  Preserve animated Position keys. Check the nameplate over the actual whole video frame,
  including subtitles, before importing only the new comp names through Dynamic Link.
- Full-screen chapter overlays can cover the picture without shifting speech/captions. An
  appended outro extends only the sequence Out. Verify the existing picture/audio/markers
  against a fresh dump and the exported dialogue sample-for-sample; a silent outro must add
  silence rather than duplicated guide audio. These checks were verified on an episodic pass
  with 12 linked comps (Premiere/AE 2026, 2026-11-12).
- Caption backing rectangles can accidentally notch a large edge ornament. Inspect the whole
  settled frame, including negative space; omit a backing shape when the caption already sits over
  clear background. Preserve archive transparency separately from decorative clipping.
- Cache reference assets and small extracted metadata. Do not dump screenshot base64 or whole
  design-context JSON into chat. If screenshot URL retrieval fails but the connector supports
  base64 image output, request that output and view the image directly.
- Keep reusable findings here as they are verified. Keep project IDs, scratch paths, rejected
- AE `TextDocument.tracking` requires an integer. When porting CSS letter-spacing, convert
  with `Math.round(letterSpacingPx / fontSizePx * 1000)`; a fractional value throws after the
  text layer has already been created. Resume the owned partial build by finding named layers,
  rather than blindly rerunning a builder that would duplicate them (live, 2026-11-03).
- Keep reusable findings here as they are verified. Keep project IDs, scratch paths, rejected
  versions and current installation status in the project note. State separately what rendered,
  what was installed, what was visually checked and what the user accepted.

## Commands

The Premiere steps run with this skill's root as cwd. The AE step runs with the ae-motion-live root
as cwd.

| Step | Command | Gives |
|---|---|---|
| open | `node scripts/propen.mjs --project <path.prproj> [--timeout 240]` | the project focused in Premiere, no clicks |
| hand over | `node scripts/gfxexport.mjs --seq-id <id> --dir <project folder>/<sequence>_gfx [--no-words] [--lang ru] [--model large-v3]` | `plate.mov`, `edit.json`, `words.json`, and a started `gfx-plan.json` if there was none |
| check the plan | `node scripts/gfxplan.mjs validate --plan <dir>/gfx-plan.json --edit <dir>/edit.json` | `{ ok, errors, warnings }` |
| preview mappings | `node scripts/gfxplan.mjs preview --plan <dir>/gfx-plan.json [--only A,B]` | JSON with resolved roles, template names and editable fields |
| preview mappings (AE root) | `node scripts/gfx-build.js --plan <dir>/gfx-plan.json --preview [--only A,B]` | the same mapping report, offline |
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
