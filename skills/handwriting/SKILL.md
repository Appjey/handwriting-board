---
name: handwriting
description: >-
  Generates realistic personal handwritten images (transparent 3x PNG or vector SVG)
  in the user's calibrated Noteshelf 3 handwriting style (Latin, Polish/French diacritics,
  Russian Cyrillic, digits, punctuation) with configurable writing speed/hurry (0 = neat,
  0.5 = everyday, 1.0 = rushed). Use when the user asks to write notes, homework, poems,
  or text by hand, export transparent handwritten overlays for Noteshelf/GoodNotes/docs,
  or open the standalone interactive handwriting board.
---

# Personal Handwriting Skill

This skill renders text in the user's calibrated monoline Noteshelf 3 handwriting style using a zero-dependency Node.js script ([scripts/render.mjs](./scripts/render.mjs)) and ships a standalone interactive HTML board ([resources/board.html](./resources/board.html)).

## Prerequisites

- **Node.js 18+** (uses only built-in `node:fs`, `node:path`, `node:zlib` — no `npm install` needed).

## Quick Workflow: Render Handwritten PNG or SVG

1. For multi-line text or text with quotes/Polish/Russian characters, write the text to a temporary UTF-8 file first so shell escaping never corrupts diacritics (`ą, ć, ę, ł, ń, ó, ś, ź, ż`).
2. Run [scripts/render.mjs](./scripts/render.mjs) from the skill folder:

   ```bash
   node <skill-dir>/scripts/render.mjs --in note.txt --out note.png --hurry 0.5 --bg transparent
   ```

   For short one-liners:

   ```bash
   node <skill-dir>/scripts/render.mjs --text "Cześć!\nMam na imię Anton." --out greeting.png
   ```

3. The script prints a JSON summary (`out`, `format`, `width`, `height`, `hurry`, `seed`, `strokes`) and writes a **3× retina, tightly auto-cropped PNG with transparent background** by default.
4. Visually inspect the generated PNG (if an image-reading tool is available) to verify line wrapping, legibility, and proportions before handing it to the user.

## Key Options

| Flag | Default | Description |
| :--- | :--- | :--- |
| `--text <str>` | — | Inline text (`\n` supported); alternatively use `--in <file>` or pipe stdin |
| `--in <path>` | — | Read UTF-8 text from a file (recommended for long/multilingual text) |
| `--out <path>` | `handwriting.png` | Output path; `.png` renders raster RGBA, `.svg` renders lossless vector |
| `--hurry <0..1>` | `0.5` | `0` = neat careful (`v4-neat`), `0.5` = everyday hurried, `0.8–1.0` = fast rushed notes |
| `--bg <kind>` | `transparent` | `transparent` (for pasting into Noteshelf/docs), `paper` (dot-grid), `white`, `notebook`, `lined` |
| `--size <16..96>` | `28` | Base letter size in board pixels (`22–26` for dense notes, `28–34` for medium, `40+` for titles) |
| `--color <hex\|name>` | `#18349c` | Ink color (`#18349c` Noteshelf blue, or `blue`, `black`, `red`, `green`) |
| `--pen <kind>` | `ballpoint` | `ballpoint` (uniform monoline, default), `fountain` (pressure taper), `marker`, `pencil` |
| `--width <200..2400>` | `1040` | Max line wrap width in px before auto-wrapping |
| `--scale <1..4>` | `3` | PNG resolution multiplier (automatically clamped under 4500 px max edge) |
| `--padding <0..200>` | `24` | Margin around cropped strokes in board pixels |
| `--seed <int>` | random | Reproducible seed; omit or change to get a fresh allograph variation |

## Recommended Presets

- **Neat careful writing** (homework / clean sheet): `--hurry 0 --size 27 --bg transparent`
- **Everyday Noteshelf 3 notes** (default): `--hurry 0.5 --size 27 --bg transparent`
- **Fast rushed notes**: `--hurry 0.75 --size 26 --bg transparent`
- **Full dot-grid page preview**: `--hurry 0.5 --bg paper`

## Standalone Interactive Board (No AI Needed)

If the user wants to type, tweak the live **Спешка** slider (`0%–100%`), shuffle variants, or copy transparent PNGs manually without invoking the agent, point them to [resources/board.html](./resources/board.html) — it opens directly in any browser with zero backend.
