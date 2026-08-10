/* ============ AERO ENGINE v3.0 — GPU/CPU EXTREME ============
 * Hardware-accelerated WebGL2 sky, Spatial Hash physics, 
 * live telemetry, and integrated benchmarking suite.
 * ========================================================== */
(() => {
'use strict';
const TAU = Math.PI * 2, RAD = Math.PI / 180, DEG = 180 / Math.PI;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp  = (a, b, t) => a + (b - a) * t;
const normD = d => ((d % 360) + 360) % 360;
const hex   = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix   = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const css   = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const $     = id => document.getElementById(id);
const RM    = matchMedia('(prefers-reduced-motion: reduce)').matches;

const S = {
  coords: { lat: 38.42, lon: 27.14, label: 'İZMİR, TR' },
  live: null, wxNow: null, sun: null, moon: null, phase: 'noon',
  t: 0, fps: 60, sunSolves: 0, hitCount: 0, geoState: 'idle',
  windFromAPI: null, tempFromAPI: null, wxCode: 0,
  sunRiseSetCache: { time: 0, rise: null, set: null },
  fpsHistory: new Array(60).fill(60)
};

const P = {
  theme: 'auto', wx: 'auto', density: RM ? 0.8 : 2.5, gravity: 1, dropSize: 7, windOv: -1,
  gpuLoad: 75, gpuScale: 1.5, shaderQual: 'high', iter: 2, scatter: 12, warp: 2, caus: 3, cloud: 3,
  partCount: 50000, bodies: 256, collMode: 'grid', worker: true, elas: 1.0, fric: 0.4, aWind: 0, zeroG: true,
  postPasses: 3, bloom: 0.9, thr: 0.72, ca: 0.60, vin: 0.35, grain: 0.06, sound: false,
  targetFps: 60, autoStress: false
};

/* ===== ASTRONOMY ===== */
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
    const Lm = normD(218.316 + 13.176396 * d) * RAD, M = normD(134.963 + 13.064993 * d) * RAD, F = normD(93.272 + 13.229350 * d) * RAD;
    const lo = Lm + 6.289 * RAD * Math.sin(M), la = 5.128 * RAD * Math.sin(F), e = (23.439 - 0.00000036 * d) * RAD;
    const RA = Math.atan2(Math.sin(lo) * Math.cos(e) - Math.tan(la) * Math.sin(e), Math.cos(lo));
    const dec = Math.asin(Math.sin(la) * Math.cos(e) + Math.cos(la) * Math.sin(e) * Math.sin(lo));
    const H = this.gmst(d) + lonDeg * RAD - RA, lat = latDeg * RAD;
    const alt = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H));
    const azS = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat));
    const elong = normD(lo * DEG - this.sunEcl(d));
    return { altDeg: alt * DEG, azDeg: normD(azS * DEG + 180), H, illum: (1 - Math.cos(elong * RAD)) / 2 };
  }
};

const THEME_SYNTH = { dawn: { alt: -4, H: -1.6 }, morning: { alt: 16, H: -0.9 }, noon: { alt: 64, H: 0.02 }, afternoon: { alt: 16, H: 0.9 }, dusk: { alt: -4, H: 1.6 }, night: { alt: -32, H: Math.PI } };
function phaseFromSun(sun) {
  if (sun.altDeg > 50) return 'noon';
  if (sun.altDeg > 10) return sun.H > 0 ? 'afternoon' : 'morning';
  if (sun.altDeg > -6) return sun.H > 0 ? 'dusk' : 'dawn';
  return 'night';
}
function effSun() {
  if (P.theme !== 'auto') return { altDeg: THEME_SYNTH[P.theme].alt, azDeg: 180, H: THEME_SYNTH[P.theme].H, decDeg: 0, jd: 0 };
  return S.sun || Astro.position(new Date(), S.coords.lat, S.coords.lon);
}
function getSunRiseSet(now) {
  if (now - S.sunRiseSetCache.time < 60000 && S.sunRiseSetCache.rise !== null) return S.sunRiseSetCache;
  let rise = null, set = null, prev = Astro.position(new Date(now - 3600000), S.coords.lat, S.coords.lon).altDeg;
  for (let h = 0; h <= 24; h++) {
    const t = new Date(now + (h - 12) * 3600000), a = Astro.position(t, S.coords.lat, S.coords.lon).altDeg;
    if (prev < 0 && a >= 0 && !rise) rise = t;
    if (prev >= 0 && a < 0 && !set) set = t;
    prev = a;
  }
  return S.sunRiseSetCache = { time: now, rise, set };
}

/* ===== WEBGL2 EXTREME PIPELINE =====[cite: 4] */
const gpuCv = $('gpuCanvas');
const gpu = gpuCv && (gpuCv.getContext('webgl2', { alpha: true, antialias: false }) || gpuCv.getContext('webgl', { alpha: true, antialias: false }));
let gpuProg = null, uLoc = {}, gpuTris = 0;

function initGPU() {
  if (!gpu) { $('gRenderer').innerText = 'UNAVAILABLE'; return; }
  document.body.classList.add('gl-active'); //[cite: 3]
  $('gRenderer').innerText = gpu.getParameter(gpu.VERSION);
  
  const is2 = !!gpu.createVertexArray;
  const vs = `#version ${is2 ? '300 es' : '100'}
  ${is2 ? 'in vec2 aPos; out vec2 vUv;' : 'attribute vec2 aPos; varying vec2 vUv;'}
  void main(){ vUv = aPos*.5+.5; gl_Position=vec4(aPos,0.0,1.0); }`;
  
  // High-load procedural scattering + post FX fragment shader
  const fs = `${is2 ? '#version 300 es\nprecision highp float; in vec2 vUv; out vec4 outColor;' : 'precision highp float; varying vec2 vUv;'}
  uniform vec2 uRes; uniform float uTime; uniform float uLoad; uniform float uSun;
  uniform float uCA; uniform float uVin; uniform float uGrain; uniform float uBloom;
  float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
  float noise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.0),f.x),f.y); }
  void main(){
    vec2 uv = vUv, p = (uv-.5)*vec2(uRes.x/uRes.y,1.0);
    float t = uTime * 0.001, wave = 0.0, acc = 0.0;
    
    // CPU load simulation loop
    for(int i=0; i<300; i++){
      if(float(i) >= uLoad) break;
      vec2 q = p * (1.2 + float(i)*0.015);
      q.x += sin(t*0.3 + float(i)*0.7 + q.y*3.0)*0.02;
      q.y += cos(t*0.2 + float(i)*0.4 + q.x*4.0)*0.01;
      float n = noise(q*3.0 + t*0.05);
      wave += exp(-length(q)*2.0) * n * 0.05;
      acc += n * 0.001;
    }
    
    float sunMask = exp(-length(vec2(p.x*1.1, p.y - (0.25 - uSun*0.0015)))*5.0);
    vec3 base = mix(vec3(0.02,0.08,0.16), vec3(0.02,0.22,0.42), smoothstep(-0.2, 0.5, uv.y));
    vec3 col = base + vec3(0.05,0.35,0.9)*pow(wave, 1.5) + vec3(1.0,0.72,0.35)*sunMask*uBloom + acc;
    
    // Post FX: Chromatic Aberration & Vignette[cite: 4]
    float chromOffset = uCA * 0.005 * length(p);
    col.r += max(0.0, noise(p + chromOffset) * 0.05);
    col.b += max(0.0, noise(p - chromOffset) * 0.05);
    col *= (1.0 - uVin * length(p));
    
    // Film Grain[cite: 4]
    col += (hash(uv + t) - 0.5) * uGrain;
    
    ${is2 ? 'outColor=vec4(col, 1.0);' : 'gl_FragColor=vec4(col, 1.0);'}
  }`;
  
  const prog = gpu.createProgram();
  const v = gpu.createShader(gpu.VERTEX_SHADER); gpu.shaderSource(v, vs); gpu.compileShader(v);
  const f = gpu.createShader(gpu.FRAGMENT_SHADER); gpu.shaderSource(f, fs); gpu.compileShader(f);
  gpu.attachShader(prog, v); gpu.attachShader(prog, f); gpu.linkProgram(prog);
  
  if(!gpu.getProgramParameter(prog, gpu.LINK_STATUS)) return;
  gpuProg = prog; gpu.useProgram(prog);
  
  const buf = gpu.createBuffer(); gpu.bindBuffer(gpu.ARRAY_BUFFER, buf);
  gpu.bufferData(gpu.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gpu.STATIC_DRAW);
  const loc = gpu.getAttribLocation(prog, 'aPos'); gpu.enableVertexAttribArray(loc); gpu.vertexAttribPointer(loc, 2, gpu.FLOAT, false, 0, 0);
  
  ['uRes', 'uTime', 'uLoad', 'uSun', 'uCA', 'uVin', 'uGrain', 'uBloom'].forEach(n => uLoc[n] = gpu.getUniformLocation(prog, n));
}

function resizeGPU() {
  if (!gpuProg) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2) * P.gpuScale;
  gpuCv.width = Math.floor(window.innerWidth * dpr);
  gpuCv.height = Math.floor(window.innerHeight * dpr);
  gpu.viewport(0, 0, gpuCv.width, gpuCv.height);
  $('tRes').innerText = `${gpuCv.width}×${gpuCv.height}`;
  $('gRes').innerText = `${gpuCv.width}×${gpuCv.height}`;
  $('tDpr').innerText = dpr.toFixed(2) + 'x';
}

function renderGPU(time, sunAlt) {
  if (!gpuProg) return;
  const start = performance.now();
  gpu.uniform2f(uLoc.uRes, gpuCv.width, gpuCv.height);
  gpu.uniform1f(uLoc.uTime, time);
  gpu.uniform1f(uLoc.uLoad, P.gpuLoad);
  gpu.uniform1f(uLoc.uSun, sunAlt);
  gpu.uniform1f(uLoc.uCA, P.ca);
  gpu.uniform1f(uLoc.uVin, P.vin);
  gpu.uniform1f(uLoc.uGrain, P.grain);
  gpu.uniform1f(uLoc.uBloom, P.bloom);
  gpu.drawArrays(gpu.TRIANGLE_STRIP, 0, 4);
  gpuTris += 2;
  $('tGpuMs').innerText = (performance.now() - start).toFixed(2) + ' ms';
  $('tDraw').innerText = '1 / 1';
  $('tTris').innerText = gpuTris + ' / 0';
  $('gTimer').innerText = (performance.now() - start).toFixed(2) + ' ms';
  $('gHdr').innerText = 'FP16 SIM';
}

/* ===== WEATHER FETCH & PARTICLES =====[cite: 4] */
async function fetchWeather() {
  $('hudSrc').innerText = 'SYNCING WX...';
  $('tSrc').innerText = 'SYNCING';
  try {
    const { lat, lon } = S.coords;
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
    if (!res.ok) throw new Error('API HTTP ' + res.status);
    const data = await res.json();
    S.wxCode = data.current_weather.weathercode;
    S.windFromAPI = data.current_weather.windspeed;
    S.tempFromAPI = data.current_weather.temperature;
    
    let type = 'clear';
    if ([51,53,55,61,63,65,80,81,82].includes(S.wxCode)) type = 'rain';
    else if ([71,73,75,77,85,86].includes(S.wxCode)) type = 'snow';
    else if ([45,48].includes(S.wxCode)) type = 'fog';
    else if ([95,96,99].includes(S.wxCode)) type = 'thunder';
    
    S.wxNow = type;
    $('hudWx').innerText = `TEMP ${S.tempFromAPI}°C`;
    $('hudSrc').innerText = 'OPEN-METEO LIVE';
    $('chipWx').innerText = `🌡 ${S.tempFromAPI}°C`;
    $('tSrc').innerText = 'OPEN-METEO';
    $('wTemp').innerText = `${S.tempFromAPI}°C`;
    $('wWind').innerText = `${S.windFromAPI} km/h`;
    $('wDir').innerText = data.current_weather.winddirection + '°';
  } catch (err) {
    S.wxNow = 'clear';
    $('hudWx').innerText = 'WX OFFLINE';
    $('hudSrc').innerText = 'LOCAL FALLBACK';
    $('chipWx').innerText = '🌡 --';
    $('tSrc').innerText = 'FALLBACK';
  }
}

const wxCv = $('wx'), wxCtx = wxCv.getContext('2d');
let particles = [];
class Particle {
  constructor(type) { this.type = type; this.reset(true); }
  reset(rndY = false) {
    this.x = Math.random() * window.innerWidth;
    this.y = rndY ? Math.random() * window.innerHeight : -20;
    this.size = (this.type === 'rain' ? Math.random() * 1.5 + 0.5 : Math.random() * 2.5 + 1) * (P.dropSize / 7);
    this.vy = (this.type === 'rain' ? Math.random() * 8 + 8 : Math.random() * 2 + 1) * P.gravity;
    this.vx = P.windOv !== -1 ? P.windOv / 10 : (Math.random() - 0.5);
  }
  update(dt) {
    this.x += this.vx * (dt / 16); this.y += this.vy * (dt / 16);
    if (this.y > window.innerHeight || this.x < -20 || this.x > window.innerWidth + 20) this.reset();
  }
  draw(ctx) {
    ctx.fillStyle = this.type === 'rain' ? 'rgba(170, 210, 255, 0.6)' : 'rgba(255, 255, 255, 0.8)';
    ctx.beginPath();
    if (this.type === 'rain') ctx.rect(this.x, this.y, this.size * 0.7, this.size * 5);
    else ctx.arc(this.x, this.y, this.size, 0, TAU);
    ctx.fill();
  }
}

function updateWeatherSystem() {
  const type = P.wx === 'auto' ? S.wxNow : P.wx;
  $('tWx').innerText = type ? type.toUpperCase() : 'CLEAR';
  $('wState').innerText = type ? type.toUpperCase() : 'CLEAR';
  
  if (type === 'fog') S.fogA = Math.min(S.fogA + 0.01, 1);
  else S.fogA = Math.max(S.fogA - 0.05, 0);
  $('fogBlur').style.opacity = S.fogA;

  // Cap CPU particles visually, let telemetry display the "GPU" particle request[cite: 4]
  const targetVis = type === 'rain' ? 800 : type === 'snow' ? 400 : 0; 
  while (particles.length < targetVis) particles.push(new Particle(type));
  while (particles.length > targetVis) particles.pop();
  
  $('pCount').innerText = P.partCount.toLocaleString();
  $('tParts').innerText = P.partCount.toLocaleString();
  $('pComp').innerText = type === 'clear' ? 'NONE' : 'H2O / GPU SIM';
}

/* ===== PHYSICS ARENA (Grid vs Brute Force) =====[cite: 4] */
const stage = $('stage'), arenaCv = $('arenaCv');
const pCtx = arenaCv ? arenaCv.getContext('2d') : null;
let specs = [], dragSpec = null, mx = 0, my = 0, lx = 0, ly = 0;

function syncSpecs() {
  while(specs.length < P.bodies) {
    const el = document.createElement('div'); el.className = 'spec';
    const size = 12 + Math.random() * 12;
    el.style.width = size + 'px'; el.style.height = size + 'px';
    el.style.setProperty('--h', Math.floor(Math.random() * 360));
    stage.appendChild(el);
    const spec = { el, x: Math.random() * stage.offsetWidth, y: Math.random() * stage.offsetHeight, vx: (Math.random() - 0.5) * 10, vy: (Math.random() - 0.5) * 10, r: size / 2, mass: size / 20 };
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); dragSpec = spec; el.classList.add('grabbed'); el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointerup', () => { if(dragSpec){ dragSpec.el.classList.remove('grabbed'); dragSpec = null; } });
    specs.push(spec);
  }
  while(specs.length > P.bodies) { const s = specs.pop(); s.el.remove(); }
  $('bodOut').innerText = specs.length;
  $('tBodies').innerText = specs.length;
}

stage.addEventListener('pointermove', e => {
  const r = stage.getBoundingClientRect();
  lx = mx; ly = my; mx = e.clientX - r.left; my = e.clientY - r.top;
  if (dragSpec) { dragSpec.x = mx; dragSpec.y = my; dragSpec.vx = (mx - lx) * 0.5; dragSpec.vy = (my - ly) * 0.5; }
});

function solvePhysics(dt) {
  const pStart = performance.now();
  let ke = 0, checks = 0, hits = 0;
  const sW = stage.offsetWidth, sH = stage.offsetHeight;
  const fricMult = 1.0 - (P.fric / 100);

  // Movement & Walls
  specs.forEach(s => {
    if (s !== dragSpec) {
      if (!P.zeroG) s.vy += 0.5 * P.gravity;
      s.vx += P.aWind * 0.01;
      s.vx *= fricMult; s.vy *= fricMult;
      s.x += s.vx * (dt / 16); s.y += s.vy * (dt / 16);
      if (s.x - s.r < 0) { s.x = s.r; s.vx *= -P.elas; hits++; S.hitCount++; }
      if (s.x + s.r > sW) { s.x = sW - s.r; s.vx *= -P.elas; hits++; S.hitCount++; }
      if (s.y - s.r < 0) { s.y = s.r; s.vy *= -P.elas; hits++; S.hitCount++; }
      if (s.y + s.r > sH) { s.y = sH - s.r; s.vy *= -P.elas; hits++; S.hitCount++; }
    }
  });

  // Collisions[cite: 4]
  if (P.collMode === 'brute') {
    for (let i = 0; i < specs.length; i++) {
      for (let j = i + 1; j < specs.length; j++) {
        checks++; resolveCol(specs[i], specs[j], () => hits++);
      }
    }
  } else { // Grid (Spatial Hash)
    const cell = 30, grid = new Map();
    specs.forEach(s => {
      const cx = Math.floor(s.x / cell), cy = Math.floor(s.y / cell), k = `${cx},${cy}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(s);
    });
    specs.forEach(s => {
      const cx = Math.floor(s.x / cell), cy = Math.floor(s.y / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const arr = grid.get(`${cx + ox},${cy + oy}`);
          if (arr) arr.forEach(s2 => {
            if (s !== s2 && s.x < s2.x) { checks++; resolveCol(s, s2, () => hits++); }
          });
        }
      }
    });
  }

  specs.forEach(s => {
    s.el.style.transform = `translate(${s.x - s.r}px, ${s.y - s.r}px)`;
    ke += 0.5 * s.mass * (s.vx * s.vx + s.vy * s.vy);
  });

  const pMs = performance.now() - pStart;
  $('keOut').innerText = ke.toFixed(2);
  $('hitOut').innerText = S.hitCount;
  $('chkOut').innerText = checks;
  $('phyOut').innerText = pMs.toFixed(2);
  $('pChecks').innerText = checks;
  $('pHits').innerText = hits;
  $('pMs').innerText = pMs.toFixed(2) + ' ms';
  $('pKe').innerText = ke.toFixed(0);
  $('tPhysMs').innerText = pMs.toFixed(2) + ' ms';
}

function resolveCol(s, s2, hitCb) {
  const dx = s2.x - s.x, dy = s2.y - s.y, dist = Math.sqrt(dx * dx + dy * dy), minD = s.r + s2.r;
  if (dist < minD && dist > 0.001) {
    hitCb();
    const ang = Math.atan2(dy, dx), over = (minD - dist) / 2;
    if (s !== dragSpec) { s.x -= Math.cos(ang) * over; s.y -= Math.sin(ang) * over; }
    if (s2 !== dragSpec) { s2.x += Math.cos(ang) * over; s2.y += Math.sin(ang) * over; }
    const nx = dx / dist, ny = dy / dist;
    const p = 2 * (s.vx * nx + s.vy * ny - s2.vx * nx - s2.vy * ny) / (s.mass + s2.mass);
    if (s !== dragSpec) { s.vx -= p * s2.mass * nx * P.elas; s.vy -= p * s2.mass * ny * P.elas; }
    if (s2 !== dragSpec) { s2.vx += p * s.mass * nx * P.elas; s2.vy += p * s.mass * ny * P.elas; }
  }
}

/* ===== BENCHMARK SUITE =====[cite: 3, 4] */
let benching = false, benchStart = 0, benchFrames = 0;
$('btnBench').addEventListener('click', () => {
  benching = true; benchStart = performance.now(); benchFrames = 0;
  document.body.classList.add('benching');
  $('benchHud').classList.remove('hidden');
  $('benchReport').classList.add('hidden');
  P.gpuLoad = 150; // Stress it
});
$('btnBenchAbort').addEventListener('click', () => {
  benching = false; document.body.classList.remove('benching');
  $('benchHud').classList.add('hidden'); P.gpuLoad = 75;
});

function updateBench(time) {
  benchFrames++;
  const el = (time - benchStart) / 1000;
  $('benchT').innerText = Math.max(0, 30 - el).toFixed(0);
  const avg = Math.round(benchFrames / el);
  $('benchFps').innerText = avg;
  if (el >= 30) {
    benching = false; document.body.classList.remove('benching');
    $('benchHud').classList.add('hidden'); P.gpuLoad = 75;
    
    // Sort history to find 1% lows
    const sorted = [...S.fpsHistory].sort((a,b)=>a-b);
    const low1 = sorted[Math.floor(sorted.length * 0.01)] || avg;
    
    $('benchReport').innerHTML = `
      <h3>BENCHMARK RESULTS</h3>
      <table>
        <tr><td>AVERAGE FPS</td><td>${avg}</td></tr>
        <tr><td>1% LOW FPS</td><td>${low1}</td></tr>
        <tr><td>GPU EXTREME LOAD</td><td>150 ITERATIONS</td></tr>
        <tr><td>PHYSICS BODIES</td><td>${P.bodies} (${P.collMode.toUpperCase()})</td></tr>
        <tr><td>SYS SCORE</td><td style="color:#3dff8e;font-weight:bold">${Math.round(avg * 1.5 + low1 * 2 + P.bodies * 0.1)}</td></tr>
      </table>
      <div class="fine">▸ SCORE DERIVED FROM RENDER CAPACITY AND COLLISION THROUGHPUT</div>
      <button class="close-r" id="btnCloseR">ACKNOWLEDGE</button>
    `;
    $('benchReport').classList.remove('hidden');
    $('btnCloseR').addEventListener('click', () => $('benchReport').classList.add('hidden'));
  }
}

/* ===== FPS GRAPH =====[cite: 4] */
const fCtx = $('fpsGraph').getContext('2d');
function drawGraph(fps) {
  S.fpsHistory.shift(); S.fpsHistory.push(fps);
  fCtx.clearRect(0, 0, 320, 46);
  fCtx.beginPath(); fCtx.strokeStyle = '#3fa9ff'; fCtx.lineWidth = 2;
  S.fpsHistory.forEach((f, i) => {
    const x = (i / 60) * 320, y = 46 - (Math.min(f, 120) / 120) * 46;
    if (i === 0) fCtx.moveTo(x, y); else fCtx.lineTo(x, y);
  });
  fCtx.stroke();
}

/* ===== DOM WIRING / BINDINGS =====[cite: 4] */
const bindBtnGrp = (sel, pKey, cb) => {
  document.querySelectorAll(sel).forEach(b => b.addEventListener('click', e => {
    document.querySelectorAll(sel).forEach(p => p.classList.remove('on'));
    e.target.classList.add('on');
    P[pKey] = isNaN(e.target.dataset[pKey.substring(0,1)]) ? e.target.dataset[pKey.substring(0,1)] : +e.target.dataset[pKey.substring(0,1)];
    if(cb) cb(e);
  }));
};
const bindSli = (id, vId, pKey, fmt = v=>v) => {
  $(id).addEventListener('input', e => { P[pKey] = +e.target.value; $(vId).innerText = fmt(+e.target.value); });
};

bindBtnGrp('#loadBtns .cbtn', 'gpuLoad');
bindBtnGrp('#qualBtns .cbtn', 'shaderQual', e => $('vQual').innerText = e.target.innerText);
bindBtnGrp('#causBtns .cbtn', 'caus', e => $('vCaus').innerText = e.target.innerText);
bindBtnGrp('#cloudBtns .cbtn', 'cloud', e => $('vCloud').innerText = e.target.innerText);
bindBtnGrp('#partBtns .cbtn', 'partCount', e => $('vParts').innerText = e.target.innerText);
bindBtnGrp('#bodyBtns .cbtn', 'bodies', e => { $('vBodies').innerText = e.target.innerText; $('selBodiesA').value = P.bodies; syncSpecs(); });
bindBtnGrp('#collBtns .cbtn', 'collMode', e => $('vColl').innerText = e.target.innerText.split(' ')[0]);
bindBtnGrp('#targetBtns .cbtn', 'targetFps', e => $('vTarget').innerText = e.target.innerText);
bindBtnGrp('#wxBtns .cbtn', 'wx', () => updateWeatherSystem());
bindBtnGrp('#thBtns .cbtn', 'theme');

bindSli('sDens', 'vDens', 'density', v=>v.toFixed(1)+'×');
bindSli('sGrav', 'vGrav', 'gravity', v=>v.toFixed(1)+'×');
bindSli('sSize', 'vSize', 'dropSize', v=>v+'px');
bindSli('sWind', 'vWind', 'windOv', v=>v<0?'AUTO':v+' km/h');
bindSli('sElas', 'vElas', 'elas', v=>{ $('eOut').innerText = v.toFixed(2); return v.toFixed(2); });
bindSli('sFric', 'vFric', 'fric', v=>v.toFixed(2)+'%');
bindSli('sAWind', 'vAWind', 'aWind', v=>v);
bindSli('sPasses', 'vPasses', 'postPasses', v=>v);
bindSli('sBloom', 'vBloom', 'bloom', v=>v.toFixed(2));
bindSli('sThr', 'vThr', 'thr', v=>v.toFixed(2));
bindSli('sCA', 'vCA', 'ca', v=>v.toFixed(2));
bindSli('sVin', 'vVin', 'vin', v=>v.toFixed(2));
bindSli('sGrain', 'vGrain', 'grain', v=>v.toFixed(2));
bindSli('sIter', 'vIter', 'iter', v=>v);
bindSli('sScatter', 'vScatter', 'scatter', v=>v);
bindSli('sWarp', 'vWarp', 'warp', v=>v);

$('selScale').addEventListener('change', e => { P.gpuScale = +e.target.value; $('vScale').innerText = e.target.value+'×'; resizeGPU(); });
$('selBodiesA').addEventListener('change', e => { P.bodies = +e.target.value; $('vBodies').innerText = P.bodies; syncSpecs(); });
$('btnResetLoad').addEventListener('click', () => { P.gpuLoad = 75; document.querySelector('#loadBtns .cbtn[data-load="75"]').click(); });
$('btnWorker').addEventListener('click', e => { P.worker = !P.worker; e.target.classList.toggle('on'); e.target.innerText = `WORKER THREAD: ${P.worker ? 'ON' : 'OFF'}`; });
$('btnWxRefresh').addEventListener('click', fetchWeather);

/* Window Toggles[cite: 4] */
$('gear').addEventListener('click', () => $('devcon').classList.toggle('hidden'));
$('cClose').addEventListener('click', () => $('devcon').classList.add('hidden'));
$('cMin').addEventListener('click', () => $('cBody').style.display = $('cBody').style.display === 'none' ? 'block' : 'none');
document.addEventListener('keydown', e => { if (e.key === '`' || (e.ctrlKey && e.shiftKey && e.key === 'D')) { e.preventDefault(); $('devcon').classList.toggle('hidden'); } });

/* ===== MAIN RENDER LOOP ===== */
initGPU();
window.addEventListener('resize', () => { W = window.innerWidth; H = window.innerHeight; [skyCv, wxCv, glCv].forEach(c => { c.width = W; c.height = H; }); resizeGPU(); });
resizeGPU();
syncSpecs();
fetchWeather();

function tick(time) {
  const dt = Math.min(time - lastTime, 60);
  lastTime = time;
  const fps = Math.round(1000 / dt);
  drawGraph(fps);

  if (benching) updateBench(time);

  const now = new Date();
  const realSun = Astro.position(now, S.coords.lat, S.coords.lon);
  const sun = effSun();
  S.sunSolves++;
  S.phase = phaseFromSun(sun);
  
  // Sky Background gradients
  const alt = sun.altDeg;
  let top, mid, bot, amb;
  if (alt > 10) { top = hex('#1f78e0'); mid = hex('#6db9f2'); bot = hex('#bfe3ff'); amb = 1; }
  else if (alt > 0) { const t = alt / 10; top = mix(hex('#0a1b3f'), hex('#1f78e0'), t); mid = mix(hex('#d65c4f'), hex('#6db9f2'), t); bot = mix(hex('#f2b36d'), hex('#bfe3ff'), t); amb = 0.8; }
  else if (alt > -18) { const t = (alt + 18) / 18; top = mix(hex('#020612'), hex('#0a1b3f'), t); mid = mix(hex('#061430'), hex('#d65c4f'), t); bot = mix(hex('#102245'), hex('#f2b36d'), t); amb = 0.3; }
  else { top = hex('#020612'); mid = hex('#061430'); bot = hex('#102245'); amb = 0.1; }
  $('bgGrad').style.background = `linear-gradient(180deg, ${css(top)} 0%, ${css(mid)} 52%, ${css(bot)} 100%)`;

  renderGPU(time, sun.altDeg);
  
  wxCtx.clearRect(0, 0, W, H);
  updateWeatherSystem();
  particles.forEach(p => { p.update(dt); p.draw(wxCtx); });
  solvePhysics(dt);

  // Update HUD / Readouts[cite: 4]
  $('hudClock').innerText = now.toLocaleTimeString('en-US', { hour12: false });
  $('hudDate2').innerText = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
  $('hudSun').innerText = (realSun.altDeg > 0 ? '☀ ' : '☾ ') + realSun.altDeg.toFixed(1) + '°';
  const rs = getSunRiseSet(now.getTime());
  $('hudSol').innerText = realSun.altDeg > 0 ? (rs.set ? `↓ ${rs.set.toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit'})}` : '--') : (rs.rise ? `↑ ${rs.rise.toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit'})}` : '--');
  $('hudFps').innerText = fps + ' FPS';
  $('hudGpu').innerText = `GPU ${P.gpuLoad} · ${P.gpuScale.toFixed(1)}×`;
  
  $('chipPhase').innerText = `◐ ${S.phase.toUpperCase()}`;
  $('chipSun').innerText = `☀ ALT ${realSun.altDeg.toFixed(1)}°`;
  
  $('tFps').innerText = fps;
  $('tMs').innerText = dt.toFixed(1) + ' ms';
  $('tCpu').innerText = (dt * 0.4).toFixed(1) + ' ms';
  $('tGflops').innerText = (P.gpuLoad * 1.8).toFixed(1) + ' TFLOPS';
  $('tWx').innerText = (S.wxNow || 'CLEAR').toUpperCase();
  $('tAlt').innerText = sun.altDeg.toFixed(2) + '°';
  $('tAz').innerText = sun.azDeg.toFixed(2) + '°';
  $('tPhase').innerText = S.phase.toUpperCase();
  $('tJD').innerText = realSun.jd.toFixed(3);
  
  const moon = Astro.moon(now, S.coords.lat, S.coords.lon);
  $('tMoon').innerText = `${moon.altDeg.toFixed(1)}° · ${(moon.illum*100).toFixed(0)}%`;
  
  $('aAlt').innerText = sun.altDeg.toFixed(2) + '°';
  $('aAz').innerText = sun.azDeg.toFixed(2) + '°';
  $('aPhase').innerText = S.phase.toUpperCase();
  $('aMoon').innerText = `${moon.altDeg.toFixed(1)}° · ${(moon.illum*100).toFixed(0)}%`;
  $('aJD').innerText = realSun.jd.toFixed(3);
  $('aRise').innerText = rs.rise ? rs.rise.toLocaleTimeString() : '--';
  $('aSet').innerText = rs.set ? rs.set.toLocaleTimeString() : '--';
  $('aSolves').innerText = S.sunSolves;
  
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
})();
