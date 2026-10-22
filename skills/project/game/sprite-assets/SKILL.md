---
name: sprite-assets
description: Generate 2D game sprites, icons and effect sheets with image generation, then clean them with the generate2dsprite processor. Use for asset tasks (images: true) in game repos.
---

> **harnessOrch note:** you run unattended inside an engine-managed task with image generation enabled. Where this skill says to ask, decide yourself and record the decision in your result's `decisions`. Stay inside your write scope and run checks with hverify. This is a condensed version of the Codex `generate2dsprite` skill; its processor lives at `C:/Users/Hung/.codex/skills/generate2dsprite/scripts/generate2dsprite.py`.

# Sprite assets

Make the asset the task asks for, matching the repo's art spec, and leave raw renders, processed frames and metadata where the task says. The project's own scripts turn your output into final game files.

## 1. Read the project's rules first

- The repo's art spec (often `.game-dev/art-spec.md`) wins over this skill: palette, outline, pixel density, view, forms, file names, delivery folder.
- If the task names a style reference image (or the art spec does, e.g. an approved character), pass it to image generation as the reference for every image.

## 2. Generate the raw image

- Background: **solid flat magenta `#FF00FF`**, nothing else touching it. No shadows, ground, text, frames or watermark.
- Pixel-art requests: crisp hard pixels, flat fills, at most three tones per material, light from the upper left, a dark outline around the subject.
- One raw image is one thing: a single sprite, or one action/one turnaround as a grid. Never mix unrelated actions in one sheet.
- Grids: equal cells, one pose per cell, the subject centred with clear magenta margin on every side, the same scale and the same feet line in every cell.
- Characters made of floating parts ("puppets": body plus separate hands and feet): keep a clear magenta gap (about 24 px at 1024 px) between every part. Parts must not touch.
- Icons: one object, centred, filling about 80% of a square canvas, readable at 32 × 32.
- Seamless textures: opaque, full-bleed, no border, no central motif; check by tiling 2 × 2.
- Save the raw image into the delivery folder (e.g. `raw.png`).

## 3. Process it

Run from the repo root (Python 3 with Pillow and NumPy):

```
python C:/Users/Hung/.codex/skills/generate2dsprite/scripts/generate2dsprite.py process \
  --input <delivery>/raw.png --output-dir <delivery> \
  --target <player|creature|prop|projectile|impact|fx> --mode <single|idle|walk|attack|turnaround|impact|projectile> \
  --rows <r> --cols <c> --cell-size 256 --fit-scale 0.82 \
  --align <feet|center> --component-mode <largest|all> \
  --godot-world-height <final height px / pixels per metre>
```

- `--align feet` for anything standing on the ground; `center` for effects, pickups and icons.
- `--component-mode all` for puppets and anything made of separate pieces (otherwise only the largest piece survives); `largest` for single solid subjects.
- `--scale-strategy preserve` for a character sheet where a long weapon or pose would otherwise shrink the body; `fit` (default) for creatures, props and effects.
- `--godot-world-height` writes `godot-sprite3d.json` (frame list, origin, pixel size). Game repos read it; always supply it for world sprites, never for icons or textures.
- Add `--strict-qc` and fix what it reports. Do not use `--allow-source-edge-touch` unless you looked at the image and the subject is complete.

Outputs land in the output dir: the frames (`single-1.png`, `turnaround-1.png`, …), `sheet-transparent.png`, `pipeline-meta.json`, `qc-metrics.json`, `animation.gif`, and `godot-sprite3d.json` when requested.

## 4. Check your own work

1. Open `sheet-transparent.png` and every frame. The subject is whole, nothing clipped, no magenta fringe, no stray specks.
2. Silhouette test: imagine the sprite filled black at its final size; it must still read as what it is.
3. Puppets: count the pieces in every frame (body, two feet, the hands). A missing hand in a side view is fine; merged pieces are not: regenerate with wider gaps.
4. Same scale and feet line across frames of one sheet.
5. Run the task's checks (usually the project's snap/import script for this key), then look at what it produced.

Regenerate rather than patch when the subject is wrong. After two failed attempts, report `blocked` with the reason instead of delivering a bad asset.

## 5. Deliver

- Write only inside the delivery folder and the files the task's write scope allows.
- In your result, list every file you produced and anything unusual (sheet layout, frame count, a pose that hides a part).
