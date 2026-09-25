# premiere-autopilot

A Claude skill that edits in a **live** Adobe Premiere Pro. Claude makes the editorial
decisions. The CLI helpers here apply them to the running app over CDP, via the LLM-Chat_Pr
CEP panel, and check the result by rendering frames and audio. Optional AI assets come from
the Phygital sidecar.

## Workflows

| | Input → deliverable | Details |
|---|---|---|
| A | Podcast or interview → highlight cut, chapters, reels | SKILL.md |
| B | Lecture + its deck → working copy with slides on V2 and review markers | SKILL.md |
| C | Flattened multicam master → vertical reels | `references/vertical-reels.md` |
| D | Screen-shared lecture → one sequence per slide | `references/slide-blocks.md` |
| E | Reviewer notes → corrected edit → episodes | `references/review-to-edit.md` |
| F | Raw interview day → selects per speaker with question cards | `references/interview-selects.md` |
| G | Cameras + a separate recorder → one synced stack | `references/multicam-sync.md` |
| H | Documentary canvas: interview pieces, B-roll, graphics, subtitles | SKILL.md |
| I | After Effects graphics over an edit: plan → preview → AE build → Dynamic Link → check | `references/gfx-plan.md` |

Where to read more:
- [`SKILL.md`](SKILL.md): the skill itself, with the workflows, the rules by topic and the
  payload contracts.
- [`AGENTS.md`](AGENTS.md): the entry point for any coding agent.
- `references/panel-api-notes.md`: the host API.
- `references/prompting.md`: prompts for the generative slots.

## Layout

| Path | What |
|---|---|
| `scripts/` | The helpers; each script's header comment documents its flags |
| `scripts/lib/` | CDP bridge, config, the shared Cloud.ru ASR client |
| `references/` | One file per technique |
| `docs/` | The original design spec and plan, and audit notes |
| `gen-out/` | Per-session scratch (gitignored) |
| `projects/` | Local notes per client project (gitignored, never pushed) |

## Setup

1. Open Premiere with the **"ИИ: монтаж"** panel (LLM-Chat_Pr). It exposes CDP on port 8098.
2. Point `config.json` at your local paths:
   - `cdpPort`;
   - the two upstream repos;
   - the transcript cache;
   - the sidecar's URL, token, app dir and Python.
3. Check: `node scripts/preflight.mjs` must report `ready:true`.
4. For paid generation only: log in to Phygital once
   (`python -m scripts.cli auth login` in Phygital-Adobe-Studio/sidecar), then run
   `preflight.mjs --gen`.

## Safety

- Always work in a **duplicate** sequence, never the original.
- Never run a paid generation without `--dry-run` and the user's explicit yes.
- Do not edit the two upstream repos (LLM-Chat_Pr, Phygital). Use the `evalJson` escape hatch
  instead.
- **Verify** every deliverable on rendered pixels and sound. Numbers are not enough.
