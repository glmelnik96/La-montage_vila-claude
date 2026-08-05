# premiere-autopilot

A Claude skill that drives a **live** Adobe Premiere Pro session to produce a turnkey montage.
Claude makes the editorial decisions; the CLI helpers here execute them against the running app
over CDP via the LLM-Chat_Pr CEP panel, and generate assets via the Phygital sidecar.

## Two workflows

- **A — podcast/interview** → highlight cut, chapter markers, 3–5 vertical reels, optional
  AI b-roll/cover/voiceover inserts.
- **B — lecture/talk + slide deck** → working duplicate with the deck laid over the speaker on V2,
  green section markers and red delete-candidate markers, all mapped from the transcript by content.

Full instructions live in [`SKILL.md`](SKILL.md).

## Layout

| Path | What |
|---|---|
| `SKILL.md` | The skill itself — workflows, payload contracts, safety rules, E2E checklist |
| `references/panel-api-notes.md` | Live-verified host API contracts, the `evalJson` escape hatch, known no-ops and missing methods |
| `references/prompting.md` | Prompt templates for generative image/video/voice slots |
| `scripts/pr.mjs` | Premiere operations: snapshot, backup, transcribe, cut, markers, reframe, import, overlay |
| `scripts/gen.mjs` | Generative assets (always `--dry-run` + user confirmation first — costs credits) |
| `scripts/preflight.mjs` | Checks the panel is up and auth is done |
| `scripts/_ev.mjs` | Run an arbitrary host ExtendScript (JSX) file |
| `scripts/_pev.mjs` | Eval JS in the panel (DOM) context |
| `scripts/_poll_cache.mjs` | Poll the transcript cache until a sequence is transcribed |
| `docs/` | Design spec and implementation plan |
| `gen-out/` | Per-session scratch (gitignored) |

## Setup

1. Open Premiere with the **"ИИ: монтаж"** panel (LLM-Chat_Pr) — exposes CDP on port 8098.
2. Authenticate the Phygital sidecar once: `python -m scripts.cli auth login`.
3. Point `config.json` at your local paths (CDP port, sidecar URL, transcript cache, sidecar token).
4. Verify: `node scripts/preflight.mjs` — do not proceed unless `ready:true`.

## Safety

- Always work in a **duplicate** sequence, never the original.
- Never run a `cut` without a backup; `pr.mjs cut` additionally guards against overlapping,
  out-of-bounds and over-aggressive plans.
- Never run paid generations without `--dry-run` and explicit user confirmation.
- Do not edit the two upstream source repos (LLM-Chat_Pr, Phygital) — use the `evalJson`
  escape hatch instead.
- **Visually validate** every visual deliverable before calling it done. Numbers are not enough.
