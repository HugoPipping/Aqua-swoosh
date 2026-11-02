// Runs Aqua Sheets Lite on its own thread with an OffscreenCanvas, so the page's main thread
// (and whatever simulation lives there) never spends time on it.
import { createAquaLite } from "./aqua-lite.js";

let lite = null, fps = 30, running = true, last = 0, timer = 0, statsEvery = 0;

const raf = self.requestAnimationFrame ? (f) => self.requestAnimationFrame(f) : (f) => setTimeout(() => f(performance.now()), 1000 / 60);

function loop(now) {
	timer = 0;
	if (!running || !lite) return;
	const interval = 1000 / fps;
	if (now - last >= interval * 0.92) {
		const dt = last ? (now - last) / 1000 : 1 / fps;
		last = now;
		lite.render(dt);
		if (statsEvery && ++statsEvery.n >= statsEvery.every) { statsEvery.n = 0; self.postMessage({ type: "stats", ...lite.info() }); }
	}
	// at low frame rates, sleep instead of waking every display frame
	if (fps <= 30 && !self.requestAnimationFrame) timer = setTimeout(() => loop(performance.now()), interval);
	else timer = raf(loop) || 1;
}

self.onmessage = (e) => {
	const m = e.data;
	try {
		if (m.type === "init") {
			fps = m.fps || fps;
			lite = createAquaLite(m.canvas, m.options || {});
			lite.resize(m.width, m.height);
			statsEvery = m.stats ? { n: 0, every: m.stats } : 0;
			running = !m.paused; last = 0;
			if (running) loop(performance.now());
			self.postMessage({ type: "ready" });
		} else if (m.type === "resize") lite && lite.resize(m.width, m.height);
		else if (m.type === "set") lite && lite.set(m.options);
		else if (m.type === "fps") fps = m.fps;
		else if (m.type === "pause") running = false;
		else if (m.type === "resume") { if (!running) { running = true; last = 0; loop(performance.now()); } }
	} catch (err) {
		self.postMessage({ type: "error", message: String(err && err.message || err) });
	}
};
