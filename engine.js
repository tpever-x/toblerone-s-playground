/* ============ AERO ENGINE v3.0.3 — GPU/CPU EXTREME BUILD ============
   Yetkin Köseoğlu · Atmospheric CV Engine

   Pipeline:  WebGL2 (transform-feedback GPU particles, HDR FBO post chain)
              → WebGL1 (CPU-float particle fallback, RGBA8 chain)
              → Canvas2D mode (CSS gradient + #sky canvas)
   Post FX:   scene FBO → N separable blur passes → composite
              (bloom, chromatic aberration, vignette, film grain, tonemap)
   Physics:   Web Worker (spatial hash ≤256, brute O(n²) above) — up to 1024
              bodies; main-thread brute solver as fallback.
   Safety:    no infinite loops, bounded buffers, MAX_PIXELS cap, RESET LOAD,
              context-loss recovery, reduced-motion defaults.
   Zero dependencies.
=================================================================== */
(() => {
'use strict';

/* ================= UTILITIES ================= */
const TAU = Math.PI * 2, RAD = Math.PI / 180, DEG = 180 / Math.PI;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp  = (a, b, t) => a + (b - a) * t;
const normD = d => ((d % 360) + 360) % 360;
const hex   = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix   = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const css   = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const $     = id => document.getElementById(id);
const RM    = matchMedia('(prefers-reduced-motion: reduce)').matches;
const LOWMEM = !!(navigator.deviceMemory && navigator.deviceMemory <= 4);
const root  = document.documentElement;

/* Ring buffer — rolling telemetry without per-frame shift() churn. */
function ring(cap) {
  const a = new Float32Array(cap); let i = 0, n = 0;
  return {
    push(v) { a[i] = v; i = (i + 1) % cap; if (n < cap) n++; },
    get avg() { if (!n) return 0; let s = 0; for (let k = 0; k < n; k++) s += a[k]; return s / n; },
    get max() { let m = -Infinity; for (let k = 0; k < n; k++) if (a[k] > m) m = a[k]; return n ? m : 0; },
    get len() { return n; },
    at(k) { return a[(i - 1 - k + cap * 2) % cap]; }
  };
}

/* ================= STATE & PARAMETERS ================= */
const S = {
  coords: { lat: 38.42, lon: 27.14, label: 'İZMİR, TR' },
  wxNow: null, sun: null,
  moon: null, amb: 1, phase: 'noon', fps: 60,
  sunSolves: 0, fogA: 0, hitCount: 0, hitsSinceTick: 0,
  stars: [], flash: 0, stormF: 0,
  geoState: 'idle', windFromAPI: null,
  sunRiseSetCache: { time: 0, rise: null, set: null }
};

const P = {
  /* preserved v2.8 parameters */
  theme: 'auto', wx: 'auto', density: RM ? 0.8 : 2.5, gravity: 1,
  windOv: -1, elas: 1, dropSize: 7, sound: false, zeroG: true,
  legacy: !RM, gpuLoops: 96, gpuScaleLegacy: 1,
  /* v3.0 stress matrix */
  gpuLoad: RM ? 50 : 75,
  shaderLevel: RM ? 'MEDIUM' : 'HIGH',
  renderScale: 1,
  particles: RM ? 10000 : 50000,
  bodies: 72,
  postPasses: 2,
  caustic: 'HIGH',
  cloud: 'HIGH',
  solver: 'AUTO',
  thread: 'worker',
  fxMode: 'hdr',
  targetFps: 60,
  auto: false
};

/* Per-tier shader complexity. effLoops() clamps to the 256 shader bound:
   real ceilings — HIGH×1.25=120 · EXTREME×1.25=200 · INSANE caps at 240→256. */
const SH = {
  LOW:     { loops: 24,  oct: 3, warp: 0 },
  MEDIUM:  { loops: 48,  oct: 4, warp: 1 },
  HIGH:    { loops: 96,  oct: 5, warp: 2 },
  EXTREME: { loops: 160, oct: 6, warp: 2 },
  INSANE:  { loops: 240, oct: 8, warp: 3 }
};
const SH_ORDER   = ['LOW', 'MEDIUM', 'HIGH', 'EXTREME', 'INSANE'];
const QN         = { OFF: 0, LOW: 1, MEDIUM: 2, HIGH: 3, ULTRA: 4 };
const CAUS_ITER  = { OFF: 0, LOW: 3, MEDIUM: 6, HIGH: 9, ULTRA: 13 };
const LOAD_STEPS = [25, 50, 75, 100, 125];
const SCALE_STEPS = [1, 1.25, 1.5, 2, 2.5, 3];
const PART_STEPS = [10000, 50000, 100000, 250000];
const BODY_STEPS = [32, 64, 128, 256, 512, 1024];
const MAX_PIXELS = LOWMEM ? 4.2e6 : 9.4e6;   // hard cap on internal resolution

const TEL = {
  frame: ring(90), cpu: ring(90), phys: ring(60), graph: ring(160)
};
const gpuCounters = { draws: 0, tris: 0, parts: 0 };
const effLoops = () => clamp(Math.floor(SH[P.shaderLevel].loops * P.gpuLoad / 100), 8, 256);

/* Benchmark / auto-stress state */
const bench = { on: false, t0: 0, dur: 30000, frames: [], pre: null, load: 'EXTREME' };
let autoRung = 0;

/* ================= ASTRONOMY (preserved v2.8) ================= */
const Astro = {
  gmst(d) { return normD(280.46061837 + 360.98564736629 * d) * RAD; },
  sunEcl(d) {
    const g = normD(357.529 + 0.98560028 * d) * RAD;
    return normD(280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
  },
  position(date, latDeg, lonDeg) {
    const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
    const L = this.sunEcl(d) * RAD, e = (23.439 - 0.00000036 * d) * RAD;
    const RA = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const H = this.gmst(d) + lonDeg * RAD - RA, lat = latDeg * RAD;
    const alt = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H));
    const azS = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat));
    return { altDeg: alt * DEG, azDeg: normD(azS * DEG + 180), H, decDeg: dec * DEG, jd: d + 2451545.0 };
  },
  moon(date, latDeg, lonDeg) {
    const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
    const Lm = normD(218.316 + 13.176396 * d) * RAD,
          M  = normD(134.963 + 13.064993 * d) * RAD,
          F  = normD(93.272  + 13.229350 * d) * RAD;
    const lo = Lm + 6.289 * RAD * Math.sin(M), la = 5.128 * RAD * Math.sin(F);
    const e  = (23.439 - 0.00000036 * d) * RAD;
    const RA = Math.atan2(Math.sin(lo) * Math.cos(e) - Math.tan(la) * Math.sin(e), Math.cos(lo));
    const dec = Math.asin(Math.sin(la) * Math.cos(e) + Math.cos(la) * Math.sin(e) * Math.sin(lo));
    const H = this.gmst(d) + lonDeg * RAD - RA, lat = latDeg * RAD;
    const alt = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H));
    const azS = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat));
    const elong = normD(lo * DEG - this.sunEcl(d));
    return { altDeg: alt * DEG, azDeg: normD(azS * DEG + 180), H, illum: (1 - Math.cos(elong * RAD)) / 2, waxing: elong < 180 };
  }
};
const THEME_SYNTH = {
  dawn:      { alt: -4,  H: -1.6 },
  morning:   { alt: 16,  H: -0.9 },
  noon:      { alt: 64,  H: 0.02 },
  afternoon: { alt: 16,  H: 0.9  },
  dusk:      { alt: -4,  H: 1.6  },
  night:     { alt: -32, H: Math.PI }
};
function phaseFromSun(sun) {
  const alt = sun.altDeg, H = sun.H;
  if (alt > 50) return 'noon';
  if (alt > 10) return H > 0 ? 'afternoon' : 'morning';
  if (alt > -6) return H > 0 ? 'dusk' : 'dawn';
  return 'night';
}
function fmtTime(d) {
  if (!d) return '--:--';
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}
function effSun() {
  if (P.theme !== 'auto') {
    const s = THEME_SYNTH[P.theme];
    return { altDeg: s.alt, azDeg: 180, H: s.H, decDeg: 0, jd: 0 };
  }
  return S.sun || Astro.position(new Date(), S.coords.lat, S.coords.lon);
}
function getSunRiseSet(nowMs) {
  if (nowMs - S.sunRiseSetCache.time < 60000 && S.sunRiseSetCache.rise !== null) return S.sunRiseSetCache;
  let rise = null, set = null;
  let prev = Astro.position(new Date(nowMs - 3600000), S.coords.lat, S.coords.lon).altDeg;
  for (let h = 0; h <= 24; h++) {
    const t = new Date(nowMs + (h - 12) * 3600000);
    const a = Astro.position(t, S.coords.lat, S.coords.lon).altDeg;
    if (prev < 0 && a >= 0 && !rise) rise = t;
    if (prev >= 0 && a < 0 && !set) set = t;
    prev = a;
  }
  S.sunRiseSetCache = { time: nowMs, rise, set };
  return S.sunRiseSetCache;
}
const _sd = [0, 1, 0];
function sunDir3(sun) {
  // Real elevation; azimuth folded toward centre-x so the sun stays in frame.
  const el = clamp(sun.altDeg, -25, 90) * RAD;
  const az = ((sun.azDeg - 180) * RAD) * 0.35, ce = Math.cos(el);
  _sd[0] = Math.sin(az) * ce; _sd[1] = Math.sin(el); _sd[2] = Math.cos(az) * ce;
  return _sd;
}

/* ================= CANVAS SETUP ================= */
const skyCv = $('sky'), skyCtx = skyCv.getContext('2d');
const wxCv  = $('wx'),  wxCtx  = wxCv.getContext('2d');
const glCv  = $('glassCv'), glCtx = glCv.getContext('2d');
const mainCv = $('gpuMain');
let W = window.innerWidth, H = window.innerHeight;

/* Small runtime-only stylesheet (one bounded node, created once). */
(function injectExtraCss() {
  const st = document.createElement('style');
  st.id = 'aeroExtra';
  st.textContent =
    '#stage .spec{pointer-events:none}' +
    '#arenaCv{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}' +
    '.bench-run *{animation-play-state:paused!important}' +
    '.bench-run #hint,.bench-run #stressToast{display:none}';
  document.head.appendChild(st);
})();

function toast(msg, ms = 3200) {
  const t = $('stressToast');
  if (!t) return;
  t.innerText = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

/* ================= LEGACY OVERLAY (v2.8 #gpuCanvas, preserved) =====
   The original screen-blend stress shader stays on its own alpha context.
   It consumes P.gpuLoops / P.gpuScaleLegacy. */
const legCv = $('gpuCanvas');
const legGL = legCv && (legCv.getContext('webgl2', { alpha: true, antialias: false, powerPreference: 'high-performance' }) ||
                        legCv.getContext('webgl',  { alpha: true, antialias: false, powerPreference: 'high-performance' }));
let legProg = null, legU = null, legOK = false;
function initLegacy() {
  if (!legGL || !P.legacy) return;
  const is2 = !!legGL.createVertexArray;
  const vs = `#version ${is2 ? '300 es' : '100'}\n${is2 ? 'in vec2 aPos; out vec2 vUv;' : 'attribute vec2 aPos; varying vec2 vUv;'} void main(){ vUv=aPos*.5+.5; gl_Position=vec4(aPos,0.,1.); }`;
  const fs = `${is2 ? '#version 300 es\nprecision highp float; in vec2 vUv; out vec4 outColor;' : 'precision highp float; varying vec2 vUv;'}
  uniform vec2 uRes; uniform float uTime; uniform float uLoops; uniform float uSun;
  float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
  float noise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
    float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+1.0);
    return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
  void main(){
    vec2 uv=vUv; vec2 p=(uv-.5)*vec2(uRes.x/uRes.y,1.0); float t=uTime;
    float horizon=1.0-smoothstep(-.18,.55,uv.y);
    float wave=0.0, acc=0.0;
    for(int i=0;i<160;i++){
      float fi=float(i); if(fi>=uLoops) break;
      vec2 q=p*(1.2+fi*.017);
      q.x+=sin(t*.00035+fi*.73+q.y*3.2)*.018;
      q.y+=cos(t*.00029+fi*.41+q.x*4.1)*.014;
      float n=noise(q*3.0+vec2(t*.00003*fi,t*.00002*fi));
      float r=length(q+vec2(sin(fi)*.04,cos(fi*1.7)*.03));
      wave+=exp(-r*(2.5+mod(fi,7.0)*.45))*n*(.55+.45*sin(fi*1.7+t*.001));
      acc+=n*.0025;
    }
    float bands=0.5+0.5*sin((p.x*7.0+p.y*19.0)+sin(p.y*9.0+t*.0008)*2.5);
    float caustic=pow(max(0.0,wave*.035+bands*.045+acc),2.2);
    float sun=exp(-length(vec2(p.x*1.1,(p.y-(.25-uSun*.0015))*1.6))*5.0);
    float haze=pow(max(0.0,1.0-abs(uv.y-.5)*1.7),2.0)*.11;
    vec3 col=vec3(.02,.22,.42)*horizon+vec3(.02,.08,.16)*(1.0-horizon);
    col+=vec3(.05,.35,.9)*caustic; col+=vec3(1.0,.72,.35)*sun*.18; col+=vec3(.12,.45,1.0)*haze;
    float chrom=0.008*sin(t*.0006+p.y*13.0);
    col.r+=max(0.0,chrom)*.8; col.b+=max(0.0,-chrom)*1.2;
    ${is2 ? 'outColor=vec4(col,.72);' : 'gl_FragColor=vec4(col,.72);'}
  }`;
  const cs = (t, s) => { const sh = legGL.createShader(t); legGL.shaderSource(sh, s); legGL.compileShader(sh); return sh; };
  const prog = legGL.createProgram();
  legGL.attachShader(prog, cs(legGL.VERTEX_SHADER, vs));
  legGL.attachShader(prog, cs(legGL.FRAGMENT_SHADER, fs));
  legGL.bindAttribLocation(prog, 0, 'aPos');
  legGL.linkProgram(prog);
  if (!legGL.getProgramParameter(prog, legGL.LINK_STATUS)) return;
  legProg = prog;
  const buf = legGL.createBuffer();
  legGL.bindBuffer(legGL.ARRAY_BUFFER, buf);
  legGL.bufferData(legGL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), legGL.STATIC_DRAW);
  legGL.useProgram(prog);
  legGL.enableVertexAttribArray(0);
  legGL.vertexAttribPointer(0, 2, legGL.FLOAT, false, 0, 0);
  legU = {
    res: legGL.getUniformLocation(prog, 'uRes'), time: legGL.getUniformLocation(prog, 'uTime'),
    loops: legGL.getUniformLocation(prog, 'uLoops'), sun: legGL.getUniformLocation(prog, 'uSun')
  };
  legOK = true;
}
function resizeLegacy() {
  if (!legOK) return;
  const d = Math.min(window.devicePixelRatio || 1, 1.5) * (P.gpuScaleLegacy || 1);
  legCv.width = Math.min(3840, Math.floor(W * d));
  legCv.height = Math.min(2160, Math.floor(H * d));
  legGL.viewport(0, 0, legCv.width, legCv.height);
}
function renderLegacy(time, sunAlt) {
  if (!legOK || !P.legacy) return;
  legGL.useProgram(legProg);
  legGL.uniform2f(legU.res, legCv.width, legCv.height);
  legGL.uniform1f(legU.time, time);
  legGL.uniform1f(legU.loops, P.gpuLoops);
  legGL.uniform1f(legU.sun, sunAlt);
  legGL.drawArrays(legGL.TRIANGLE_STRIP, 0, 4);
}

/* ================= PRIMARY GPU PIPELINE (v3.0) ================= */
const gl2 = mainCv.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
const gl1 = gl2 ? null : mainCv.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
const GL = gl2 || gl1;
const IS2 = !!gl2, GLSL3 = !!gl2;
/* half-float render targets only when the driver can render to them. */
const extCBF = IS2 ? gl2.getExtension('EXT_color_buffer_float') : null;
let glOK = false, sceneHdr = false, rtFmt = 'NONE';
let progSky = null, progBlur = null, progComp = null;
let uSky = null, uBlur = null, uComp = null;
let quadVAO = null, quadBuf = null;
let rt = { scene: null, a: null, b: null };
let internalRes = '—';

/* on loss everything is dead; null all cached handles before rebuild. */
function invalidateGLCache() {
  quadBuf = null; quadVAO = null;
  progSky = progBlur = progComp = null;
  uSky = uBlur = uComp = null;
  rt.scene = rt.a = rt.b = null;
  Parts.destroy();
}
mainCv.addEventListener('webglcontextlost', e => {
  e.preventDefault(); glOK = false;
  toast('⚠ GPU CONTEXT LOST — PIPELINE SUSPENDED');
});
mainCv.addEventListener('webglcontextrestored', () => {
  invalidateGLCache();
  buildPipeline();
  toast(glOK ? 'GPU CONTEXT RESTORED' : 'GPU CONTEXT RESTORE FAILED');
});

/* version-correct vertex sources; location 0 guaranteed. */
const V3 = '#version 300 es\nlayout(location=0) in vec2 aPos; out vec2 vUv; void main(){ vUv=aPos*.5+.5; gl_Position=vec4(aPos,0.,1.); }';
const V1 = 'attribute vec2 aPos; varying vec2 vUv; void main(){ vUv=aPos*.5+.5; gl_Position=vec4(aPos,0.,1.); }';

function shCompile(type, src) {
  const s = GL.createShader(type);
  GL.shaderSource(s, src); GL.compileShader(s);
  if (!GL.getShaderParameter(s, GL.COMPILE_STATUS)) {
    console.warn('[AERO] shader compile:', GL.getShaderInfoLog(s));
    GL.deleteShader(s); return null;
  }
  return s;
}
/* Single link. GL1 attribute locations bound BEFORE the first link. */
function shProgram(vsSrc, fsSrc, bindings) {
  const vs = shCompile(GL.VERTEX_SHADER, vsSrc), fs = shCompile(GL.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const p = GL.createProgram();
  GL.attachShader(p, vs); GL.attachShader(p, fs);
  if (!GLSL3 && bindings) for (const name in bindings) GL.bindAttribLocation(p, bindings[name], name);
  GL.linkProgram(p);
  GL.deleteShader(vs); GL.deleteShader(fs);
  if (!GL.getProgramParameter(p, GL.LINK_STATUS)) {
    console.warn('[AERO] program link:', GL.getProgramInfoLog(p));
    GL.deleteProgram(p); return null;
  }
  return p;
}
function fsHead() {
  return (GLSL3 ? '#version 300 es\n' : '') +
    'precision highp float;\n' +
    (GLSL3 ? 'in vec2 vUv;\nout vec4 oC;\n#define FRAG oC\n' : 'varying vec2 vUv;\n#define FRAG gl_FragColor\n');
}

/* ---- sky / stress shader -------------------------------------------
   Compile-time: OCT (FBM octaves), WARP (domain-warp depth).
   Runtime:      uLoops (master budget, ≤256), uCaus (caustic iters).
   GL1 path keeps every loop constant-bounded (ES 1.00 Appendix A) and
   masks contributions with step(); dynamic breaks are GL3-only.       */
function skyFragSrc() {
  const c = SH[P.shaderLevel];
  return fsHead() + `
#define OCT ${c.oct}
#define WARP ${c.warp}
#define GL3 ${GLSL3 ? 1 : 0}
uniform vec2 uRes; uniform float uT; uniform float uLoops;
uniform vec3 uSunDir; uniform float uNight; uniform float uCloudA; uniform float uCloudQ;
uniform float uRain; uniform float uSnow; uniform float uFog; uniform float uStorm; uniform float uWindX;
uniform vec2 uMoon; uniform float uMoonI;
uniform float uCaus; uniform float uCA; uniform float uWxT;
float hash21(vec2 p){ p=fract(p*vec2(234.34,435.345)); p+=dot(p,p+34.23); return fract(p.x*p.y); }
float noise(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float a=hash21(i), b=hash21(i+vec2(1.,0.)), c0=hash21(i+vec2(0.,1.)), d=hash21(i+vec2(1.,1.));
  return mix(mix(a,b,f.x), mix(c0,d,f.x), f.y);
}
float fbm(vec2 p){
  float v=0.0, a=0.5; mat2 r=mat2(0.8,-0.6,0.6,0.8);
  for(int i=0;i<8;i++){
    v += a*noise(p)*step(float(i), float(OCT-1));
    p = r*p*2.03+11.7; a*=0.5;
  }
  return v;
}
vec3 skyGrad(vec3 rd, vec3 sd){
  float sunH=clamp(sd.y,-0.12,1.0), up=clamp(rd.y,0.0,1.0);
  float day=smoothstep(0.03,0.30,sunH), twi=smoothstep(-0.14,0.03,sunH);
  vec3 zen=mix(vec3(0.004,0.008,0.030), mix(vec3(0.10,0.10,0.30), vec3(0.10,0.34,0.78), day), twi);
  vec3 hor=mix(vec3(0.02,0.05,0.10),  mix(vec3(0.95,0.45,0.22), vec3(0.62,0.78,0.94), day), twi);
  vec3 base=mix(hor, zen, pow(up,0.62));
  float sdR=max(dot(rd,sd),0.0);
  base+=vec3(1.0,0.75,0.42)*pow(sdR,6.0)*0.22*twi;
  base+=vec3(0.55,0.75,1.0)*pow(1.0-up,3.0)*0.10*day;
  base+=vec3(0.35,0.55,0.95)*pow(1.0-up,4.0)*0.06*uNight;
  return base;
}
void main(){
  vec2 uv=vUv;
  vec2 asp=vec2(uRes.x/uRes.y,1.0);
  vec2 p=(uv-0.5)*asp;
  vec3 rd=normalize(vec3(p.x,p.y*1.15-0.12,1.15));
  vec3 sd=normalize(uSunDir);
  float t=uT;
  vec3 col=skyGrad(rd,sd);
  float sdR=max(dot(rd,sd),0.0);
  col+=vec3(1.0,0.86,0.60)*smoothstep(0.9993,0.99975,sdR)*5.0*step(-0.05,sd.y);
  col+=vec3(1.0,0.70,0.38)*pow(sdR,160.0)*0.9;
  col+=vec3(1.0,0.60,0.30)*pow(sdR,8.0)*0.35;
#if WARP > 0
  if(uNight>0.02){
    vec2 sp=uv*vec2(uRes.x/uRes.y,1.0)*220.0;
    vec2 id=floor(sp); float h=hash21(id);
    if(h>0.986){
      vec2 f=fract(sp)-0.5;
      col+=vec3(0.85,0.92,1.0)*smoothstep(0.10,0.0,length(f))*(0.6+0.4*sin(t*2.0+h*90.0))*uNight*smoothstep(0.5,0.05,uv.y);
    }
  }
#endif
  vec2 mp=(uv-uMoon)*asp; float mr=length(mp);
  col+=vec3(0.85,0.90,1.0)*smoothstep(0.023,0.017,mr)*uMoonI*uNight;
  col+=vec3(0.50,0.62,0.90)*exp(-mr*9.0)*0.30*uMoonI*uNight;
#if WARP > 1
  if(uCloudA>0.003 && uCloudQ>0.01 && rd.y>0.02){
    vec2 cp=rd.xz/(rd.y+0.18)*0.55 + vec2(t*0.008*(0.4+uWindX*0.6), t*0.002);
    vec2 wq=vec2(fbm(cp*0.6+t*0.02), fbm(cp*0.6-t*0.015));
    float cl=fbm(cp*1.15+wq*(0.8+0.5*float(WARP)));
    cl=smoothstep(0.56-uCloudA*0.20-uCloudQ*0.08, 0.90, cl+uCloudA*0.16);
    vec3 ccol=mix(vec3(0.05,0.07,0.12), vec3(0.95,0.97,1.0), smoothstep(-0.1,0.25,sd.y));
    ccol+=vec3(1.0,0.5,0.25)*pow(sdR,3.0)*0.35*smoothstep(0.15,-0.05,sd.y);
    col=mix(col, ccol, cl*uCloudA*smoothstep(0.02,0.22,rd.y)*0.9);
  }
#endif
  /* water band: waves, fresnel, specular, caustics */
  float wn=0.0;
  for(int i=0;i<14;i++){
    float fi=float(i);
    wn+=sin(uv.x*(18.0+fi*7.0)+t*(0.6+fi*0.13)+fi)*(0.004+0.002*sin(fi*3.7))*step(fi,uLoops*0.06);
  }
  float wline=0.22+wn;
  if(uv.y<wline+0.04){
    float wr=clamp((wline-uv.y)/(wline+0.12),0.0,1.0);
    vec3 nrm=normalize(vec3(
      sin(uv.x*46.0+t*1.7)*0.18+sin(uv.x*121.0-t*2.6)*0.10, 1.0,
      cos(uv.x*33.0+t*1.1)*0.14+sin(uv.y*90.0+t*2.0)*0.08));
    vec3 refl=skyGrad(normalize(vec3(rd.x,abs(rd.y)+0.22,rd.z)),sd);
    float fres=0.04+0.96*pow(1.0-max(nrm.y,0.0),5.0);
    vec3 deep=mix(vec3(0.01,0.06,0.12), vec3(0.02,0.16,0.28), smoothstep(-0.1,0.4,sd.y));
    vec3 wc=mix(deep,refl,clamp(fres+0.12,0.0,1.0));
    vec3 hv=normalize(sd+vec3(0.0,1.0,0.25));
    wc+=vec3(1.0,0.9,0.7)*pow(max(dot(nrm,hv),0.0),120.0)*1.2*step(-0.03,sd.y);
    float ca=0.0;
    for(int i=0;i<14;i++){
      float fi=float(i);
      vec2 q=uv*vec2(9.0+fi*1.7,26.0+fi*2.3)+vec2(t*(0.10+fi*0.02),t*(0.07+fi*0.013));
      ca+=step(fi,uCaus-0.5)*pow(max(0.0,sin(q.x)*sin(q.y)+sin(q.x*0.7+q.y*1.3+t*0.5)),3.0)/(1.0+fi*0.4);
    }
    wc+=vec3(0.30,0.75,1.0)*ca*0.10*wr;
    col=mix(col,wc,smoothstep(wline+0.04,wline-0.02,uv.y));
  }
  /* heavy FBM domain-warp field */
  float acc=0.0, acc2=0.0;
  vec2 q0=uv*3.0+vec2(t*0.02,0.0);
#if WARP >= 1
  vec2 w1=vec2(fbm(q0*0.9), fbm(q0*0.9+5.2));
  acc+=fbm(q0+w1*1.4);
#endif
#if WARP >= 2
  vec2 w2=vec2(fbm(q0*1.7+w1*2.0+t*0.03), fbm(q0*1.7-w1+3.1));
  acc2+=fbm(q0*1.3+w2*1.8);
#endif
#if WARP >= 3
  acc+=0.5*fbm(q0*2.6+acc2*2.2+vec2(t*0.05,-t*0.02));
#endif
  /* master procedural loop — caustic filaments + haze samples */
  float fil=0.0;
#if GL3
  for(int i=0;i<256;i++){
    float fi=float(i);
    if(fi>=uLoops) break;
    float en=1.0;
#else
  for(int i=0;i<160;i++){
    float fi=float(i);
    float en=step(fi,uLoops-0.5);
#endif
    vec2 q=p*(1.2+fi*0.017);
    q.x+=sin(t*0.35+fi*0.73+q.y*3.2)*0.018;
    q.y+=cos(t*0.29+fi*0.41+q.x*4.1)*0.014;
    float n=noise(q*3.0+vec2(t*0.03*fi,t*0.02*fi));
    float r=length(q+vec2(sin(fi)*0.04,cos(fi*1.7)*0.03));
    fil+=en*exp(-r*(2.5+mod(fi,7.0)*0.45))*n*(0.55+0.45*sin(fi*1.7+t));
    acc+=en*n*0.0025;
  }
  col+=vec3(0.05,0.30,0.80)*pow(max(fil*0.035+acc*0.4,0.0),2.2)*(0.5+uCaus*0.12);
  float aur=fbm(vec2(uv.x*3.0+t*0.05,uv.y*6.0+acc2))*smoothstep(0.35,0.9,uv.y);
  col+=vec3(0.10,0.85,0.55)*aur*0.10*uNight*(0.4+uStorm);
  if(uStorm>0.01){
    float se=fbm(vec2(uv.x*5.0-t*0.4,uv.y*3.0+t*0.3)+acc2*2.0);
    col+=vec3(0.55,0.65,1.0)*pow(max(se,0.0),3.0)*uStorm*0.8;
  }
  if(uRain>0.01){
    vec2 rp=vec2(uv.x*140.0,uv.y*26.0+t*26.0+uv.x*uWindX*8.0);
    col+=vec3(0.55,0.70,0.95)*step(0.994,hash21(floor(rp)))*0.30*uRain;
  }
  if(uSnow>0.01){
    vec2 snp=vec2(uv.x*90.0+sin(t+uv.y*8.0)*2.0,uv.y*34.0+t*3.5);
    col+=vec3(1.0)*step(0.995,hash21(floor(snp)))*0.22*uSnow;
  }
  col=mix(col,vec3(0.62,0.67,0.74),clamp(uFog*(0.75-uv.y*0.3),0.0,0.9));
  col+=vec3(0.03,0.05,0.09)*uWxT;
  col+=vec3(0.10,0.30,0.60)*pow(max(1.0-abs(uv.y-0.5)*1.7,0.0),2.0)*0.10;
  float ch=0.006*sin(t*0.6+uv.y*13.0)*uCA;
  col.r+=max(ch,0.0)*0.8; col.b+=max(-ch,0.0)*1.2;
  FRAG=vec4(max(col,0.0),1.0);
}`;
}

const BLUR_FRAG = () => fsHead() + `
uniform sampler2D uTex; uniform vec2 uRes; uniform vec2 uDir;
void main(){
  vec2 px=uDir/uRes;
  vec3 s=${GLSL3 ? 'texture' : 'texture2D'}(uTex,vUv).rgb*0.227027;
  s+=(${GLSL3 ? 'texture' : 'texture2D'}(uTex,vUv+px*1.3846).rgb+${GLSL3 ? 'texture' : 'texture2D'}(uTex,vUv-px*1.3846).rgb)*0.3162162;
  s+=(${GLSL3 ? 'texture' : 'texture2D'}(uTex,vUv+px*3.2308).rgb+${GLSL3 ? 'texture' : 'texture2D'}(uTex,vUv-px*3.2308).rgb)*0.0702703;
  FRAG=vec4(s,1.0);
}`;

const COMP_FRAG = () => fsHead() + `
uniform sampler2D uScene; uniform sampler2D uBloom;
uniform vec2 uRes; uniform float uT;
uniform float uFxCA; uniform float uFxFilm; uniform float uMode; uniform float uBloomStr;
void main(){
  vec2 uv=vUv, cc=uv-0.5;
  float r2=dot(cc,cc);
  vec2 off=cc*r2*0.06*uFxCA;
  vec3 c;
  c.r=${GLSL3 ? 'texture' : 'texture2D'}(uScene,uv+off).r;
  c.g=${GLSL3 ? 'texture' : 'texture2D'}(uScene,uv).g;
  c.b=${GLSL3 ? 'texture' : 'texture2D'}(uScene,uv-off).b;
  vec3 b=${GLSL3 ? 'texture' : 'texture2D'}(uBloom,uv).rgb;
  c+=max(b-0.62,0.0)/0.38*0.85*uBloomStr;
  if(uMode>1.5){ c=pow(c,vec3(1.12))*vec3(1.06,1.0,0.94); }
  else if(uMode>0.5){ c*=1.0+r2*0.25; }
  c=c/(1.0+c*0.55);
  c*=1.0-smoothstep(0.55,1.25,length(cc)*1.4)*0.38;
  float g=fract(sin(dot(uv*uRes+uT*60.0,vec2(12.9898,78.233)))*43758.5453);
  c+=(g-0.5)*0.035*uFxFilm;
  FRAG=vec4(c,1.0);
}`;

function makeRT(w, h) {
  const tex = GL.createTexture();
  GL.bindTexture(GL.TEXTURE_2D, tex);
  GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
  GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.LINEAR);
  GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE);
  GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE);
  let fmt = 'RGBA8';
  if (IS2 && extCBF) {
    GL.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA16F, w, h, 0, GL.RGBA, GL.HALF_FLOAT, null);
    fmt = 'RGBA16F';
  } else {
    GL.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, w, h, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
  }
  const fbo = GL.createFramebuffer();
  GL.bindFramebuffer(GL.FRAMEBUFFER, fbo);
  GL.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, tex, 0);
  const ok = GL.checkFramebufferStatus(GL.FRAMEBUFFER) === GL.FRAMEBUFFER_COMPLETE;
  GL.bindFramebuffer(GL.FRAMEBUFFER, null);
  if (!ok) {
    GL.deleteFramebuffer(fbo); GL.deleteTexture(tex);
    if (fmt === 'RGBA16F') {
      const tex8 = GL.createTexture();
      GL.bindTexture(GL.TEXTURE_2D, tex8);
      GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
      GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.LINEAR);
      GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE);
      GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE);
      GL.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, w, h, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
      const fbo8 = GL.createFramebuffer();
      GL.bindFramebuffer(GL.FRAMEBUFFER, fbo8);
      GL.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, tex8, 0);
      const ok8 = GL.checkFramebufferStatus(GL.FRAMEBUFFER) === GL.FRAMEBUFFER_COMPLETE;
      GL.bindFramebuffer(GL.FRAMEBUFFER, null);
      if (ok8) return { fbo: fbo8, tex: tex8, w, h, fmt: 'RGBA8' };
      GL.deleteFramebuffer(fbo8); GL.deleteTexture(tex8);
    }
    return null;
  }
  return { fbo, tex, w, h, fmt };
}
function delRT(r) { if (r && GL && !GL.isContextLost()) { GL.deleteFramebuffer(r.fbo); GL.deleteTexture(r.tex); } }
function buildRTs() {
  delRT(rt.scene); delRT(rt.a); delRT(rt.b);
  rt.scene = rt.a = rt.b = null; sceneHdr = false; rtFmt = 'NONE';
  const w = mainCv.width, h = mainCv.height;
  if (!w || !h) return;
  rt.scene = makeRT(w, h); rt.a = makeRT(w, h); rt.b = makeRT(w, h);
  if (!rt.scene || !rt.a || !rt.b) {
    delRT(rt.scene); delRT(rt.a); delRT(rt.b);
    rt.scene = rt.a = rt.b = null;
  } else {
    sceneHdr = true; rtFmt = rt.scene.fmt;
  }
}

function buildPipeline() {
  if (!GL) { glOK = false; return; }
  progSky  = shProgram(GLSL3 ? V3 : V1, skyFragSrc(), { aPos: 0 });
  progBlur = shProgram(GLSL3 ? V3 : V1, BLUR_FRAG(), { aPos: 0 });
  progComp = shProgram(GLSL3 ? V3 : V1, COMP_FRAG(), { aPos: 0 });
  if (!progSky || !progBlur || !progComp) {
    glOK = false;
    console.warn('[AERO] shader pipeline unavailable — Canvas2D mode.');
    return;
  }
  if (!quadBuf) {
    quadBuf = GL.createBuffer();
    GL.bindBuffer(GL.ARRAY_BUFFER, quadBuf);
    GL.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), GL.STATIC_DRAW);
  }
  if (IS2 && !quadVAO) {
    quadVAO = GL.createVertexArray();
    GL.bindVertexArray(quadVAO);
    GL.bindBuffer(GL.ARRAY_BUFFER, quadBuf);
    GL.enableVertexAttribArray(0);
    GL.vertexAttribPointer(0, 2, GL.FLOAT, false, 0, 0);
    GL.bindVertexArray(null);
  }
  uSky = {};
  ['uRes','uT','uLoops','uSunDir','uNight','uCloudA','uCloudQ','uRain','uSnow','uFog','uStorm','uWindX','uMoon','uMoonI','uCaus','uCA','uWxT']
    .forEach(n => uSky[n] = GL.getUniformLocation(progSky, n));
  uBlur = { tex: GL.getUniformLocation(progBlur, 'uTex'), res: GL.getUniformLocation(progBlur, 'uRes'), dir: GL.getUniformLocation(progBlur, 'uDir') };
  uComp = {};
  ['uScene','uBloom','uRes','uT','uFxCA','uFxFilm','uMode','uBloomStr'].forEach(n => uComp[n] = GL.getUniformLocation(progComp, n));
  glOK = true;
  buildRTs();
  Parts.rebuild();
  resizeGPU();
}
function rebuildShader() {
  if (!GL || !glOK) return;
  if (progSky) GL.deleteProgram(progSky);
  progSky = shProgram(GLSL3 ? V3 : V1, skyFragSrc(), { aPos: 0 });
  if (progSky) {
    uSky = {};
    ['uRes','uT','uLoops','uSunDir','uNight','uCloudA','uCloudQ','uRain','uSnow','uFog','uStorm','uWindX','uMoon','uMoonI','uCaus','uCA','uWxT']
      .forEach(n => uSky[n] = GL.getUniformLocation(progSky, n));
  }
}

function bindQuad() {
  if (IS2) { GL.bindVertexArray(quadVAO); return; }
  GL.bindBuffer(GL.ARRAY_BUFFER, quadBuf);
  GL.enableVertexAttribArray(0);
  GL.vertexAttribPointer(0, 2, GL.FLOAT, false, 0, 0);
}
function blit() { GL.drawArrays(GL.TRIANGLE_STRIP, 0, 4); gpuCounters.draws++; gpuCounters.tris += 2; }

function resizeGPU() {
  if (!glOK) { internalRes = 'CANVAS MODE'; return; }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = Math.floor(W * dpr * P.renderScale), h = Math.floor(H * dpr * P.renderScale);
  const px = w * h;
  if (px > MAX_PIXELS) { const k = Math.sqrt(MAX_PIXELS / px); w = Math.floor(w * k); h = Math.floor(h * k); }
  if (mainCv.width !== w || mainCv.height !== h) {
    mainCv.width = w; mainCv.height = h;
    buildRTs();
  }
  internalRes = w + ' × ' + h;
}

function blurPass(srcTex, dst, dx, dy) {
  GL.bindFramebuffer(GL.FRAMEBUFFER, dst.fbo);
  GL.viewport(0, 0, dst.w, dst.h);
  GL.useProgram(progBlur);
  bindQuad();
  GL.activeTexture(GL.TEXTURE0);
  GL.bindTexture(GL.TEXTURE_2D, srcTex);
  GL.uniform1i(uBlur.tex, 0);
  GL.uniform2f(uBlur.res, dst.w, dst.h);
  GL.uniform2f(uBlur.dir, dx, dy);
  blit();
}

function renderGPU(time, sun, moon) {
  if (!glOK || !progSky) return;
  const t = time * 0.001;
  const wx = P.wx === 'auto' ? (S.wxNow || 'clear') : P.wx;
  const night = clamp((-sun.altDeg + 4) / 14, 0, 1);
  const windKmh = P.windOv !== -1 ? P.windOv : (S.windFromAPI != null ? S.windFromAPI : 8);
  const sd = sunDir3(sun);
  const mode = P.fxMode === 'hdr' ? 0 : P.fxMode === 'ca' ? 1 : 2;
  GL.disable(GL.BLEND);

  const haveRT = !!rt.scene;
  GL.bindFramebuffer(GL.FRAMEBUFFER, haveRT ? rt.scene.fbo : null);
  GL.viewport(0, 0, mainCv.width, mainCv.height);
  GL.useProgram(progSky);
  bindQuad();
  GL.uniform2f(uSky.uRes, mainCv.width, mainCv.height);
  GL.uniform1f(uSky.uT, t);
  GL.uniform1f(uSky.uLoops, effLoops());
  GL.uniform3f(uSky.uSunDir, sd[0], sd[1], sd[2]);
  GL.uniform1f(uSky.uNight, night);
  GL.uniform1f(uSky.uCloudA, wx === 'clear' ? 0.18 : wx === 'rain' ? 0.8 : wx === 'snow' ? 0.75 : 0.95);
  GL.uniform1f(uSky.uCloudQ, QN[P.cloud] / 4);
  GL.uniform1f(uSky.uRain, (wx === 'rain' || wx === 'thunder') ? 1 : 0);
  GL.uniform1f(uSky.uSnow, wx === 'snow' ? 1 : 0);
  GL.uniform1f(uSky.uFog, S.fogA);
  GL.uniform1f(uSky.uStorm, S.stormF);
  GL.uniform1f(uSky.uWindX, clamp(windKmh / 60, -2, 2));
  const mAz = (((moon ? moon.azDeg : 200) - 180) * RAD * 0.35);
  const mAlt = clamp(moon ? moon.altDeg : -20, -25, 90) * RAD;
  GL.uniform2f(uSky.uMoon, 0.5 + Math.sin(mAz) * Math.cos(mAlt) * 0.38,
                           clamp(0.62 - Math.sin(mAlt) * 0.5, 0.06, 0.92));
  GL.uniform1f(uSky.uMoonI, moon ? moon.illum : 0);
  GL.uniform1f(uSky.uCaus, CAUS_ITER[P.caustic]);
  GL.uniform1f(uSky.uCA, P.fxMode === 'ca' ? 1.6 : 0.6);
  GL.uniform1f(uSky.uWxT, wx === 'thunder' ? 0.5 : wx === 'rain' ? 0.3 : 0);
  blit();
  Parts.draw(t);

  if (!haveRT) return;   /* direct-to-screen degraded path */

  let srcTex = rt.scene.tex, dst = rt.a, bloomTex = rt.scene.tex;
  for (let i = 0; i < P.postPasses; i++) {
    blurPass(srcTex, dst, 1, 0);
    srcTex = dst.tex; dst = (dst === rt.a) ? rt.b : rt.a;
    blurPass(srcTex, dst, 0, 1);
    srcTex = dst.tex; dst = (dst === rt.a) ? rt.b : rt.a;
    bloomTex = srcTex;
  }

  GL.bindFramebuffer(GL.FRAMEBUFFER, null);
  GL.viewport(0, 0, mainCv.width, mainCv.height);
  GL.useProgram(progComp);
  bindQuad();
  GL.activeTexture(GL.TEXTURE0); GL.bindTexture(GL.TEXTURE_2D, rt.scene.tex);
  GL.activeTexture(GL.TEXTURE1); GL.bindTexture(GL.TEXTURE_2D, bloomTex);
  GL.uniform1i(uComp.uScene, 0);
  GL.uniform1i(uComp.uBloom, 1);
  GL.uniform2f(uComp.uRes, mainCv.width, mainCv.height);
  GL.uniform1f(uComp.uT, t);
  GL.uniform1f(uComp.uFxCA, P.fxMode === 'ca' ? 1.8 : 0.8);
  GL.uniform1f(uComp.uFxFilm, P.fxMode === 'film' ? 1.2 : 0.45);
  GL.uniform1f(uComp.uMode, mode);
  GL.uniform1f(uComp.uBloomStr, P.postPasses > 0 ? 1.0 : 0.0);
  blit();
  GL.activeTexture(GL.TEXTURE1); GL.bindTexture(GL.TEXTURE_2D, null);
  GL.activeTexture(GL.TEXTURE0);
}

/* ================= GPU PARTICLES =================
   GL2: transform-feedback simulation entirely on GPU (interleaved x,y,vx,vy,seed).
   GL1: identical visual with a CPU Float32 sim (capped at 50k). */
const Parts = {
  n: 0, mode: 'NONE',
  bufs: null, vaos: null, cur: 0, tfProg: null, drProg: null,
  uSim: null, uDraw: null,
  cpu: null, glBuf: null,
  destroy() {
    if (!GL || GL.isContextLost()) { this.bufs = this.vaos = null; this.tfProg = this.drProg = null; this.glBuf = null; this.n = 0; return; }
    if (this.bufs) this.bufs.forEach(b => GL.deleteBuffer(b));
    if (this.vaos) this.vaos.forEach(v => GL.deleteVertexArray(v));
    if (this.tfProg) GL.deleteProgram(this.tfProg);
    if (this.drProg) GL.deleteProgram(this.drProg);
    if (this.glBuf) GL.deleteBuffer(this.glBuf);
    this.bufs = this.vaos = null; this.tfProg = this.drProg = null; this.glBuf = null; this.n = 0;
  },
  cap() { return IS2 ? P.particles : Math.min(P.particles, 50000); },
  rebuild() {
    if (!GL || !glOK) { this.mode = 'NONE'; return; }
    this.destroy();
    const n = this.cap();
    this.n = n;
    const data = new Float32Array(n * 5);
    for (let i = 0; i < n; i++) {
      const o = i * 5;
      data[o] = Math.random(); data[o + 1] = Math.random();
      data[o + 2] = (Math.random() - 0.5) * 0.2; data[o + 3] = (Math.random() - 0.5) * 0.2;
      data[o + 4] = i * 0.61803 + Math.random();
    }
    if (IS2) {
      const vsSim = `#version 300 es
        layout(location=0) in vec4 aS; layout(location=1) in float aW;
        uniform float uDt,uT,uWind,uGrav,uTurb;
        out vec4 vS; out float vW;
        float h(float s){ return fract(sin(s*127.1)*43758.5453); }
        void main(){
          vec2 p=aS.xy, v=aS.zw; float w=aW;
          float ty=floor(h(w)*5.0);
          float g = ty<0.5 ? 0.02 : ty<1.5 ? 0.85 : ty<2.5 ? 0.10 : ty<3.5 ? -0.06 : 0.0;
          v.y -= uGrav*g*uDt;
          v.x += uWind*(0.25+0.5*h(w+1.3))*uDt;
          v += uTurb*uDt*0.4*vec2(sin(p.y*6.3+uT*0.8+w*4.0), cos(p.x*5.2-uT*0.6+w*3.0));
          v *= 0.996;
          p = fract(p + v*uDt*0.16);
          vS = vec4(p, v); vW = w;
        }`;
      const fsNull = '#version 300 es\nvoid main(){}';
      this.tfProg = GL.createProgram();
      const vs = shCompile(GL.VERTEX_SHADER, vsSim), fs = shCompile(GL.FRAGMENT_SHADER, fsNull);
      if (!vs || !fs) { this.mode = 'NONE'; return; }
      GL.attachShader(this.tfProg, vs); GL.attachShader(this.tfProg, fs);
      GL.transformFeedbackVaryings(this.tfProg, ['vS', 'vW'], GL.INTERLEAVED_ATTRIBS);
      GL.linkProgram(this.tfProg);
      GL.deleteShader(vs); GL.deleteShader(fs);
      if (!GL.getProgramParameter(this.tfProg, GL.LINK_STATUS)) { this.mode = 'NONE'; return; }
      this.uSim = {
        dt: GL.getUniformLocation(this.tfProg, 'uDt'), t: GL.getUniformLocation(this.tfProg, 'uT'),
        wind: GL.getUniformLocation(this.tfProg, 'uWind'), grav: GL.getUniformLocation(this.tfProg, 'uGrav'),
        turb: GL.getUniformLocation(this.tfProg, 'uTurb')
      };
      const vsDraw = `#version 300 es
        layout(location=0) in vec4 aS; layout(location=1) in float aW;
        uniform float uSize,uT; uniform vec4 uMix;
        out float vA; out vec3 vC; out float vTy;
        float h(float s){ return fract(sin(s*127.1)*43758.5453); }
        void main(){
          float w=aW; float ty=floor(h(w)*5.0);
          float m = ty<0.5 ? uMix.x : ty<1.5 ? uMix.y : ty<2.5 ? uMix.z : ty<3.5 ? uMix.w : uMix.x;
          vTy=ty;
          if(m<0.01){ gl_Position=vec4(2.0,2.0,2.0,1.0); gl_PointSize=1.0; vA=0.0; vC=vec3(0.0); return; }
          gl_Position=vec4(aS.xy*2.0-1.0,0.0,1.0);
          float sz=uSize*(0.6+0.8*h(w+2.7));
          if(ty>0.5&&ty<1.5) sz*=1.7;
          gl_PointSize=clamp(sz,1.0,14.0);
          vA=m*(0.35+0.65*h(w+3.1));
          vC = ty<0.5 ? vec3(0.55,0.75,1.0) : ty<1.5 ? vec3(0.65,0.80,1.0)
             : ty<2.5 ? vec3(0.95,0.97,1.0) : ty<3.5 ? vec3(0.45,0.95,0.85) : vec3(0.90,0.95,1.00);
        }`;
      const fsDraw = `#version 300 es
        precision highp float; in float vA; in vec3 vC; in float vTy; out vec4 o;
        void main(){
          vec2 q=gl_PointCoord*2.0-1.0; float d=dot(q,q);
          float a=vA*exp(-d*3.0)*step(d,1.0);
          if(vTy>0.5&&vTy<1.5) a*=smoothstep(1.0,0.2,abs(q.x)*3.0);
          o=vec4(vC*a,a);
        }`;
      this.drProg = shProgram(vsDraw, fsDraw, null);
      if (!this.drProg) { this.mode = 'NONE'; return; }
      this.uDraw = {
        size: GL.getUniformLocation(this.drProg, 'uSize'),
        t: GL.getUniformLocation(this.drProg, 'uT'),
        mix: GL.getUniformLocation(this.drProg, 'uMix')
      };
      this.bufs = [GL.createBuffer(), GL.createBuffer()];
      this.vaos = [null, null];
      for (let k = 0; k < 2; k++) {
        GL.bindBuffer(GL.ARRAY_BUFFER, this.bufs[k]);
        GL.bufferData(GL.ARRAY_BUFFER, data, GL.STATIC_DRAW);
        const vao = GL.createVertexArray();
        GL.bindVertexArray(vao);
        GL.enableVertexAttribArray(0);
        GL.vertexAttribPointer(0, 4, GL.FLOAT, false, 20, 0);
        GL.enableVertexAttribArray(1);
        GL.vertexAttribPointer(1, 1, GL.FLOAT, false, 20, 16);
        GL.bindVertexArray(null);
        this.vaos[k] = vao;
      }
      this.cur = 0;
      this.mode = 'TF';
    } else {
      /* WebGL1: CPU simulation, single dynamic VBO. */
      this.cpu = data;
      this.glBuf = GL.createBuffer();
      GL.bindBuffer(GL.ARRAY_BUFFER, this.glBuf);
      GL.bufferData(GL.ARRAY_BUFFER, data.byteLength, GL.DYNAMIC_DRAW);
      const vsDraw = `attribute vec4 aS; attribute float aW;
        uniform float uSize,uT; uniform vec4 uMix;
        varying float vA; varying vec3 vC; varying float vTy;
        float h(float s){ return fract(sin(s*127.1)*43758.5453); }
        void main(){
          float w=aW; float ty=floor(h(w)*5.0);
          float m = ty<0.5 ? uMix.x : ty<1.5 ? uMix.y : ty<2.5 ? uMix.z : ty<3.5 ? uMix.w : uMix.x;
          vTy=ty;
          if(m<0.01){ gl_Position=vec4(2.0,2.0,2.0,1.0); gl_PointSize=1.0; vA=0.0; vC=vec3(0.0); return; }
          gl_Position=vec4(aS.xy*2.0-1.0,0.0,1.0);
          float sz=uSize*(0.6+0.8*h(w+2.7));
          if(ty>0.5&&ty<1.5) sz*=1.7;
          gl_PointSize=clamp(sz,1.0,14.0);
          vA=m*(0.35+0.65*h(w+3.1));
          vC = ty<0.5 ? vec3(0.55,0.75,1.0) : ty<1.5 ? vec3(0.65,0.80,1.0)
             : ty<2.5 ? vec3(0.95,0.97,1.0) : ty<3.5 ? vec3(0.45,0.95,0.85) : vec3(0.90,0.95,1.00);
        }`;
      const fsDraw = `precision highp float;
        varying float vA; varying vec3 vC; varying float vTy;
        void main(){
          vec2 q=gl_PointCoord*2.0-1.0; float d=dot(q,q);
          float a=vA*exp(-d*3.0)*step(d,1.0);
          if(vTy>0.5&&vTy<1.5) a*=smoothstep(1.0,0.2,abs(q.x)*3.0);
          gl_FragColor=vec4(vC*a,a);
        }`;
      this.drProg = shProgram(vsDraw, fsDraw, { aS: 0, aW: 1 });
      if (!this.drProg) { this.mode = 'NONE'; return; }
      this.uDraw = {
        size: GL.getUniformLocation(this.drProg, 'uSize'),
        t: GL.getUniformLocation(this.drProg, 'uT'),
        mix: GL.getUniformLocation(this.drProg, 'uMix')
      };
      this.mode = 'CPU';
    }
  },
  mixVec() {
    const wx = P.wx === 'auto' ? (S.wxNow || 'clear') : P.wx;
    const night = S.amb < 0.5 ? 1 : 0;
    if (wx === 'rain')    return [0.35, 1.0, 0.05, 0.3 + S.stormF];
    if (wx === 'thunder') return [0.3, 0.9, 0.05, 0.5 + S.stormF];
    if (wx === 'snow')    return [0.3, 0.05, 1.0, 0.1];
    if (wx === 'fog')     return [0.7, 0.1, 0.1, 0.1];
    return night ? [0.9, 0, 0, 0.2] : [0.8, 0, 0, 0.15];
  },
  /* Swirl phase uses the same clock (t, seconds since load) as the GPU sim,
     so GL1 and GL2 backends evolve identically. */
  stepCpu(dtS, wind, turb, t) {
    const d = this.cpu, n = this.n;
    for (let i = 0; i < n; i++) {
      const o = i * 5;
      const w = d[o + 4];
      const s = Math.sin(w * 127.1) * 43758.5453, h = s - Math.floor(s);
      const ty = Math.floor(h * 5);
      const g = ty === 0 ? 0.02 : ty === 1 ? 0.85 : ty === 2 ? 0.10 : ty === 3 ? -0.06 : 0;
      const px = d[o], py = d[o + 1];
      d[o + 3] -= P.gravity * g * dtS;
      d[o + 2] += wind * (0.25 + 0.5 * h) * dtS;
      d[o + 2] += turb * dtS * 0.4 * Math.sin(py * 6.3 + t * 0.8 + w * 4.0);
      d[o + 3] += turb * dtS * 0.4 * Math.cos(px * 5.2 - t * 0.6 + w * 3.0);
      d[o + 2] *= 0.996; d[o + 3] *= 0.996;
      d[o] = (d[o] + d[o + 2] * dtS * 0.16) % 1; if (d[o] < 0) d[o] += 1;
      d[o + 1] = (d[o + 1] + d[o + 3] * dtS * 0.16) % 1; if (d[o + 1] < 0) d[o + 1] += 1;
    }
  },
  draw(t) {
    if (!glOK || this.mode === 'NONE' || !this.n) return;
    const dtS = clamp(lastDt, 0, 50) / 1000;
    const windKmh = P.windOv !== -1 ? P.windOv : (S.windFromAPI != null ? S.windFromAPI : 8);
    const wind = clamp(windKmh / 60, -2, 2) * 0.06;
    const turb = 0.15 + S.stormF * 0.5;
    const mv = this.mixVec();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ptSize = clamp(P.dropSize * 0.45 * Math.min(dpr * P.renderScale, 2.5), 1, 14);

    if (this.mode === 'TF') {
      const src = this.cur, dst = 1 - this.cur;
      GL.useProgram(this.tfProg);
      GL.bindVertexArray(this.vaos[src]);
      GL.uniform1f(this.uSim.dt, dtS);
      GL.uniform1f(this.uSim.t, t);
      GL.uniform1f(this.uSim.wind, wind);
      GL.uniform1f(this.uSim.grav, P.gravity);
      GL.uniform1f(this.uSim.turb, turb);
      GL.enable(GL.RASTERIZER_DISCARD);
      GL.bindBufferBase(GL.TRANSFORM_FEEDBACK_BUFFER, 0, this.bufs[dst]);
      GL.beginTransformFeedback(GL.POINTS);
      GL.drawArrays(GL.POINTS, 0, this.n);
      GL.endTransformFeedback();
      GL.bindBufferBase(GL.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      GL.disable(GL.RASTERIZER_DISCARD);
      GL.bindVertexArray(null);
      this.cur = dst;
      GL.useProgram(this.drProg);
      GL.bindVertexArray(this.vaos[this.cur]);
    } else {
      this.stepCpu(dtS, wind, turb, t);
      GL.bindBuffer(GL.ARRAY_BUFFER, this.glBuf);
      GL.bufferSubData(GL.ARRAY_BUFFER, 0, this.cpu);
      GL.useProgram(this.drProg);
      GL.enableVertexAttribArray(0);
      GL.vertexAttribPointer(0, 4, GL.FLOAT, false, 20, 0);
      GL.enableVertexAttribArray(1);
      GL.vertexAttribPointer(1, 1, GL.FLOAT, false, 20, 16);
    }
    GL.uniform1f(this.uDraw.size, ptSize);
    GL.uniform1f(this.uDraw.t, t);
    GL.uniform4f(this.uDraw.mix, mv[0], mv[1], mv[2], mv[3]);
    GL.enable(GL.BLEND);
    GL.blendFunc(GL.ONE, GL.ONE);
    GL.drawArrays(GL.POINTS, 0, this.n);
    gpuCounters.draws++;
    gpuCounters.parts += this.n;
    GL.disable(GL.BLEND);
    if (IS2) GL.bindVertexArray(null);
  }
};

/* ================= PHYSICS ARENA =================
   Worker runs the same elastic solver as v2.8 with momentum transfer:
   spatial hash ≤256 (AUTO), brute O(n²) above — or forced either way.
   After each (re)alloc the worker transfers its radii back once so the
   DOM/canvas visuals match the true collision circles. */
const WORKER_SRC = `
'use strict';
let n=0,W=800,H=430,solver='AUTO',elas=1,zeroG=true,windX=0;
let dragI=-1,dragX=0,dragY=0,rrSent=true;
let px,py,vx,vy,rr,mm;
function alloc(c){
  n=c; rrSent=false;
  px=new Float32Array(n);py=new Float32Array(n);vx=new Float32Array(n);vy=new Float32Array(n);
  rr=new Float32Array(n);mm=new Float32Array(n);
  const small=n>256;
  for(let i=0;i<n;i++){
    const r=small?4+Math.random()*5:9+Math.random()*10;
    rr[i]=r;mm[i]=r*0.08;
    px[i]=r+Math.random()*Math.max(1,W-2*r);
    py[i]=r+Math.random()*Math.max(1,H-2*r);
    vx[i]=(Math.random()-.5)*9;vy[i]=(Math.random()-.5)*9;
  }
}
function resolve(i,j,dist,md){
  const nx=(px[j]-px[i])/dist, ny=(py[j]-py[i])/dist, ov=md-dist;
  const wi=(i===dragI)?0:1, wj=(j===dragI)?0:1, tot=wi+wj||1;
  px[i]-=nx*ov*wi/tot; py[i]-=ny*ov*wi/tot;
  px[j]+=nx*ov*wj/tot; py[j]+=ny*ov*wj/tot;
  const vn=(vx[i]-vx[j])*nx+(vy[i]-vy[j])*ny;
  if(vn>0){
    const imp=(1+elas)*vn/(mm[i]+mm[j]);
    if(i!==dragI){vx[i]-=imp*mm[j]*nx;vy[i]-=imp*mm[j]*ny;}
    if(j!==dragI){vx[j]+=imp*mm[i]*nx;vy[j]+=imp*mm[i]*ny;}
  }
}
function test(i,j){
  const dx=px[j]-px[i], dy=py[j]-py[i], md=rr[i]+rr[j];
  if(dx<md&&dx>-md&&dy<md&&dy>-md){
    const d2=dx*dx+dy*dy;
    if(d2<md*md&&d2>1e-6) resolve(i,j,Math.sqrt(d2),md);
    return true;
  }
  return false;
}
function brute(){
  let checks=0,cols=0;
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){ checks++; if(test(i,j))cols++; }
  return [checks,cols];
}
function hash(){
  const cell=52, map=new Map();
  for(let i=0;i<n;i++){
    const k=((px[i]/cell)|0)+','+((py[i]/cell)|0);
    let a=map.get(k); if(!a){a=[];map.set(k,a);} a.push(i);
  }
  let checks=0,cols=0;
  for(let i=0;i<n;i++){
    const cx=(px[i]/cell)|0, cy=(py[i]/cell)|0;
    for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){
      const a=map.get((cx+ox)+','+(cy+oy)); if(!a)continue;
      for(let q=0;q<a.length;q++){ const j=a[q]; if(j<=i)continue; checks++; if(test(i,j))cols++; }
    }
  }
  return [checks,cols];
}
function step(dt){
  const t0=performance.now();
  const k=Math.min(dt,50)/16.666;
  let frameHits=0;
  for(let i=0;i<n;i++){
    if(i===dragI){
      vx[i]=(dragX-px[i])*0.35; vy[i]=(dragY-py[i])*0.35;
      px[i]+=(dragX-px[i])*0.55; py[i]+=(dragY-py[i])*0.55;
      continue;
    }
    if(!zeroG)vy[i]+=0.42*k;
    vx[i]+=windX*0.004*k;
    vx[i]*=0.996; vy[i]*=0.996;
    px[i]+=vx[i]*k; py[i]+=vy[i]*k;
    const r=rr[i];
    if(px[i]<r){px[i]=r;vx[i]*=-elas;frameHits++;}
    else if(px[i]>W-r){px[i]=W-r;vx[i]*=-elas;frameHits++;}
    if(py[i]<r){py[i]=r;vy[i]*=-elas;frameHits++;}
    else if(py[i]>H-r){py[i]=H-r;vy[i]*=-elas;frameHits++;}
  }
  const c=(solver==='BRUTE'||(solver==='AUTO'&&n>256))?brute():hash();
  let ke=0;
  for(let i=0;i<n;i++)ke+=0.5*mm[i]*(vx[i]*vx[i]+vy[i]*vy[i]);
  const out=new Float32Array(n*2);
  for(let i=0;i<n;i++){out[i*2]=px[i];out[i*2+1]=py[i];}
  const ms=performance.now()-t0;
  if(!rrSent){
    rrSent=true;
    const rc=rr.slice();
    postMessage({t:'f',b:out.buffer,r:rc.buffer,hits:frameHits,cols:c[1],checks:c[0],ms:ms,ke:ke},[out.buffer,rc.buffer]);
    return;
  }
  postMessage({t:'f',b:out.buffer,hits:frameHits,cols:c[1],checks:c[0],ms:ms,ke:ke},[out.buffer]);
}
onmessage=e=>{
  const m=e.data;
  if(m.t==='init'){W=m.w;H=m.h;alloc(m.n);}
  else if(m.t==='set'){
    if(m.w!==undefined){W=m.w;H=m.h;}
    if(m.n!==undefined&&m.n!==n)alloc(m.n);
    if(m.solver!==undefined)solver=m.solver;
    if(m.elas!==undefined)elas=m.elas;
    if(m.zeroG!==undefined)zeroG=m.zeroG;
    if(m.wind!==undefined)windX=m.wind;
  }
  else if(m.t==='step')step(m.dt);
  else if(m.t==='drag'){dragI=m.i;dragX=m.x;dragY=m.y;}
  else if(m.t==='rel')dragI=-1;
  else if(m.t==='kick')for(let i=0;i<n;i++){vx[i]+=(Math.random()-.5)*m.s;vy[i]+=(Math.random()-.5)*m.s;}
  else if(m.t==='chaos')for(let i=0;i<n;i++){vx[i]*=m.k;vy[i]*=m.k;}
};
`;

const stage = $('stage');
const Phys = {
  worker: null, mode: 'main', pos: null, n: 0, rr: null,
  stats: { checks: 0, cols: 0, ms: 0, ke: 0 },
  pending: false, domEls: [], useDom: true,
  arenaCv: null, arenaCtx: null, sprites: null,
  /* main-thread fallback state */
  lx: null, ly: null, lvx: null, lvy: null, lr: null, lm: null,
  dragI: -1, dragX: 0, dragY: 0
};
const EMOJI = ['⚡', '⚙️', '💧', '🔥', '❄️'];

function makeWorker() {
  try {
    const b = new Blob([WORKER_SRC], { type: 'application/javascript' });
    const url = URL.createObjectURL(b);
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    return w;
  } catch (e) { return null; }
}

function makeSprites() {
  const arr = [];
  for (let k = 0; k < 8; k++) {
    const c = document.createElement('canvas');
    c.width = c.height = 48;
    const x = c.getContext('2d');
    const h = k * 45;
    const g = x.createRadialGradient(17, 15, 3, 24, 24, 23);
    g.addColorStop(0, `hsl(${h} 100% 90%)`);
    g.addColorStop(0.45, `hsl(${h} 86% 62%)`);
    g.addColorStop(1, `hsl(${h} 82% 34%)`);
    x.fillStyle = g;
    x.beginPath(); x.arc(24, 24, 23, 0, TAU); x.fill();
    x.fillStyle = 'rgba(255,255,255,.8)';
    x.beginPath(); x.ellipse(18, 13, 8, 5, -0.5, 0, TAU); x.fill();
    arr.push(c);
  }
  return arr;
}

/* True collision radius for body i: worker-authoritative when available. */
function bodyR(i) {
  if (Phys.mode === 'worker' && Phys.rr && Phys.rr[i] !== undefined) return Phys.rr[i];
  return Phys.lr ? Phys.lr[i] : 12;
}

function physInit() {
  const rect = stage.getBoundingClientRect();
  Phys.arenaCv = document.createElement('canvas');
  Phys.arenaCv.id = 'arenaCv';
  stage.appendChild(Phys.arenaCv);
  Phys.arenaCtx = Phys.arenaCv.getContext('2d');
  Phys.sprites = makeSprites();
  Phys.worker = makeWorker();
  if (Phys.worker) {
    Phys.mode = P.thread === 'worker' ? 'worker' : 'main';
    Phys.worker.onmessage = e => {
      const m = e.data;
      if (m.t !== 'f') return;
      Phys.pending = false;
      if (m.r) {
        Phys.rr = new Float32Array(m.r);
        if (Phys.useDom) {
          Phys.domEls.forEach((el, i) => {
            const size = (Phys.rr[i] || 12) * 2;
            el.style.width = el.style.height = size + 'px';
            const span = el.firstElementChild;
            if (span) span.style.fontSize = Math.max(9, size * 0.42) + 'px';
          });
        }
      }
      Phys.pos = new Float32Array(m.b);
      Phys.stats.checks = m.checks; Phys.stats.cols = m.cols;
      Phys.stats.ms = m.ms; Phys.stats.ke = m.ke;
      S.hitCount += m.hits;
      S.hitsSinceTick += m.hits;
      renderBodies();
    };
    Phys.worker.onerror = () => {
      console.warn('[AERO] physics worker failed — main-thread solver.');
      Phys.mode = 'main';
    };
    Phys.worker.postMessage({ t: 'init', n: P.bodies, w: rect.width, h: rect.height });
  } else {
    Phys.mode = 'main';
  }
  allocLocal(P.bodies);
  rebuildBodyDom();
}
function physSyncParams() {
  if (Phys.mode === 'worker' && Phys.worker) {
    const wind = P.windOv !== -1 ? P.windOv : (S.windFromAPI != null ? S.windFromAPI : 8);
    Phys.worker.postMessage({ t: 'set', solver: P.solver, elas: P.elas, zeroG: P.zeroG, wind });
  }
}
function allocLocal(n) {
  Phys.n = n;
  Phys.lx = new Float32Array(n); Phys.ly = new Float32Array(n);
  Phys.lvx = new Float32Array(n); Phys.lvy = new Float32Array(n);
  Phys.lr = new Float32Array(n); Phys.lm = new Float32Array(n);
  Phys.pos = new Float32Array(n * 2);
  const rect = stage.getBoundingClientRect();
  const small = n > 256;
  for (let i = 0; i < n; i++) {
    const r = small ? 4 + Math.random() * 5 : 9 + Math.random() * 10;
    Phys.lr[i] = r; Phys.lm[i] = r * 0.08;
    Phys.lx[i] = r + Math.random() * Math.max(1, rect.width - 2 * r);
    Phys.ly[i] = r + Math.random() * Math.max(1, rect.height - 2 * r);
    Phys.lvx[i] = (Math.random() - 0.5) * 9;
    Phys.lvy[i] = (Math.random() - 0.5) * 9;
  }
}
function rebuildBodyDom() {
  Phys.useDom = P.bodies <= 256;
  Phys.domEls.forEach(el => el.remove());
  Phys.domEls = [];
  const rect = stage.getBoundingClientRect();
  Phys.arenaCv.width = Math.max(2, rect.width);
  Phys.arenaCv.height = Math.max(2, rect.height);
  Phys.arenaCv.style.display = Phys.useDom ? 'none' : 'block';
  if (!Phys.useDom) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < P.bodies; i++) {
    const el = document.createElement('div');
    el.className = 'spec';
    const size = bodyR(i) * 2;
    el.style.width = el.style.height = size + 'px';
    el.style.setProperty('--h', Math.floor(Math.random() * 360));
    const span = document.createElement('span');
    span.className = 'spec-e';
    span.style.fontSize = Math.max(9, size * 0.42) + 'px';
    span.innerText = EMOJI[i % EMOJI.length];
    el.appendChild(span);
    frag.appendChild(el);
    Phys.domEls.push(el);
  }
  stage.appendChild(frag);
}
function setBodies(n) {
  n = clamp(Math.round(n), 1, 1024);
  P.bodies = n;
  const rect = stage.getBoundingClientRect();
  if (Phys.mode === 'worker' && Phys.worker) { Phys.rr = null; Phys.worker.postMessage({ t: 'set', n, w: rect.width, h: rect.height }); }
  allocLocal(n);
  rebuildBodyDom();
  syncRow('bodyRow', String(n));
  if ($('vBodies')) $('vBodies').innerText = n;
  if ($('bodyOut')) $('bodyOut').innerText = n;
}
function physStep(dt) {
  if (Phys.mode === 'worker' && Phys.worker) {
    if (!Phys.pending && !document.hidden) {
      Phys.pending = true;
      Phys.worker.postMessage({ t: 'step', dt });
    }
    return;
  }
  const t0 = performance.now();
  const n = Phys.n, k = Math.min(dt, 50) / 16.666;
  const rect = stage.getBoundingClientRect();
  const sW = rect.width, sH = rect.height;
  let hits = 0, cols = 0, checks = 0;
  const wind = P.windOv !== -1 ? P.windOv : (S.windFromAPI != null ? S.windFromAPI : 8);
  for (let i = 0; i < n; i++) {
    if (i === Phys.dragI) {
      Phys.lvx[i] = (Phys.dragX - Phys.lx[i]) * 0.35;
      Phys.lvy[i] = (Phys.dragY - Phys.ly[i]) * 0.35;
      Phys.lx[i] += (Phys.dragX - Phys.lx[i]) * 0.55;
      Phys.ly[i] += (Phys.dragY - Phys.ly[i]) * 0.55;
      continue;
    }
    if (!P.zeroG) Phys.lvy[i] += 0.42 * k;
    Phys.lvx[i] += wind * 0.004 * k;
    Phys.lvx[i] *= 0.996; Phys.lvy[i] *= 0.996;
    Phys.lx[i] += Phys.lvx[i] * k; Phys.ly[i] += Phys.lvy[i] * k;
    const r = Phys.lr[i];
    if (Phys.lx[i] < r) { Phys.lx[i] = r; Phys.lvx[i] *= -P.elas; hits++; }
    else if (Phys.lx[i] > sW - r) { Phys.lx[i] = sW - r; Phys.lvx[i] *= -P.elas; hits++; }
    if (Phys.ly[i] < r) { Phys.ly[i] = r; Phys.lvy[i] *= -P.elas; hits++; }
    else if (Phys.ly[i] > sH - r) { Phys.ly[i] = sH - r; Phys.lvy[i] *= -P.elas; hits++; }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      checks++;
      const dx = Phys.lx[j] - Phys.lx[i], dy = Phys.ly[j] - Phys.ly[i], md = Phys.lr[i] + Phys.lr[j];
      if (dx < md && dx > -md && dy < md && dy > -md) {
        const d2 = dx * dx + dy * dy;
        if (d2 < md * md && d2 > 1e-6) {
          cols++;
          const dist = Math.sqrt(d2), nx = dx / dist, ny = dy / dist, ov = md - dist;
          const wi = i === Phys.dragI ? 0 : 1, wj = j === Phys.dragI ? 0 : 1, tot = wi + wj || 1;
          Phys.lx[i] -= nx * ov * wi / tot; Phys.ly[i] -= ny * ov * wi / tot;
          Phys.lx[j] += nx * ov * wj / tot; Phys.ly[j] += ny * ov * wj / tot;
          const vn = (Phys.lvx[i] - Phys.lvx[j]) * nx + (Phys.lvy[i] - Phys.lvy[j]) * ny;
          if (vn > 0) {
            const imp = (1 + P.elas) * vn / (Phys.lm[i] + Phys.lm[j]);
            if (i !== Phys.dragI) { Phys.lvx[i] -= imp * Phys.lm[j] * nx; Phys.lvy[i] -= imp * Phys.lm[j] * ny; }
            if (j !== Phys.dragI) { Phys.lvx[j] += imp * Phys.lm[i] * nx; Phys.lvy[j] += imp * Phys.lm[i] * ny; }
          }
        }
      }
    }
  }
  let ke = 0;
  for (let i = 0; i < n; i++) ke += 0.5 * Phys.lm[i] * (Phys.lvx[i] * Phys.lvx[i] + Phys.lvy[i] * Phys.lvy[i]);
  Phys.stats = { checks, cols, ms: performance.now() - t0, ke };
  S.hitCount += hits;
  S.hitsSinceTick += hits;
  for (let i = 0; i < n; i++) { Phys.pos[i * 2] = Phys.lx[i]; Phys.pos[i * 2 + 1] = Phys.ly[i]; }
  renderBodies();
}
function renderBodies() {
  const pos = Phys.pos;
  if (!pos) return;
  if (Phys.useDom) {
    const n = Math.min(Phys.domEls.length, pos.length >> 1);
    for (let i = 0; i < n; i++) {
      const r = bodyR(i) || 12;
      Phys.domEls[i].style.transform = `translate(${(pos[i * 2] - r).toFixed(1)}px,${(pos[i * 2 + 1] - r).toFixed(1)}px)`;
    }
  } else {
    const x = Phys.arenaCtx;
    x.clearRect(0, 0, Phys.arenaCv.width, Phys.arenaCv.height);
    const n = pos.length >> 1;
    for (let i = 0; i < n; i++) {
      const r = bodyR(i) || 6.5;
      x.drawImage(Phys.sprites[i & 7], pos[i * 2] - r, pos[i * 2 + 1] - r, r * 2, r * 2);
    }
  }
}

/* arena pointer interaction — unified hit-test works for DOM + canvas modes */
(function wireArenaPointer() {
  let dragging = false;
  const local = e => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const findBody = p => {
    const pos = Phys.pos;
    if (!pos) return -1;
    const n = pos.length >> 1;
    let best = -1, bd = 1e9;
    for (let i = 0; i < n; i++) {
      const dx = pos[i * 2] - p.x, dy = pos[i * 2 + 1] - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = i; }
    }
    const lim = Phys.useDom ? 30 : 14;
    return bd < lim * lim ? best : -1;
  };
  stage.addEventListener('pointerdown', e => {
    e.preventDefault();
    const p = local(e), i = findBody(p);
    if (i < 0) return;
    dragging = true;
    stage.setPointerCapture(e.pointerId);
    Phys.dragI = i;
    if (Phys.mode === 'worker' && Phys.worker) {
      Phys.worker.postMessage({ t: 'drag', i, x: p.x, y: p.y });
    } else {
      Phys.dragX = p.x; Phys.dragY = p.y;
    }
  });
  stage.addEventListener('pointermove', e => {
    if (!dragging) return;
    const p = local(e);
    if (Phys.mode === 'worker' && Phys.worker) {
      Phys.worker.postMessage({ t: 'drag', i: Phys.dragI, x: p.x, y: p.y });
    } else {
      Phys.dragX = p.x; Phys.dragY = p.y;
    }
  });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    if (Phys.mode === 'worker' && Phys.worker) Phys.worker.postMessage({ t: 'rel' });
    Phys.dragI = -1;
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
})();

/* ================= CPU WEATHER PARTICLES (preserved v2.8) ============ */
let particles = [];
class Particle {
  constructor(type) { this.type = type; this.reset(true); }
  reset(randomY = false) {
    this.x = Math.random() * W;
    this.y = randomY ? Math.random() * H : -10;
    this.size = this.type === 'rain' ? Math.random() * 1.5 + 0.5
              : this.type === 'snow' ? Math.random() * 2.5 + 1
              : Math.random() * 1.8 + 0.35;
    this.vy = (this.type === 'rain' ? Math.random() * 8 + 8
             : this.type === 'snow' ? Math.random() * 2 + 1
             : Math.random() * 0.7 + 0.15) * P.gravity;
    this.vx = P.windOv !== -1 ? P.windOv / 10 : (Math.random() - 0.5) * (this.type === 'snow' ? 1 : 0.8);
  }
  update(dt) {
    this.x += this.vx * (dt / 16);
    this.y += this.vy * (dt / 16);
    if (this.y > H || this.x < -20 || this.x > W + 20) this.reset();
  }
  draw(ctx) {
    ctx.fillStyle = this.type === 'rain' ? 'rgba(170,210,255,0.6)'
                  : this.type === 'mist' ? 'rgba(210,240,255,0.18)'
                  : 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    if (this.type === 'rain') ctx.rect(this.x, this.y, this.size * 0.7, this.size * 5);
    else ctx.arc(this.x, this.y, this.size, 0, TAU);
    ctx.fill();
  }
}
function updateWeatherSystem() {
  const targetType = P.wx === 'auto' ? S.wxNow : P.wx;
  const weatherCount = targetType === 'rain' ? 900 * P.density
                     : targetType === 'snow' ? 450 * P.density : 0;
  const targetCount = Math.min(6000, Math.round(400 * P.density + weatherCount));
  if (targetType === 'fog') S.fogA = Math.min(S.fogA + 0.01, 1);
  else S.fogA = Math.max(S.fogA - 0.05, 0);
  $('fogBlur').style.opacity = S.fogA.toFixed(2);
  while (particles.length < targetCount) {
    const i = particles.length;
    particles.push(new Particle(i < Math.round(400 * P.density) ? 'mist' : (targetType || 'rain')));
  }
  if (particles.length > targetCount) particles.length = targetCount;
}
function spawnBurst(n = 120) {
  const type = P.wx === 'auto' ? (S.wxNow || 'rain') : P.wx;
  const t = (type === 'clear' || type === 'fog') ? 'rain' : type;
  for (let i = 0; i < n && particles.length < 6000; i++) particles.push(new Particle(t));
}

/* ================= GLASS DROPLETS (refract the real sun) ============ */
const droplets = [];
window.addEventListener('pointerdown', e => {
  if (e.target.closest('button,a,input,.devcon,.dock,.hud,.arena,#stressHud')) return;
  for (let i = 0; i < 3 && droplets.length < 140; i++) {
    droplets.push({
      x: e.clientX + (Math.random() - 0.5) * 26,
      y: e.clientY + (Math.random() - 0.5) * 18,
      r: 4 + Math.random() * P.dropSize, vy: 0, life: 1
    });
  }
});
function stepDroplets(dt) {
  const k = dt / 16;
  for (let i = droplets.length - 1; i >= 0; i--) {
    const d = droplets[i];
    d.vy += 0.05 * P.gravity * k * (d.r / 8);
    d.y += d.vy * k;
    d.x += Math.sin(d.y * 0.05 + d.r) * 0.15 * k;
    if (d.y - d.r > H * 0.98) d.life -= 0.06 * k;
    if (d.life <= 0) droplets.splice(i, 1);
  }
}
function drawGlass(time) {
  glCtx.clearRect(0, 0, W, H);
  glCtx.save();
  glCtx.globalCompositeOperation = 'screen';
  const cx = W * 0.5 + Math.sin(time * 0.00037) * W * 0.08;
  const cy = H * 0.78 + Math.cos(time * 0.00029) * H * 0.05;
  for (let i = 0; i < 28; i++) {
    const a = time * 0.00015 * (i + 1);
    const x = cx + Math.sin(a * 1.7 + i) * W * (0.10 + i * 0.002);
    const y = cy + Math.cos(a * 1.3 - i) * H * (0.05 + i * 0.0015);
    const r = 55 + (i % 7) * 22;
    const g = glCtx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${0.035 + (i % 4) * 0.012})`);
    g.addColorStop(0.55, `rgba(80,210,255,${0.025 + (i % 3) * 0.01})`);
    g.addColorStop(1, 'rgba(0,120,255,0)');
    glCtx.fillStyle = g;
    glCtx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const sun = effSun();
  const sx = W / 2, sy = H - (sun.altDeg / 70) * (H * 0.6);
  for (const d of droplets) {
    const ang = Math.atan2(sy - d.y, sx - d.x);
    const hx = d.x + Math.cos(ang) * d.r * 0.4, hy = d.y + Math.sin(ang) * d.r * 0.4;
    const g = glCtx.createRadialGradient(hx, hy, 0, d.x, d.y, d.r);
    g.addColorStop(0, `rgba(255,255,255,${0.5 * d.life})`);
    g.addColorStop(0.5, `rgba(150,220,255,${0.2 * d.life})`);
    g.addColorStop(1, 'rgba(120,180,255,0)');
    glCtx.fillStyle = g;
    glCtx.beginPath(); glCtx.arc(d.x, d.y, d.r, 0, TAU); glCtx.fill();
    glCtx.strokeStyle = `rgba(255,255,255,${0.25 * d.life})`;
    glCtx.lineWidth = 1;
    glCtx.stroke();
  }
  glCtx.restore();
}

/* ================= SOUND (tiny WebAudio ticks, rate-limited) ========= */
let actx = null, lastTick = 0;
function tickSound() {
  if (!P.sound) return;
  const now = performance.now();
  if (now - lastTick < 45) return;
  lastTick = now;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine';
    o.frequency.value = 180 + Math.random() * 220;
    g.gain.setValueAtTime(0.04, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.07);
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + 0.08);
  } catch (e) { /* audio is optional */ }
}

/* ================= WEATHER FETCH (preserved v2.8) =================== */
const WX_LABEL = { clear: 'CLEAR', rain: 'RAIN', snow: 'SNOW', fog: 'FOG', thunder: 'THUNDER' };
async function fetchWeather() {
  if ($('hudSrc')) $('hudSrc').innerText = 'SYNCING WX...';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const { lat, lon } = S.coords;
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`,
      { signal: ctrl.signal }
    );
    if (!res.ok) throw new Error('API HTTP ' + res.status);
    const data = await res.json();
    const code = data.current_weather.weathercode;
    S.windFromAPI = data.current_weather.windspeed ?? null;
    let type = 'clear';
    if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) type = 'rain';
    else if ([71, 73, 75, 77, 85, 86].includes(code)) type = 'snow';
    else if ([45, 48].includes(code)) type = 'fog';
    else if ([95, 96, 99].includes(code)) type = 'thunder';
    S.wxNow = type;
    if ($('hudWx')) $('hudWx').innerText = `TEMP ${data.current_weather.temperature}°C`;
    if ($('hudSrc')) $('hudSrc').innerText = 'OPEN-METEO LIVE';
    if ($('tSrc')) $('tSrc').innerText = 'OPEN-METEO';
    if ($('tWx')) $('tWx').innerText = `${WX_LABEL[type]} · ${code}`;
    if ($('chipWx')) $('chipWx').innerText = `🌡 ${data.current_weather.temperature}°C`;
    physSyncParams();
  } catch (err) {
    console.warn('Weather engine offline, falling back to clear sky.', err);
    S.wxNow = 'clear';
    if ($('hudWx')) $('hudWx').innerText = 'WX OFFLINE';
    if ($('hudSrc')) $('hudSrc').innerText = 'LOCAL FALLBACK';
    if ($('tSrc')) $('tSrc').innerText = 'FALLBACK';
    if ($('tWx')) $('tWx').innerText = 'CLEAR · OFFLINE';
    if ($('chipWx')) $('chipWx').innerText = '🌡 --';
  } finally { clearTimeout(timer); }
}

/* ================= GEOLOCATION (preserved v2.8) ===================== */
function tryGeo() {
  if (!navigator.geolocation) { S.geoState = 'unavailable'; return; }
  S.geoState = 'requesting';
  navigator.geolocation.getCurrentPosition(
    pos => {
      S.coords = {
        lat: +(+pos.coords.latitude).toFixed(2),
        lon: +(+pos.coords.longitude).toFixed(2),
        label: 'CUSTOM LOC'
      };
      S.geoState = 'acquired';
      S.sunRiseSetCache.time = 0;
      fetchWeather();
    },
    () => { S.geoState = 'denied'; },
    { timeout: 8000, maximumAge: 600000 }
  );
}

/* ================= UI HELPERS ======================================= */
function wireRow(id, fn) {
  const row = $(id);
  if (!row) return;
  row.addEventListener('click', e => {
    const b = e.target.closest('.cbtn');
    if (!b) return;
    row.querySelectorAll('.cbtn').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    fn(b.dataset.v);
  });
}
function syncRow(id, val) {
  const row = $(id);
  if (!row) return;
  row.querySelectorAll('.cbtn').forEach(b => b.classList.toggle('on', b.dataset.v === String(val)));
}
function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'K' : String(n); }

/* GPU load estimate — model-based only. Browsers expose no real GPU
   utilization; this is honestly labelled EST everywhere it appears. */
function gpuEstimate() {
  if (!glOK) return 0;
  const px = mainCv.width * mainCv.height;
  const per = effLoops() + SH[P.shaderLevel].oct * 14 + CAUS_ITER[P.caustic] * 6;
  return clamp(px * per * (1 + P.postPasses * 0.55) / 2.4e8 * 100, 0, 999);
}
function stressScore() {
  return clamp(
    (P.gpuLoad / 125) * 28 +
    (SH_ORDER.indexOf(P.shaderLevel) / 4) * 22 +
    ((P.renderScale - 1) / 2) * 14 +
    (PART_STEPS.indexOf(P.particles) / 3) * 14 +
    (BODY_STEPS.indexOf(P.bodies) / 5) * 12 +
    (P.postPasses / 8) * 10,
    0, 100);
}

/* ================= BENCHMARK ========================================= */
const BENCH_PRESETS = {
  HIGH:    { shaderLevel: 'HIGH',    renderScale: 1.5, particles: 50000,  bodies: 256, postPasses: 2, gpuLoad: 100 },
  EXTREME: { shaderLevel: 'EXTREME', renderScale: 2,   particles: 100000, bodies: 512, postPasses: 4, gpuLoad: 100 }
};
function applyParams(p) {
  P.gpuLoad = p.gpuLoad; P.shaderLevel = p.shaderLevel;
  P.renderScale = p.renderScale; P.postPasses = p.postPasses;
  rebuildShader(); resizeGPU();
  P.particles = p.particles; Parts.rebuild();
  setBodies(p.bodies);
  syncUIFromParams();
}
function startBench() {
  if (bench.on) { stopBench(true); return; }
  bench.pre = {
    gpuLoad: P.gpuLoad, shaderLevel: P.shaderLevel, renderScale: P.renderScale,
    particles: P.particles, bodies: P.bodies, postPasses: P.postPasses
  };
  const preset = BENCH_PRESETS[bench.load] || BENCH_PRESETS.EXTREME;
  applyParams(preset);
  bench.frames.length = 0;
  bench.t0 = performance.now();
  bench.on = true;
  document.body.classList.add('bench-run');
  if ($('rBench')) $('rBench').innerText = 'RUNNING';
  if ($('bBench')) $('bBench').innerText = '■ ABORT';
  toast('▶ BENCHMARK · 30s FIXED WORKLOAD (' + bench.load + ')');
}
function stopBench(abort) {
  bench.on = false;
  document.body.classList.remove('bench-run');
  if ($('bBench')) $('bBench').innerText = '▶ RUN 30s BENCHMARK';
  if (bench.pre) { applyParams(bench.pre); bench.pre = null; }
  if (abort) {
    if ($('rBench')) $('rBench').innerText = 'ABORTED';
    toast('■ BENCHMARK ABORTED');
    return;
  }
  const fr = bench.frames;
  if (fr.length < 30) { if ($('rBench')) $('rBench').innerText = 'TOO SHORT'; return; }
  const avgMs = fr.reduce((a, b) => a + b, 0) / fr.length;
  const maxMs = fr.reduce((a, b) => Math.max(a, b), 0);
  const sorted = fr.slice().sort((a, b) => b - a);
  const lowN = Math.max(1, Math.ceil(fr.length * 0.01));
  let lowSum = 0; for (let i = 0; i < lowN; i++) lowSum += sorted[i];
  const avg = 1000 / avgMs, min = 1000 / maxMs, low = 1000 / (lowSum / lowN);
  if ($('rBench')) $('rBench').innerText = 'COMPLETE';
  if ($('rBAvg')) $('rBAvg').innerText = avg.toFixed(1);
  if ($('rBMin')) $('rBMin').innerText = min.toFixed(1);
  if ($('rB1')) $('rB1').innerText = low.toFixed(1);
  if ($('rBMax')) $('rBMax').innerText = maxMs.toFixed(1) + ' ms';
  toast(`◈ BENCH DONE · AVG ${avg.toFixed(0)} · MIN ${min.toFixed(0)} · 1% ${low.toFixed(0)} FPS`, 6000);
}

/* ================= AUTO STRESS ======================================= */
const AUTO_RUNGS = [
  { label: 'SHADER',    fn: () => { const i = SH_ORDER.indexOf(P.shaderLevel); if (i >= 4) return false; P.shaderLevel = SH_ORDER[i + 1]; rebuildShader(); syncRow('shaderRow', P.shaderLevel); return true; } },
  { label: 'PARTICLES', fn: () => { const i = PART_STEPS.indexOf(P.particles); if (i >= 3) return false; P.particles = PART_STEPS[i + 1]; Parts.rebuild(); syncRow('partRow', String(P.particles)); return true; } },
  { label: 'SCALE',     fn: () => { const i = SCALE_STEPS.indexOf(P.renderScale); if (i >= 5) return false; P.renderScale = SCALE_STEPS[i + 1]; resizeGPU(); syncRow('scaleRow', String(P.renderScale)); return true; } },
  { label: 'POST FX',   fn: () => { if (P.postPasses >= 8) return false; P.postPasses++; if ($('sFx')) $('sFx').value = P.postPasses; return true; } },
  { label: 'BODIES',    fn: () => { const i = BODY_STEPS.indexOf(P.bodies); if (i < 0 || i >= 5) return false; setBodies(BODY_STEPS[i + 1]); return true; } },
  { label: 'GPU LOAD',  fn: () => { const i = LOAD_STEPS.indexOf(P.gpuLoad); if (i >= 4) return false; P.gpuLoad = LOAD_STEPS[i + 1]; syncRow('gpuLoadRow', String(P.gpuLoad)); return true; } }
];
function autoStep() {
  if (!P.auto || bench.on) return;
  const fps = TEL.frame.len > 20 ? 1000 / TEL.frame.avg : 60;
  if (fps <= P.targetFps) return;
  while (autoRung < AUTO_RUNGS.length) {
    if (AUTO_RUNGS[autoRung].fn()) {
      toast('◉ AUTO STRESS ▲ ' + AUTO_RUNGS[autoRung].label);
      return;
    }
    autoRung++;
  }
  toast('◉ AUTO STRESS · MAX LOAD REACHED');
  P.auto = false;
  if ($('bAuto')) $('bAuto').innerText = '◉ AUTO STRESS: OFF';
}
setInterval(autoStep, 2500);

/* ================= RESET LOAD (device safety) ======================== */
function resetLoad() {
  if (bench.on) stopBench(true);
  P.auto = false; autoRung = 0;
  if ($('bAuto')) $('bAuto').innerText = '◉ AUTO STRESS: OFF';
  P.gpuLoad = 75; P.shaderLevel = 'HIGH'; P.renderScale = 1;
  P.particles = 50000; P.postPasses = 2;
  P.caustic = 'HIGH'; P.cloud = 'HIGH';
  rebuildShader(); resizeGPU(); Parts.rebuild();
  setBodies(72);
  syncUIFromParams();
  toast('⟲ LOAD RESET TO SAFE DEFAULTS');
}
/* Range sliders are synced too, so reduced-motion defaults (density 0.8,
   MEDIUM shader, 50% load, 10K particles) display correctly on load. */
function syncUIFromParams() {
  syncRow('gpuLoadRow', String(P.gpuLoad));
  syncRow('shaderRow', P.shaderLevel);
  syncRow('scaleRow', String(P.renderScale));
  syncRow('partRow', String(P.particles));
  syncRow('causRow', P.caustic);
  syncRow('cloudRow', P.cloud);
  syncRow('bodyRow', String(P.bodies));
  syncRow('solverRow', P.solver);
  syncRow('threadRow', P.thread);
  syncRow('fxModeRow', P.fxMode);
  syncRow('targetRow', String(P.targetFps));
  const bRow = $('benchLoadRow');
  if (bRow) {
    bRow.querySelectorAll('.cbtn').forEach(b => {
      b.classList.toggle('on', b.dataset.v === bench.load || (bench.load === 'EXTREME' && b.dataset.v === 'XTREME'));
    });
  }
  if ($('sFx')) $('sFx').value = P.postPasses;
  if ($('sDens')) { $('sDens').value = P.density; if ($('vDens')) $('vDens').innerText = P.density.toFixed(1) + '×'; }
  if ($('sGrav')) { $('sGrav').value = P.gravity; if ($('vGrav')) $('vGrav').innerText = P.gravity.toFixed(1) + '×'; }
  if ($('sSize')) { $('sSize').value = P.dropSize; if ($('vSize')) $('vSize').innerText = P.dropSize + 'px'; }
  if ($('sWind')) { $('sWind').value = P.windOv; if ($('vWind')) $('vWind').innerText = P.windOv < 0 ? 'AUTO' : P.windOv + ' km/h'; }
  if ($('sElas')) { $('sElas').value = P.elas; if ($('vElas')) $('vElas').innerText = P.elas.toFixed(2); }
}

/* ================= CONSOLE WIRING ==================================== */
function wireConsole() {
  document.querySelectorAll('.ctab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.ctab').forEach(x => x.classList.remove('on'));
    document.querySelectorAll('.c-sec').forEach(x => x.classList.remove('on'));
    t.classList.add('on');
    const sec = document.querySelector(`.c-sec[data-t="${t.dataset.t}"]`);
    if (sec) sec.classList.add('on');
  }));
  $('gear').addEventListener('click', () => $('devcon').classList.toggle('hidden'));
  $('cClose').addEventListener('click', () => $('devcon').classList.add('hidden'));
  $('cMin').addEventListener('click', () => {
    const b = $('cBody');
    b.style.display = b.style.display === 'none' ? 'block' : 'none';
  });
  $('cReset').addEventListener('click', resetLoad);
  document.addEventListener('keydown', e => {
    if (e.key === '`' || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd')) {
      e.preventDefault();
      $('devcon').classList.toggle('hidden');
    }
  });
  /* draggable console title (preserved v2.8) */
  (function drag() {
    const con = $('devcon'), title = $('cTitle');
    if (!con || !title) return;
    let dragging = false, ox = 0, oy = 0, bl = 0, bt = 0;
    title.addEventListener('pointerdown', e => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      const r = con.getBoundingClientRect();
      bl = r.left; bt = r.top; ox = e.clientX; oy = e.clientY;
      con.style.right = 'auto'; con.style.bottom = 'auto';
      con.style.left = bl + 'px'; con.style.top = bt + 'px';
      title.setPointerCapture(e.pointerId);
    });
    title.addEventListener('pointermove', e => {
      if (!dragging) return;
      con.style.left = clamp(bl + e.clientX - ox, 0, window.innerWidth - con.offsetWidth) + 'px';
      con.style.top = clamp(bt + e.clientY - oy, 0, window.innerHeight - con.offsetHeight) + 'px';
    });
    title.addEventListener('pointerup', e => {
      dragging = false;
      try { title.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
    });
  })();

  /* GPU / shaders */
  wireRow('gpuLoadRow', v => { P.gpuLoad = +v; });
  wireRow('scaleRow', v => { P.renderScale = +v; resizeGPU(); });
  wireRow('shaderRow', v => { P.shaderLevel = v; rebuildShader(); });
  wireRow('causRow', v => { P.caustic = v; });
  wireRow('cloudRow', v => { P.cloud = v; });
  /* post fx */
  $('sFx').addEventListener('input', e => { P.postPasses = +e.target.value; });
  wireRow('fxModeRow', v => { P.fxMode = v; });
  /* particles */
  wireRow('partRow', v => { P.particles = +v; Parts.rebuild(); });
  $('sDens').addEventListener('input', e => { P.density = +e.target.value; if ($('vDens')) $('vDens').innerText = P.density.toFixed(1) + '×'; });
  $('sGrav').addEventListener('input', e => { P.gravity = +e.target.value; if ($('vGrav')) $('vGrav').innerText = P.gravity.toFixed(1) + '×'; });
  $('sSize').addEventListener('input', e => { P.dropSize = +e.target.value; if ($('vSize')) $('vSize').innerText = P.dropSize + 'px'; });
  $('sWind').addEventListener('input', e => {
    const v = +e.target.value;
    if (v < 0) { P.windOv = -1; if ($('vWind')) $('vWind').innerText = 'AUTO'; }
    else { P.windOv = v; if ($('vWind')) $('vWind').innerText = v + ' km/h'; }
    physSyncParams();
  });
  $('bBurst').addEventListener('click', () => spawnBurst(120));
  $('bClearD').addEventListener('click', () => { particles.length = 0; });
  $('bSound').addEventListener('click', e => {
    P.sound = !P.sound;
    e.target.innerText = P.sound ? '🔊 SOUND ON' : '🔇 SOUND OFF';
    e.target.classList.toggle('on', P.sound);
  });
  /* physics */
  wireRow('bodyRow', v => setBodies(+v));
  $('sElas').addEventListener('input', e => {
    P.elas = +e.target.value;
    if ($('vElas')) $('vElas').innerText = P.elas.toFixed(2);
    if ($('eOut')) $('eOut').innerText = P.elas.toFixed(2);
    physSyncParams();
  });
  wireRow('solverRow', v => { P.solver = v; physSyncParams(); });
  wireRow('threadRow', v => {
    if (v === 'worker' && !Phys.worker) { toast('WORKERS UNAVAILABLE — MAIN THREAD'); return; }
    P.thread = v;
    Phys.mode = v === 'worker' ? 'worker' : 'main';
    if (v === 'main' && Phys.pos) {
      const n = Phys.pos.length >> 1;
      allocLocal(n);
      for (let i = 0; i < n; i++) { Phys.lx[i] = Phys.pos[i * 2]; Phys.ly[i] = Phys.pos[i * 2 + 1]; }
    } else if (v === 'worker') {
      const rect = stage.getBoundingClientRect();
      Phys.worker.postMessage({ t: 'init', n: P.bodies, w: rect.width, h: rect.height });
      physSyncParams();
    }
  });
  /* benchmark / auto */
  wireRow('benchLoadRow', v => { bench.load = (v === 'XTREME') ? 'EXTREME' : v; });
  $('bBench').addEventListener('click', startBench);
  $('bAuto').addEventListener('click', () => {
    P.auto = !P.auto; autoRung = 0;
    $('bAuto').innerText = P.auto ? '◉ AUTO STRESS: ON' : '◉ AUTO STRESS: OFF';
    $('bAuto').classList.toggle('on', P.auto);
    if (P.auto) toast('◉ AUTO STRESS ARMED · TARGET ' + P.targetFps + ' FPS');
  });
  wireRow('targetRow', v => { P.targetFps = +v; });
  /* weather / theme overrides (preserved v2.8) */
  document.querySelectorAll('#wxBtns .cbtn').forEach(b => b.addEventListener('click', e => {
    document.querySelectorAll('#wxBtns .cbtn').forEach(p => p.classList.remove('on'));
    e.target.classList.add('on');
    P.wx = e.target.dataset.wx;
  }));
  document.querySelectorAll('#thBtns .cbtn').forEach(b => b.addEventListener('click', e => {
    document.querySelectorAll('#thBtns .cbtn').forEach(p => p.classList.remove('on'));
    e.target.classList.add('on');
    P.theme = e.target.dataset.th;
  }));
  /* arena buttons (preserved v2.8 semantics) */
  $('btnZero').addEventListener('click', e => {
    P.zeroG = !P.zeroG;
    e.target.classList.toggle('on');
    e.target.innerText = `ZERO-G: ${P.zeroG ? 'ON' : 'OFF'}`;
    physSyncParams();
  });
  $('btnAdd').addEventListener('click', () => setBodies(Math.min(P.bodies + 1, 1024)));
  $('btnShake').addEventListener('click', () => {
    if (Phys.mode === 'worker' && Phys.worker) Phys.worker.postMessage({ t: 'kick', s: 30 });
    else for (let i = 0; i < Phys.n; i++) { Phys.lvx[i] += (Math.random() - 0.5) * 30; Phys.lvy[i] += (Math.random() - 0.5) * 30; }
  });
  $('btnChaos').addEventListener('click', () => {
    if (Phys.mode === 'worker' && Phys.worker) Phys.worker.postMessage({ t: 'chaos', k: 2.5 });
    else for (let i = 0; i < Phys.n; i++) { Phys.lvx[i] *= 2.5; Phys.lvy[i] *= 2.5; }
  });
  $('btnPrint').addEventListener('click', () => window.print());
}

/* ================= TELEMETRY UI ====================================== */
const fpsGraph = $('fpsGraph');
const fpsCtx = fpsGraph ? fpsGraph.getContext('2d') : null;
function drawSpark() {
  if (!fpsCtx) return;
  const w = fpsGraph.width, h = fpsGraph.height;
  fpsCtx.clearRect(0, 0, w, h);
  fpsCtx.strokeStyle = 'rgba(127,212,255,.18)';
  fpsCtx.beginPath();
  const ty = h - clamp(P.targetFps, 0, 120) / 120 * h;
  fpsCtx.moveTo(0, ty); fpsCtx.lineTo(w, ty); fpsCtx.stroke();
  fpsCtx.strokeStyle = '#4fd8ff';
  fpsCtx.beginPath();
  const n = TEL.graph.len;
  for (let k = 0; k < n; k++) {
    const x = w - 1 - k * (w / 160);
    const fps = clamp(1000 / TEL.graph.at(k), 0, 120);
    const y = h - fps / 120 * h;
    if (k === 0) fpsCtx.moveTo(x, y); else fpsCtx.lineTo(x, y);
  }
  fpsCtx.stroke();
}
function updateTelemetry() {
  const avgFrame = TEL.frame.avg, fps = avgFrame ? 1000 / avgFrame : 0;
  S.fps = fps;
  const set = (id, v) => { const el = $(id); if (el) el.innerText = v; };
  set('tFps', fps.toFixed(0) + ' FPS');
  set('tFrame', avgFrame.toFixed(2) + ' ms');
  set('tCpu', TEL.cpu.avg.toFixed(2) + ' ms');
  set('tPhys', TEL.phys.avg.toFixed(2) + ' ms');
  set('tGpuEst', glOK ? gpuEstimate().toFixed(0) + '% EST' : 'N/A');
  set('tRes', internalRes);
  set('tDpr', (window.devicePixelRatio || 1).toFixed(2));
  set('tApi', glOK ? (IS2 ? 'WEBGL2' : 'WEBGL1') : 'CANVAS2D');
  set('tDraws', gpuCounters.draws);
  set('tTris', gpuCounters.tris + ' + ' + fmtK(gpuCounters.parts) + ' pts');
  set('tParts', fmtK(Parts.n) + ' GPU · ' + particles.length + ' CPU');
  set('tBodies', P.bodies + ' (' + (Phys.mode === 'worker' ? 'WORKER' : 'MAIN') + ')');
  set('rLoops', effLoops() + ' / 256');
  set('rOct', SH[P.shaderLevel].oct);
  set('rWarp', SH[P.shaderLevel].warp);
  set('rLegacy', (legOK && P.legacy) ? 'ON' : 'OFF');
  set('rPipe', glOK ? (sceneHdr ? 'FBO CHAIN' : 'DIRECT') : 'CANVAS2D');
  set('rFbo', sceneHdr ? '3 × ' + rtFmt : '0');
  set('rFxMs', (P.postPasses * (mainCv.width * mainCv.height) / 2.2e6).toFixed(1) + ' ms EST');
  set('rBlur', P.postPasses * 2);
  set('rSimMode', Parts.mode === 'TF' ? 'GPU · TRANSFORM FEEDBACK' : Parts.mode === 'CPU' ? 'CPU · FLOAT32' : 'OFF');
  set('rPAct', fmtK(Parts.n));
  const mv = Parts.mixVec();
  set('rPMix', `D${(mv[0] * 100) | 0} R${(mv[1] * 100) | 0} S${(mv[2] * 100) | 0} E${(mv[3] * 100) | 0}`);
  set('rMist', particles.length);
  set('vParts', fmtK(P.particles));
  set('vGpuLoad', P.gpuLoad === 125 ? 'EXTREME' : P.gpuLoad + '%');
  set('vScale', P.renderScale.toFixed(2) + '×');
  set('vShader', P.shaderLevel);
  set('vCaus', P.caustic);
  set('vCloud', P.cloud);
  set('vFx', P.postPasses);
  set('vBodies', P.bodies);
  set('vBenchLoad', bench.load);
  set('rChecks', Phys.stats.checks);
  set('rCols', Phys.stats.cols);
  set('rPhysMs', Phys.stats.ms.toFixed(2) + ' ms');
  set('rKe', Phys.stats.ke.toFixed(2));
  set('keOut', Phys.stats.ke.toFixed(2));
  set('hitOut', S.hitCount);
  set('bodyOut', P.bodies);
  set('eOut', P.elas.toFixed(2));
  set('tAlt', (effSun().altDeg).toFixed(2) + '°');
  set('tAz', (effSun().azDeg).toFixed(1) + '°');
  set('tPhase', S.phase.toUpperCase());
  set('tJD', S.sun ? S.sun.jd.toFixed(3) : '—');
  if (S.moon) set('tMoon', `${S.moon.altDeg.toFixed(0)}° · ${Math.round(S.moon.illum * 100)}%`);
  set('tCoords', `${S.coords.lat.toFixed(2)}, ${S.coords.lon.toFixed(2)}`);
  set('tGeo', S.geoState.toUpperCase());
  set('tWind', P.windOv !== -1 ? P.windOv + ' km/h (ovr)' : (S.windFromAPI != null ? S.windFromAPI + ' km/h' : '—'));
  if (bench.on) {
    set('rBt', ((performance.now() - bench.t0) / 1000).toFixed(0) + 's');
  }
  const score = stressScore();
  const hud = $('stressHud');
  if (hud) {
    hud.classList.toggle('on', score > 34);
    if ($('shFill')) $('shFill').style.width = score.toFixed(0) + '%';
    if ($('shGpu')) $('shGpu').innerText = P.gpuLoad === 125 ? 'EXTREME' : P.gpuLoad + '%';
    if ($('shShader')) $('shShader').innerText = P.shaderLevel;
    if ($('shParts')) $('shParts').innerText = fmtK(P.particles);
    if ($('shBodies')) $('shBodies').innerText = P.bodies;
  }
  drawSpark();
}
setInterval(updateTelemetry, 250);

/* ================= SKY / CANVAS FALLBACK LAYERS ====================== */
function seedStars() {
  S.stars = [];
  const count = Math.min(900, Math.floor(W * H / 2200));
  for (let i = 0; i < count; i++) {
    S.stars.push({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.5, a: Math.random() * 0.7 + 0.3 });
  }
}
function drawSkyCanvas(sun, amb) {
  skyCtx.clearRect(0, 0, W, H);
  if (!glOK && amb < 0.6) {
    skyCtx.fillStyle = '#fff';
    for (const s of S.stars) {
      skyCtx.globalAlpha = s.a * (1 - amb);
      skyCtx.beginPath(); skyCtx.arc(s.x, s.y, s.r, 0, TAU); skyCtx.fill();
    }
    skyCtx.globalAlpha = 1;
  }
  const sY = H - (sun.altDeg / 70) * (H * 0.6);
  root.style.setProperty('--sun-y', sY.toFixed(0) + 'px');
  if (!glOK && sun.altDeg > -5) {
    skyCtx.save();
    skyCtx.fillStyle = '#fff';
    skyCtx.shadowBlur = 40; skyCtx.shadowColor = '#fff';
    skyCtx.beginPath(); skyCtx.arc(W / 2, sY, 40, 0, TAU); skyCtx.fill();
    skyCtx.restore();
  }
}

/* ================= RESIZE / DPR ====================================== */
function resize() {
  W = window.innerWidth; H = window.innerHeight;
  [skyCv, wxCv, glCv].forEach(c => { c.width = W; c.height = H; });
  seedStars();
  resizeGPU();
  resizeLegacy();
  if (Phys.arenaCv) {
    const rect = stage.getBoundingClientRect();
    Phys.arenaCv.width = Math.max(2, rect.width);
    Phys.arenaCv.height = Math.max(2, rect.height);
  }
  if (Phys.mode === 'worker' && Phys.worker) {
    const rect = stage.getBoundingClientRect();
    Phys.worker.postMessage({ t: 'set', w: rect.width, h: rect.height });
  }
}
let resizeT = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(resize, 120);
});
/* devicePixelRatio changes (browser zoom / monitor move) */
(function watchDpr() {
  const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  const onchange = () => { resizeGPU(); resizeLegacy(); watchDpr(); };
  if (mq.addEventListener) mq.addEventListener('change', onchange, { once: true });
  else mq.addListener(onchange);
})();

/* ================= MAIN LOOP ========================================= */
let lastTime = performance.now();
let lastDt = 16.7;
let uiAcc = 0;

function tick(time) {
  const cpuT0 = performance.now();
  const dt = Math.max(0, Math.min(time - lastTime, 60));
  lastTime = time;
  lastDt = dt;
  gpuCounters.draws = 0; gpuCounters.tris = 0; gpuCounters.parts = 0;

  TEL.frame.push(dt || 16.7);
  TEL.graph.push(dt || 16.7);
  if (bench.on) {
    bench.frames.push(dt);
    if (bench.frames.length > 20000) bench.frames.shift();
    if ($('rBt')) $('rBt').innerText = ((time - bench.t0) / 1000).toFixed(0) + 's';
    if (time - bench.t0 >= bench.dur) stopBench(false);
  }

  /* astronomy + theme */
  const now = new Date();
  const realSun = Astro.position(now, S.coords.lat, S.coords.lon);
  S.sun = realSun;
  const sun = effSun();
  S.sunSolves++;
  S.phase = phaseFromSun(sun);
  S.moon = Astro.moon(now, S.coords.lat, S.coords.lon);

  const alt = sun.altDeg;
  let top, mid, bot, amb;
  if (alt > 10) { top = hex('#1f78e0'); mid = hex('#6db9f2'); bot = hex('#bfe3ff'); amb = 1; }
  else if (alt > 0) {
    const t = alt / 10;
    top = mix(hex('#0a1b3f'), hex('#1f78e0'), t);
    mid = mix(hex('#d65c4f'), hex('#6db9f2'), t);
    bot = mix(hex('#f2b36d'), hex('#bfe3ff'), t); amb = 0.8;
  } else if (alt > -18) {
    const t = (alt + 18) / 18;
    top = mix(hex('#020612'), hex('#0a1b3f'), t);
    mid = mix(hex('#061430'), hex('#d65c4f'), t);
    bot = mix(hex('#102245'), hex('#f2b36d'), t); amb = 0.3;
  } else { top = hex('#020612'); mid = hex('#061430'); bot = hex('#102245'); amb = 0.1; }
  S.amb = amb;
  $('bgGrad').style.background = `linear-gradient(180deg, ${css(top)} 0%, ${css(mid)} 52%, ${css(bot)} 100%)`;

  /* storm flicker */
  const wx = P.wx === 'auto' ? (S.wxNow || 'clear') : P.wx;
  if (wx === 'thunder') {
    S.stormF = Math.min(S.stormF + 0.02, 1);
    if (Math.random() < 0.006) { S.flash = 1; tickSound(); }
  } else S.stormF = Math.max(S.stormF - 0.01, 0);
  if (S.flash > 0.01) {
    $('flash').style.opacity = (S.flash * 0.8).toFixed(2);
    S.flash *= 0.82;
  } else $('flash').style.opacity = 0;

  /* GPU + legacy layers */
  renderGPU(time, sun, S.moon);
  renderLegacy(time, sun.altDeg);
  drawSkyCanvas(sun, amb);

  /* CPU weather particles */
  updateWeatherSystem();
  wxCtx.clearRect(0, 0, W, H);
  for (const p of particles) { p.update(dt); p.draw(wxCtx); }

  /* physics */
  const physT0 = performance.now();
  physStep(dt);
  if (Phys.mode === 'main') TEL.phys.push(performance.now() - physT0);
  else if (Phys.stats.ms) TEL.phys.push(Phys.stats.ms);
  /* tick on fresh hits only; always drain so nothing accumulates */
  if (S.hitsSinceTick > 0 && P.sound && Math.random() < 0.2) tickSound();
  S.hitsSinceTick = 0;

  /* glass layer */
  stepDroplets(dt);
  drawGlass(time);

  /* HUD */
  uiAcc += dt;
  if (uiAcc > 250) {
    uiAcc = 0;
    const rs = getSunRiseSet(now.getTime());
    const sunUp = realSun.altDeg > 0;
    $('hudClock').innerText = now.toLocaleTimeString('en-US', { hour12: false });
    $('hudDate2').innerText = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
    $('hudSun').innerText = sunUp ? `☀ ${realSun.altDeg.toFixed(1)}°` : `☾ ${realSun.altDeg.toFixed(1)}°`;
    $('hudSol').innerText = sunUp ? `↓ ${fmtTime(rs.set)}` : `↑ ${fmtTime(rs.rise)}`;
    $('hudLoc').innerText = S.coords.label;
    $('hudFps').innerText = (1000 / (TEL.frame.avg || 16.7)).toFixed(0) + ' FPS';
    $('chipPhase').innerText = `◐ ${S.phase.toUpperCase()}`;
    $('chipSun').innerText = `☀ ALT ${realSun.altDeg.toFixed(1)}°`;
    $('chipLoc').innerText = `📍 ${S.coords.label}`;
    $('sunCount').innerText = S.sunSolves;
    $('sunCount2').innerText = S.sunSolves;
  }

  TEL.cpu.push(performance.now() - cpuT0);
  requestAnimationFrame(tick);
}

/* ================= SCROLL-SPY / OBSERVERS / EXTRAS (preserved) ====== */
function wireScrollExtras() {
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('visible'); io.unobserve(e.target); }
    });
  }, { threshold: 0.1 });
  document.querySelectorAll('.rv').forEach(el => io.observe(el));

  const dockLinks = document.querySelectorAll('.dock a');
  const sectionIds = ['top', 'about', 'skills', 'log', 'work', 'zone', 'contact'];
  const sections = sectionIds.map(id => $(id)).filter(Boolean);
  function updateDock() {
    const scrollY = window.scrollY + window.innerHeight * 0.35;
    let active = 'top';
    sections.forEach(sec => { if (sec.offsetTop <= scrollY) active = sec.id; });
    dockLinks.forEach(a => a.classList.toggle('on', a.dataset.sec === active));
  }
  window.addEventListener('scroll', updateDock, { passive: true });
  dockLinks.forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    const target = $(a.dataset.sec);
    if (target) target.scrollIntoView({ behavior: RM ? 'auto' : 'smooth', block: 'start' });
  }));

  document.querySelectorAll('.wcard.tilt').forEach(card => {
    card.addEventListener('pointermove', e => {
      if (RM) return;
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      card.style.transform = `perspective(900px) rotateX(${-py * 6}deg) rotateY(${px * 6}deg) translateY(-4px)`;
    });
    card.addEventListener('pointerleave', () => { card.style.transform = ''; });
  });

  let hintRevealedOnce = false;
  function showHint(msg, ms = 4000) {
    const h = $('hint');
    if (!h) return;
    if (msg) h.innerText = msg;
    root.classList.add('show-hint');
    clearTimeout(showHint._t);
    showHint._t = setTimeout(() => root.classList.remove('show-hint'), ms);
  }
  setTimeout(() => showHint('💧 TIP · PRESS ` FOR THE DEV CONSOLE · SCROLL TO THE ZONE FOR PHYSICS'), 2500);
  const zoneEl = $('zone');
  if (zoneEl) {
    const zo = new IntersectionObserver(es => {
      es.forEach(e => {
        if (e.isIntersecting && !hintRevealedOnce) {
          hintRevealedOnce = true;
          showHint('⚠ DRAG A SPECIMEN TO FLING IT — WALLS SQUASH ON IMPACT');
          zo.unobserve(zoneEl);
        }
      });
    }, { threshold: 0.3 });
    zo.observe(zoneEl);
  }
}

/* ================= BOOT ============================================== */
function boot() {
  wireConsole();
  wireScrollExtras();
  initLegacy();
  buildPipeline();
  resize();
  resizeLegacy();
  physInit();
  physSyncParams();
  syncUIFromParams();
  fetchWeather();
  setTimeout(tryGeo, 1500);
  setInterval(fetchWeather, 300000);
  document.body.classList.remove('booting');
  requestAnimationFrame(tick);
  console.info('%c AERO ENGINE v3.0.3 · GPU/CPU EXTREME BUILD · press ` for console ',
    'background:#0b62c4;color:#fff;border-radius:4px;padding:2px 6px');
}
boot();
})();
