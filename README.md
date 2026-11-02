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

## Lite mode (as a background)

`lite/` is a cut-down engine meant to sit behind something heavier, such as a rain simulation.
Same sheets and motion, but:

- **Fixed mesh**: each sheet is an even grid (`columns` × `rows`, default 72 × 12), so the CPU only
  traces each ribbon at a few dozen points per frame (roughly a tenth of the full engine's work), and
  the columns never slide, so nothing stutters.
- **Low resolution + blur**: renders at `scale` × the screen resolution (default 0.33, about a ninth
  of the pixels), blurs there (`blur`, in render pixels), and lets the browser upscale smoothly.
- **Frame-rate cap**: `fps` (default 30); the motion is slow enough that 20–30 is plenty.
- **Transparent mode**: `sky: false` draws only the sheets, to layer over an existing backdrop.
  The sky colours (`bgTop`, `bgBottom`, `glow`) still tint the distant sheets, so set them to match.
- **Optional separate thread**: `worker: true` draws through an OffscreenCanvas in a Web Worker.
  Off by default: a host that already keeps every core busy gains little from one more thread, and
  the page-thread cost is small.

```js
import { mountAquaLite } from "./lite/mount.js";
const sheets = mountAquaLite(document.body, { scale: 0.33, blur: 1, fps: 30, sky: false });
sheets.set({ bgTop: "#8dbbec", bgBottom: "#0c3592" });   // any option, any time
sheets.destroy();
```

`lite.html` is a test page with live controls and a CPU readout (ES modules: serve the folder over
HTTP, e.g. `python3 -m http.server`, rather than opening the file directly).
`createAquaLite(canvas, options)` in `lite/aqua-lite.js` is the bare engine, for hosts that want to
drive the frames themselves.

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
