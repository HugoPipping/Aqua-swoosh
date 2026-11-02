// mountAquaLite(container, options): puts Aqua Sheets Lite into an element as a background layer.
//
//   const sheets = mountAquaLite(document.body, { scale: 0.33, fps: 30, sky: false });
//   sheets.set({ bgTop: "#8dbbec", bgBottom: "#0c3592" });   // any engine option, at any time
//   sheets.destroy();
//
// Options (besides every engine option in LITE_DEFAULTS):
//   scale   render resolution relative to CSS pixels (0.33 ≈ a ninth of the pixels); upscaled smoothly
//   fps     frames per second to draw (the motion is slow; 20–30 is plenty)
//   worker  true: draw on a separate thread (OffscreenCanvas) when the browser allows it;
//           false (default): draw on the page's own thread, which costs a fraction of a millisecond
//   zIndex  CSS z-index of the canvas (default -1: behind the container's other content; note that a
//           background on <body> paints over negative z-index layers, so put page backgrounds on <html>)
//   onStats optional callback receiving { cpuMs, width, height, ... } about twice a second
//   pointer true: moving the pointer over the page shoves the sheets near it (radius: pointerRadius,
//           in screen heights, default 0.15)
//
// The returned object also has wind(speed) (a steady sideways wind, screen widths per second) and
// push(x, y, vx, vy, radius) (a shove at a point, 0…1 screen units, y down).
import { createAquaLite } from "./aqua-lite.js";

export function mountAquaLite(container, options = {}) {
	const { scale = 0.33, fps = 30, worker = false, zIndex = -1, onStats = null, pointer = false, pointerRadius = 0.15, ...engine } = options;
	const canvas = document.createElement("canvas");
	canvas.setAttribute("aria-hidden", "true");
	Object.assign(canvas.style, {
		position: container === document.body ? "fixed" : "absolute", inset: "0", width: "100%", height: "100%",
		zIndex: String(zIndex), pointerEvents: "none", imageRendering: "auto", display: "block",
	});
	container.prepend(canvas);

	let state = { scale, fps };
	const size = () => {
		const r = canvas.getBoundingClientRect();
		const k = Math.min(window.devicePixelRatio || 1, 2) * state.scale;
		return [Math.max(1, Math.round(r.width * k)), Math.max(1, Math.round(r.height * k))];
	};

	let api;
	const useWorker = worker && typeof canvas.transferControlToOffscreen === "function" && typeof Worker !== "undefined";
	if (useWorker) {
		const off = canvas.transferControlToOffscreen();
		const w = new Worker(new URL("./aqua-lite-worker.js", import.meta.url), { type: "module" });
		const [width, height] = size();
		w.postMessage({ type: "init", canvas: off, options: engine, fps, width, height, stats: onStats ? Math.max(1, Math.round(fps / 2)) : 0, paused: document.hidden }, [off]);
		w.onmessage = (e) => {
			if (e.data.type === "stats" && onStats) onStats({ ...e.data, thread: "worker" });
			else if (e.data.type === "error") console.error("Aqua Sheets Lite (worker):", e.data.message);
		};
		api = {
			set: (o) => { const { scale: s, fps: f, ...rest } = o; if (s != null) { state.scale = s; onResize(); } if (f != null) { state.fps = f; w.postMessage({ type: "fps", fps: f }); } if (Object.keys(rest).length) w.postMessage({ type: "set", options: rest }); },
			pause: () => w.postMessage({ type: "pause" }),
			resume: () => w.postMessage({ type: "resume" }),
			resize: ([width, height]) => w.postMessage({ type: "resize", width, height }),
			wind: (speed) => w.postMessage({ type: "wind", speed: +speed || 0 }),
			push: (x, y, vx, vy, r) => w.postMessage({ type: "push", x, y, vx, vy, r }),
			stop: () => w.terminate(),
			thread: "worker",
		};
	} else {
		const lite = createAquaLite(canvas, engine);
		lite.resize(...size());
		let raf = 0, last = 0, running = !document.hidden, n = 0;
		const loop = (now) => {
			raf = requestAnimationFrame(loop);
			if (now - last < (1000 / state.fps) * 0.92) return;
			const dt = last ? (now - last) / 1000 : 1 / state.fps;
			last = now;
			lite.render(dt);
			if (onStats && ++n >= Math.max(1, Math.round(state.fps / 2))) { n = 0; onStats({ ...lite.info(), thread: "page" }); }
		};
		if (running) raf = requestAnimationFrame(loop);
		api = {
			set: (o) => { const { scale: s, fps: f, ...rest } = o; if (f != null) state.fps = f; if (s != null) { state.scale = s; onResize(); } lite.set(rest); },
			pause: () => { running = false; cancelAnimationFrame(raf); },
			resume: () => { if (!running) { running = true; last = 0; raf = requestAnimationFrame(loop); } },
			resize: ([width, height]) => lite.resize(width, height),
			wind: (speed) => lite.wind(speed),
			push: (x, y, vx, vy, r) => lite.push(x, y, vx, vy, r),
			stop: () => { cancelAnimationFrame(raf); lite.dispose(); },
			thread: "page",
			engine: lite,
		};
	}

	const onResize = () => api.resize(size());
	const ro = new ResizeObserver(onResize);
	ro.observe(canvas);
	const onVis = () => (document.hidden ? api.pause() : api.resume());
	document.addEventListener("visibilitychange", onVis);

	// The pointer as wind: its speed in screen units per second, smoothed a little
	let prev = null;
	const onMove = (e) => {
		const r = canvas.getBoundingClientRect(), now = performance.now();
		const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
		if (prev && now > prev.t) {
			const dt = Math.max(0.008, (now - prev.t) / 1000);
			api.push(x, y, (x - prev.x) / dt, (y - prev.y) / dt, pointerRadius);
		}
		prev = { x, y, t: now };
	};
	if (pointer) window.addEventListener("pointermove", onMove);

	return {
		canvas,
		thread: api.thread,
		set: api.set,
		wind: api.wind,
		push: api.push,
		pause: api.pause,
		resume: api.resume,
		destroy() { api.stop(); ro.disconnect(); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("pointermove", onMove); canvas.remove(); },
	};
}
