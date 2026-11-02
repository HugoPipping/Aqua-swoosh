# Aqua-swoosh
A moving homage to the OS X Panther Aqua swooshy desktop image.

Soft, translucent 3D sheets undulate, twist and tumble slowly while the camera drifts down
through them, like diving into a calm whirlpool. Everything lives in a single, dependency-free
`index.html` (WebGL 1) — open it in a browser, no build step.

## Using it

Move the mouse to reveal the ⚙ button, or press **H**, to open the control panel.

| Key | Action |
| --- | --- |
| H | Show / hide the panel |
| Space | Pause |
| F | Fullscreen |
| R | New random seed |
| S | Snapshot PNG at the capture size |
| P | FPS / vertex-count meter |
| W | Wireframe overlay |
| C | Copy the exact scene state (settings + every sheet) — for bug reports |

- **Every slider** has a number box for exact values, and a `⋯` menu to set its range and turn on
  **drift** (the value sweeps slowly back and forth through that range).
- **Presets**: built-in looks plus your own (saved in the browser). *Copy link* stores all settings
  in the URL; *Copy settings* / *Paste settings* exchange them as JSON (a `C` capture pastes back in
  paused on that exact frame).
- **Capture**: PNG snapshots at any size (5K by default), and WebM/MP4 recording; enable
  *Fixed render size* to record at an exact resolution.
- Add `?clean` to the URL to hide the UI entirely (wallpaper / screensaver use).

## How it works

- Each sheet is a ribbon whose heading turns along its length, so curves can loop back on themselves.
  Sheets live at real depths; the camera dives through them and passed sheets are recycled into
  the distance.
- **View-dependent adaptive tessellation**: every frame the CPU traces each ribbon, scores where it
  needs detail on screen (size, folds, sharply turning edges, the camera plane) and places mesh
  columns accordingly; the GPU builds the actual vertices from one small record per column
  (instanced row strips). A fold guard narrows ribbons smoothly where a bend is tighter than the
  sheet is wide, so a sheet never folds through itself.
- Shading is per pixel: exact surface normals, Fresnel transparency, glossy highlights, edge glints,
  and distant sheets dimmed and tinted by the sky behind them.
