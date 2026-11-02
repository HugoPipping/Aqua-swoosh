// Aqua Sheets Lite: the Aqua Sheets look at a fraction of the cost, for use as a background behind
// something heavier (e.g. Downpane, the rain Easter egg).
//
// What makes it light:
//  - No adaptive tessellation. Every sheet is a fixed grid of `columns` × `rows`, evenly spaced along
//    the ribbon, so the CPU only traces each ribbon at a few dozen points per frame (≈0.1 ms).
//    Columns tied to fixed places on the ribbon also never slide, so there is nothing to stutter.
//  - The GPU builds every vertex from one small record per column (instanced row strips).
//  - It renders at a fraction of the screen resolution (`scale`), optionally blurs there, and the
//    browser scales the result up smoothly. The sheets are soft, so little is lost.
//  - No DOM access: the same code runs on the page or inside a Worker with an OffscreenCanvas.
//
// createAquaLite(canvas, options) → { render(dt), resize(w, h), set(options), get(), info() }

export const LITE_DEFAULTS = {
	// motion (same meaning as in the full engine)
	speed: 0.06, flow: 0.6, bend: 1.0, wavelength: 1.0, twist: 1.0, morph: 0.5,
	dive: 0.4, roll: 0, swirl: 0.35, wander: 0.3, tumble: 0.35,
	// sheets
	seed: 8, count: 7, width: 1.9, length: 1.0, spread: 1.0, depth: 1.4, angle: 20, curl: 1.0,
	// look
	opacity: 0.1, fresnel: 0.55, gloss: 0.18, shininess: 24, edgeLine: 0.5, softness: 0.55,
	haze: 0.35, farTint: 0.6, falloff: 0.45, nearFade: 0.5,
	// colours: the sky is drawn only when `sky` is true, but always used to tint distant sheets
	bgTop: "#3f8bcb", bgBottom: "#0b1f57", glow: "#4b9fd6", glowAmt: 0.3, vignette: 0.25,
	tint: "#a9d6f2", highlight: "#d8efff", grain: 0.3,
	// lite
	sky: true,       // false: transparent background, only the sheets (to layer over another backdrop)
	columns: 72,     // mesh columns per sheet
	rows: 12,        // mesh rows per sheet
	blur: 1.0,       // gaussian blur radius in render pixels (0 = off)
};

const CAM_D = 3.5, TAN = 1 / CAM_D, NEAR0 = 1.2, KILL = 1.5, STRIDE = 16, SUB = 2;

function mulberry32(a) {
	return function () {
		a |= 0; a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const hex2rgb = (h) => { const n = parseInt(String(h).slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

// ---------- shaders ----------
const SKY_GLSL = `
uniform vec3 uTop, uBot, uGlow; uniform float uGlowAmt, uVig; uniform vec2 uRes;
vec3 sky(vec2 uv){
  float aspect = uRes.x/uRes.y;
  float t = clamp(uv.y*0.8 + uv.x*0.3 - 0.05, 0.0, 1.0);
  vec3 col = mix(uBot, uTop, smoothstep(0.0, 1.0, t));
  vec2 p = uv - vec2(0.5, 0.78); p.x *= aspect*0.6;
  col += uGlow * uGlowAmt * exp(-dot(p,p)*3.0);
  vec2 q = uv - 0.5; q.x *= aspect*0.8;
  return col * (1.0 - uVig*dot(q,q)*1.3);
}`;
const HASH = `float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }`;

const QUAD_VS = `attribute vec2 aPos; varying vec2 vUV;
void main(){ vUV = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`;

const SKY_FS = (P) => `precision ${P} float;
varying vec2 vUV; uniform float uGrain, uT;
${SKY_GLSL}
${HASH}
void main(){
  vec3 col = sky(vUV);
  col += (hash(gl_FragCoord.xy + fract(uT*7.0)*91.7) + hash(gl_FragCoord.yx*1.3 + 3.1) - 1.0) * uGrain / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

const SHEET_VS = `
attribute vec4 aC;    // centre-line point (camera-relative world), u
attribute vec4 aT;    // tangent, half-width (fold guard applied)
attribute vec4 aA;    // across direction, side (0 = this row, 1 = next row)
attribute vec4 aK;    // a'.T, n'.T, twist rate
attribute float aRow; // per instance: row index
uniform mat4 uProj, uView;
uniform vec4 uFade;   // nearStart, farEnd, nearFade, haze
uniform vec3 uSheet;  // rows, curl, world scale
varying vec3 vPv; varying vec3 vT; varying vec3 vA; varying vec4 vK; varying vec2 vUV; varying float vFade; varying float vFog;
void main(){
  float v = (aRow + aA.w) / uSheet.x * 2.0 - 1.0;
  vec3 Tt = aT.xyz, A = aA.xyz, Nn = cross(Tt, A);
  float hw = aT.w, off = v*hw, k = uSheet.y*(v*v - 0.333)*hw;
  vec3 pos = aC.xyz + (A*off + Nn*k)*uSheet.z;
  vec4 pv = uView * vec4(pos, 1.0);
  vPv = pv.xyz;
  vT = (uView * vec4(Tt, 0.0)).xyz;
  vA = (uView * vec4(A, 0.0)).xyz;
  vK = vec4(aK.xyz, hw);
  float d = -pv.z;
  float f = clamp((d - uFade.x) / (uFade.y - uFade.x), 0.0, 1.0);
  vFog = f;
  vFade = (1.0 - smoothstep(0.7, 1.0, f)) * smoothstep(0.08, 0.1 + uFade.z*2.5, d) * (1.0 - uFade.w*f*0.8);
  vUV = vec2(aC.w, v);
  gl_Position = uProj * pv;
}`;

const SHEET_FS = (P) => `precision ${P} float;
varying vec3 vPv; varying vec3 vT; varying vec3 vA; varying vec4 vK; varying vec2 vUV; varying float vFade; varying float vFog;
uniform vec3 uTint, uHi;
uniform float uCurl, uSoft, uT;
uniform vec4 uLook;   // opacity, fresnel, gloss, shininess
uniform vec4 uLook2;  // edge glints, grain, far dimming, far tint
${SKY_GLSL}
${HASH}
void main(){
  vec3 Tt = normalize(vT);
  vec3 A = normalize(vA - Tt*dot(vA, Tt));
  vec3 Nn = cross(Tt, A);
  float v = vUV.y, off = v*vK.w, k = uCurl*(v*v - 0.333)*vK.w;
  vec3 dPs = Tt*(1.0 + vK.x*off + vK.y*k) + vK.z*(Nn*off - A*k);
  vec3 dPv = A + Nn*(uCurl*2.0*v);
  vec3 N = normalize(cross(dPs, dPv));
  vec3 V = normalize(-vPv);
  float ndv = dot(N, V);
  if(ndv < 0.0){ N = -N; ndv = -ndv; }
  float g = 1.0 - clamp(ndv, 0.0, 1.0);
  float fres = g*g*g;
  float glint = pow(g, 14.0) * 1.6 * uLook2.x;
  float soft = clamp(uSoft * (1.0 + vFog*0.6), 0.02, 1.0);
  float edge = 1.0 - smoothstep(1.0 - soft, 1.0, abs(vUV.y));
  float ends = smoothstep(0.0, 0.15, 1.0 - abs(vUV.x));
  float m = edge * ends * vFade;
  float a = clamp((uLook.x + uLook.y*fres + glint) * m, 0.0, 1.0);
  vec3 L = normalize(vec3(-0.35, 0.75, 0.55));
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), uLook.w) * uLook.z * m;
  float fog = vFog * uLook2.w;
  vec3 behind = sky(gl_FragCoord.xy / uRes);
  vec3 tint = mix(uTint, behind*1.25, fog);
  float bright = 1.0 - uLook2.z*fog;
  vec3 col = (tint*a + mix(uHi, behind*1.4, fog*0.7)*spec) * bright;
  col += (hash(gl_FragCoord.xy + fract(uT*5.0)*57.3) - 0.5) * uLook2.y / 255.0 * a;
  gl_FragColor = vec4(col, a);
}`;

// 9-tap gaussian in 5 bilinear samples; premultiplied colour blurs correctly, transparency included
const BLUR_FS = (P) => `precision ${P} float;
varying vec2 vUV; uniform sampler2D uTex; uniform vec2 uStep;
void main(){
  vec4 c = texture2D(uTex, vUV) * 0.2270270270;
  vec2 o1 = uStep * 1.3846153846, o2 = uStep * 3.2307692308;
  c += (texture2D(uTex, vUV + o1) + texture2D(uTex, vUV - o1)) * 0.3162162162;
  c += (texture2D(uTex, vUV + o2) + texture2D(uTex, vUV - o2)) * 0.0702702703;
  gl_FragColor = c;
}`;

export function createAquaLite(canvas, options = {}) {
	const S = Object.assign({}, LITE_DEFAULTS, options);
	const gl = canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: "low-power", depth: false, stencil: false });
	if (!gl) throw new Error("Aqua Sheets Lite: WebGL is not available");
	const inst = gl.getExtension("ANGLE_instanced_arrays");
	if (!inst) throw new Error("Aqua Sheets Lite: instanced drawing (ANGLE_instanced_arrays) is not available");
	const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
	const P = hp && hp.precision > 0 ? "highp" : "mediump";

	const compile = (type, src) => {
		const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
		return s;
	};
	const program = (vs, fs, attribs) => {
		const p = gl.createProgram();
		gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
		attribs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
		const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
		for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
		return { p, u };
	};
	const skyProg = program(QUAD_VS, SKY_FS(P), ["aPos"]);
	const sheetProg = program(SHEET_VS, SHEET_FS(P), ["aC", "aT", "aA", "aK", "aRow"]);
	const blurProg = program(QUAD_VS, BLUR_FS(P), ["aPos"]);

	const quad = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, quad);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
	const rowBuf = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, rowBuf);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(Array.from({ length: 128 }, (_, i) => i)), gl.STATIC_DRAW);
	const colBuf = gl.createBuffer();
	let data = new Float32Array(4096 * STRIDE);

	// ---------- offscreen targets for the blur ----------
	let targets = null;
	const makeTarget = (w, h) => {
		const tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		const fb = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		return { tex, fb };
	};
	const ensureTargets = (w, h) => {
		if (targets && targets.w === w && targets.h === h) return targets;
		if (targets) for (const t of [targets.a, targets.b]) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
		targets = { w, h, a: makeTarget(w, h), b: makeTarget(w, h) };
		return targets;
	};

	// ---------- scene ----------
	let T = 0, FT = 0, camZ = 0, roll = 0, sheets = [];
	const depthRange = () => S.depth * 6;
	const rollSheet = (slot, gen, dist) => {
		const r = mulberry32((S.seed * 7919 + slot * 104729 + gen * 1299709) | 0); r(); r();
		const sh = {
			slot, gen, z: camZ - dist, lat: TAN * dist,
			ang: r() * Math.PI * 2, rad: Math.sqrt(r()) * 1.1,
			w: 0.55 + r() * 0.9, len: 0.8 + r() * 0.5, yawJ: (r() - 0.5) * 0.7,
			curv: r() - 0.5, cPh: r() * 6.283,
			b1: 0.5 + r() * 0.6, k1: 0.45 + r() * 0.45, p1: r() * 6.283,
			b2: 0.05 + r() * 0.1, k2: 1.1 + r() * 0.9, p2: r() * 6.283,
			pa: 0.12 + r() * 0.18, kp: 0.4 + r() * 0.5, pp: r() * 6.283,
			t0: (r() - 0.5) * 0.7, ta: 0.3 + r() * 0.7, kt: 0.35 + r() * 0.55, tp: r() * 6.283,
			curl: (r() - 0.5) * 1.4, sc: 0.8 + r() * 0.4,
		};
		const q = mulberry32((S.seed * 48271 + slot * 69621 + gen * 16807 + 11) | 0); q(); q();
		sh.vy = {
			ax0: (q() - 0.5) * 1.6, axA: 0.25 + q() * 0.5, axW: 0.12 + q() * 0.3, axP: q() * 6.283,
			ay0: (q() - 0.5) * 1.6, ayA: 0.25 + q() * 0.5, ayW: 0.12 + q() * 0.3, ayP: q() * 6.283,
			az0: (q() - 0.5) * 0.8, azA: 0.15 + q() * 0.3, azW: 0.08 + q() * 0.2, azP: q() * 6.283,
			tempo: 0.65 + q() * 0.8, tPh: q() * 20,
		};
		return sh;
	};
	const genSheets = () => {
		const n = Math.max(1, Math.min(32, S.count | 0)), R = depthRange(), r = mulberry32(S.seed * 31 + 5);
		sheets = [];
		for (let i = 0; i < n; i++) sheets.push(rollSheet(i, 0, NEAR0 + R * (0.12 + ((i + 0.5 + (r() - 0.5) * 0.6) / n) * 0.78)));
	};
	const updateScene = (dt) => {
		T += dt * S.speed; FT += dt * S.speed * S.flow;
		camZ -= dt * S.speed * S.dive * 3;
		roll += dt * S.speed * S.roll * (Math.PI / 180) * 3;
		const R = depthRange();
		for (let i = 0; i < sheets.length; i++) {
			const sh = sheets[i];
			if (camZ - sh.z < -KILL && (sh.maxD === undefined || sh.maxD < 0 || camZ - sh.z < -KILL * 6)) {
				const ns = rollSheet(sh.slot, sh.gen + 1, 0);
				ns.z = sh.z - (NEAR0 + R + KILL); ns.lat = TAN * (camZ - ns.z);
				sheets[i] = ns;
			}
		}
	};

	// camera orientation (roll + gentle wander); VIEW rows
	const VIEW = new Float64Array(9);
	const updateView = () => {
		const w = S.wander;
		const yaw = w * (0.32 * Math.sin(T * 0.11 + 0.7) + 0.14 * Math.sin(T * 0.047 + 2.1));
		const pit = w * (0.22 * Math.sin(T * 0.083 + 1.9) + 0.1 * Math.sin(T * 0.031 + 4.0));
		const cr = Math.cos(-roll), sr = Math.sin(-roll), cp = Math.cos(-pit), sp = Math.sin(-pit), cy = Math.cos(-yaw), sy = Math.sin(-yaw);
		const a = [cy, 0, sy, 0, 1, 0, -sy, 0, cy], b = [1, 0, 0, 0, cp, -sp, 0, sp, cp], c = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
		const ba = new Array(9);
		for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) ba[i * 3 + j] = b[i * 3] * a[j] + b[i * 3 + 1] * a[3 + j] + b[i * 3 + 2] * a[6 + j];
		for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) VIEW[i * 3 + j] = c[i * 3] * ba[j] + c[i * 3 + 1] * ba[3 + j] + c[i * 3 + 2] * ba[6 + j];
	};

	// heading/pitch/twist and their derivatives along the ribbon
	const EV = { yaw: 0, dyaw: 0, pit: 0, dpit: 0, th: 0, dth: 0 };
	const FR = { tx: 0, ty: 0, tz: 0, crx: 0, cry: 0, crz: 0, nx: 0, ny: 0, nz: 0 };
	const frameAt = (yw, pt, th) => {
		const cp = Math.cos(pt), tx = cp * Math.cos(yw), ty = cp * Math.sin(yw), tz = Math.sin(pt);
		const l = Math.hypot(tx, ty) || 1, wx = -ty / l, wy = tx / l;
		const fx = -tz * wy, fy = tz * wx, fz = tx * wy - ty * wx;
		const ct = Math.cos(th), st = Math.sin(th);
		FR.tx = tx; FR.ty = ty; FR.tz = tz;
		FR.crx = ct * wx + st * fx; FR.cry = ct * wy + st * fy; FR.crz = st * fz;
		FR.nx = -st * wx + ct * fx; FR.ny = -st * wy + ct * fy; FR.nz = ct * fz;
		return FR;
	};
	// fold guard: narrow the ribbon smoothly where a bend is tighter than the sheet is wide
	const foldTaper = (ka, kn, hw, cu) => {
		let sum = 0;
		for (let i = 0; i < 9; i++) {
			const v = i / 4 - 1, x = Math.max(0, -(ka * v + kn * cu * (v * v - 0.333)) * hw);
			const x2 = x * x, x4 = x2 * x2; sum += x4 * x4;
		}
		const m = Math.sqrt(Math.sqrt(Math.sqrt(sum / 9))) * 1.2, g = m / 0.65, g2 = g * g;
		return 1 / Math.sqrt(Math.sqrt(1 + g2 * g2));
	};

	const Rm = new Float64Array(9);
	const sheetSetup = (sh, aspect) => {
		const vy = sh.vy, k = S.tumble;
		const x = k * (vy.ax0 + vy.axA * Math.sin(T * vy.axW + vy.axP));
		const y = k * (vy.ay0 + vy.ayA * Math.sin(T * vy.ayW + vy.ayP));
		const z = k * (vy.az0 + vy.azA * Math.sin(T * vy.azW + vy.azP));
		const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
		Rm[0] = cz * cy; Rm[1] = cz * sy * sx - sz * cx; Rm[2] = cz * sy * cx + sz * sx;
		Rm[3] = sz * cy; Rm[4] = sz * sy * sx + cz * cx; Rm[5] = sz * sy * cx - cz * sx;
		Rm[6] = -sy; Rm[7] = cy * sx; Rm[8] = cy * cx;
		const wl = S.wavelength, ft = FT * vy.tempo + vy.tPh, mt = T * S.morph;
		const a0 = (S.angle * Math.PI) / 180 + sh.yawJ;
		let tg = sh.ang + Math.PI / 2, sign = 1;
		if (Math.cos(tg - a0) < 0) { tg += Math.PI; sign = -1; }
		const hx = Math.cos(a0) * (1 - S.swirl) + Math.cos(tg) * S.swirl, hy = Math.sin(a0) * (1 - S.swirl) + Math.sin(tg) * S.swirl;
		const yaw0 = Math.atan2(hy, hx);
		const curvature = S.bend * sh.curv * 0.7 * (1 + 0.3 * Math.sin(T * 0.05 + sh.cPh)) + (S.swirl * sign * 0.5) / Math.max(sh.rad, 0.8);
		const ph1 = sh.p1 + 0.6 * Math.sin(mt * 0.04 + sh.p1), thM = 0.25 * S.morph * Math.sin(T * 0.07 + sh.tp);
		const B = S.bend * 0.45, k1 = sh.k1 / wl, k2 = sh.k2 / wl, kp = sh.kp / wl, kt = sh.kt / wl, tw = S.twist * sh.ta;
		return {
			L: S.length * sh.len * (2.4 * aspect + 2.5), hw: 0.3 * S.width * sh.w, curl: S.curl * sh.curl, sc: sh.sc,
			ax: Math.cos(sh.ang) * sh.rad * S.spread * sh.lat, ay: Math.sin(sh.ang) * sh.rad * S.spread * sh.lat, az: sh.z - camZ,
			ev: (s) => {
				const a1 = k1 * s + ph1 - ft, a2 = k2 * s + sh.p2 - ft * 0.63, ap = kp * s + sh.pp - ft * 0.8, at = kt * s + sh.tp - ft * 0.71;
				const s1 = Math.sin(a1), c1 = Math.cos(a1), s2 = Math.sin(a2), c2 = Math.cos(a2);
				EV.yaw = yaw0 + curvature * s + B * (sh.b1 * s1 + sh.b2 * s2);
				EV.dyaw = curvature + B * (sh.b1 * k1 * c1 + sh.b2 * k2 * c2);
				EV.pit = sh.pa * Math.sin(ap); EV.dpit = sh.pa * kp * Math.cos(ap);
				EV.th = sh.t0 + tw * Math.sin(at) + thM; EV.dth = tw * kt * Math.cos(at);
				return EV;
			},
		};
	};

	// trace one ribbon at evenly spaced columns and write one record per column side
	let px = new Float64Array(0), py = px, pz = px, yw = px, pt = px;
	const writeSheet = (sh, aspect, base) => {
		const F = sheetSetup(sh, aspect), nu = Math.max(8, S.columns | 0), n = nu * SUB, ds = F.L / n, mid = n / 2;
		if (px.length < n + 1) { px = new Float64Array(n + 1); py = new Float64Array(n + 1); pz = new Float64Array(n + 1); yw = new Float64Array(n + 1); pt = new Float64Array(n + 1); }
		for (let i = 0; i <= n; i++) { const e = F.ev((i / n - 0.5) * F.L); yw[i] = e.yaw; pt[i] = e.pit; }
		px[mid] = 0; py[mid] = 0; pz[mid] = 0;
		for (let i = mid; i < n; i++) { const y = (yw[i] + yw[i + 1]) / 2, p = (pt[i] + pt[i + 1]) / 2, c = Math.cos(p);
			px[i + 1] = px[i] + c * Math.cos(y) * ds; py[i + 1] = py[i] + c * Math.sin(y) * ds; pz[i + 1] = pz[i] + Math.sin(p) * ds; }
		for (let i = mid; i > 0; i--) { const y = (yw[i] + yw[i - 1]) / 2, p = (pt[i] + pt[i - 1]) / 2, c = Math.cos(p);
			px[i - 1] = px[i] - c * Math.cos(y) * ds; py[i - 1] = py[i] - c * Math.sin(y) * ds; pz[i - 1] = pz[i] - Math.sin(p) * ds; }
		const R = Rm, V = VIEW, sc = F.sc, D = data;
		let maxD = -Infinity;
		for (let c = 0; c <= nu; c++) {
			const i = c * SUB, s = (i / n - 0.5) * F.L;
			const e = F.ev(s), f = frameAt(e.yaw, e.pit, e.th);
			const cp = Math.cos(e.pit), ct = Math.cos(e.th), st = Math.sin(e.th);
			const ka = -ct * e.dyaw * cp - st * e.dpit, kn = st * e.dyaw * cp - ct * e.dpit, tau = e.dth + e.dyaw * f.tz;
			const thw = foldTaper(ka, kn, F.hw, F.curl) * F.hw;
			const lx = px[i] * sc, ly = py[i] * sc, lz = pz[i] * sc;
			const Cx = F.ax + R[0] * lx + R[1] * ly + R[2] * lz, Cy = F.ay + R[3] * lx + R[4] * ly + R[5] * lz, Cz = F.az + R[6] * lx + R[7] * ly + R[8] * lz;
			const Tx = R[0] * f.tx + R[1] * f.ty + R[2] * f.tz, Ty = R[3] * f.tx + R[4] * f.ty + R[5] * f.tz, Tz = R[6] * f.tx + R[7] * f.ty + R[8] * f.tz;
			const Ax = R[0] * f.crx + R[1] * f.cry + R[2] * f.crz, Ay = R[3] * f.crx + R[4] * f.cry + R[5] * f.crz, Az = R[6] * f.crx + R[7] * f.cry + R[8] * f.crz;
			const depth = -(V[6] * Cx + V[7] * Cy + V[8] * Cz) + thw * sc * (1 + Math.abs(F.curl));
			if (depth > maxD) maxD = depth;
			const u = s / (F.L / 2);
			for (let side = 0; side < 2; side++) {
				const o = (base + c * 2 + side) * STRIDE;
				D[o] = Cx; D[o + 1] = Cy; D[o + 2] = Cz; D[o + 3] = u;
				D[o + 4] = Tx; D[o + 5] = Ty; D[o + 6] = Tz; D[o + 7] = thw;
				D[o + 8] = Ax; D[o + 9] = Ay; D[o + 10] = Az; D[o + 11] = side;
				D[o + 12] = ka; D[o + 13] = kn; D[o + 14] = tau; D[o + 15] = 0;
			}
		}
		sh.maxD = maxD;
		return { nu, curl: F.curl, sc };
	};

	const perspective = (aspect) => {
		const near = 0.05, far = 200, nf = 1 / (near - far), m = new Float32Array(16);
		m[0] = CAM_D / aspect; m[5] = CAM_D; m[10] = (far + near) * nf; m[11] = -1; m[14] = 2 * far * near * nf;
		return m;
	};
	const viewMatrix4 = () => {
		const V = VIEW, m = new Float32Array(16);
		m[0] = V[0]; m[4] = V[1]; m[8] = V[2]; m[1] = V[3]; m[5] = V[4]; m[9] = V[5]; m[2] = V[6]; m[6] = V[7]; m[10] = V[8]; m[15] = 1;
		return m;
	};
	const setSky = (u, W, H) => {
		gl.uniform3fv(u.uTop, hex2rgb(S.bgTop)); gl.uniform3fv(u.uBot, hex2rgb(S.bgBottom));
		gl.uniform3fv(u.uGlow, hex2rgb(S.glow)); gl.uniform1f(u.uGlowAmt, S.glowAmt);
		gl.uniform1f(u.uVig, S.vignette); gl.uniform2f(u.uRes, W, H);
	};
	const drawQuad = () => {
		gl.bindBuffer(gl.ARRAY_BUFFER, quad);
		gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	};

	let lastCpuMs = 0;
	const draw = () => {
		const t0 = performance.now();
		const W = canvas.width, H = canvas.height, aspect = W / H;
		const blur = S.blur > 0.01;
		if (blur) { ensureTargets(W, H); gl.bindFramebuffer(gl.FRAMEBUFFER, targets.a.fb); } else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, W, H);
		gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
		for (let i = 1; i < 5; i++) gl.disableVertexAttribArray(i);
		inst.vertexAttribDivisorANGLE(4, 0);

		if (S.sky) {
			gl.disable(gl.BLEND);
			gl.useProgram(skyProg.p);
			setSky(skyProg.u, W, H);
			gl.uniform1f(skyProg.u.uGrain, S.grain); gl.uniform1f(skyProg.u.uT, T);
			drawQuad();
		} else {
			gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
		}

		// geometry (the only CPU work)
		updateView();
		const order = sheets.slice().sort((a, b) => a.z - b.z);
		const per = (Math.max(8, S.columns | 0) + 1) * 2;
		if (data.length < order.length * per * STRIDE) data = new Float32Array(order.length * per * STRIDE);
		const draws = order.map((sh, k) => writeSheet(sh, aspect, k * per));
		gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
		gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, order.length * per * STRIDE), gl.DYNAMIC_DRAW);
		lastCpuMs = performance.now() - t0;

		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.useProgram(sheetProg.p);
		const u = sheetProg.u;
		gl.uniformMatrix4fv(u.uProj, false, perspective(aspect));
		gl.uniformMatrix4fv(u.uView, false, viewMatrix4());
		gl.uniform4f(u.uFade, NEAR0, NEAR0 + depthRange(), S.nearFade, S.haze);
		gl.uniform3fv(u.uTint, hex2rgb(S.tint)); gl.uniform3fv(u.uHi, hex2rgb(S.highlight));
		gl.uniform4f(u.uLook, S.opacity, S.fresnel, S.gloss, S.shininess);
		gl.uniform4f(u.uLook2, S.edgeLine, S.grain, S.falloff, S.farTint);
		gl.uniform1f(u.uSoft, S.softness); gl.uniform1f(u.uT, T);
		setSky(u, W, H);
		for (let i = 0; i < 5; i++) gl.enableVertexAttribArray(i);
		gl.bindBuffer(gl.ARRAY_BUFFER, rowBuf);
		gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 4, 0);
		inst.vertexAttribDivisorANGLE(4, 1);
		gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
		const rows = Math.max(2, Math.min(127, S.rows | 0));
		draws.forEach((d, k) => {
			gl.uniform3f(u.uSheet, rows, d.curl, d.sc);
			gl.uniform1f(u.uCurl, d.curl);
			const off = k * per * STRIDE * 4;
			for (let a = 0; a < 4; a++) gl.vertexAttribPointer(a, 4, gl.FLOAT, false, STRIDE * 4, off + a * 16);
			inst.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, per, rows);
		});
		inst.vertexAttribDivisorANGLE(4, 0);
		for (let i = 1; i < 5; i++) gl.disableVertexAttribArray(i);

		if (blur) {
			gl.disable(gl.BLEND);
			gl.useProgram(blurProg.p);
			gl.activeTexture(gl.TEXTURE0); gl.uniform1i(blurProg.u.uTex, 0);
			gl.bindFramebuffer(gl.FRAMEBUFFER, targets.b.fb);
			gl.bindTexture(gl.TEXTURE_2D, targets.a.tex);
			gl.uniform2f(blurProg.u.uStep, S.blur / W, 0);
			drawQuad();
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.bindTexture(gl.TEXTURE_2D, targets.b.tex);
			gl.uniform2f(blurProg.u.uStep, 0, S.blur / H);
			drawQuad();
		}
	};

	genSheets();
	const REGEN = ["seed", "count", "depth"];
	return {
		// advance the animation by dt seconds and draw a frame
		render(dt) { updateScene(Math.min(0.25, Math.max(0, dt))); draw(); },
		resize(w, h) { canvas.width = Math.max(1, w | 0); canvas.height = Math.max(1, h | 0); },
		set(opts) { const regen = REGEN.some((k) => k in opts && opts[k] !== S[k]); Object.assign(S, opts); if (regen) genSheets(); },
		get() { return Object.assign({}, S); },
		info() { return { cpuMs: lastCpuMs, width: canvas.width, height: canvas.height, sheets: sheets.length, verticesPerFrame: sheets.length * (Math.max(8, S.columns | 0) + 1) * (Math.max(2, S.rows | 0) + 1) }; },
		lost() { return gl.isContextLost(); },
	};
}
