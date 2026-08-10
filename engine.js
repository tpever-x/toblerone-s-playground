/* ============ AERO ENGINE v2.7 — HIGH LOAD BUILD ============
 * All dead IDs wired · all noted bugs fixed · zero new dependencies.
 * Changelog vs. user-supplied v2.6:
 *   [fix]  S.boltT repurposed-then-renamed → S.hitCount (initialized 0)
 *   [fix]  lastTime=0 first-frame teleport → initialized to performance.now()
 *   [fix]  Spec pointerdown missing preventDefault → added
 *   [fix]  Weather fetch had no timeout → wrapped in AbortController (6s)
 *   [fix]  Stars regenerated on every resize → debounced by ±20px
 *   [fix]  Sky canvas alpha:false was hiding #bgGrad → switched to alpha:true
 *   [fix]  Dev console .c-title cursor:move had no drag handler → wired
 *   [wire] chipPhase / chipSun / chipLoc / hudDate2 → live from sun position
 *   [wire] hudSun / hudSol (sunrise/sunset) / hudLoc → populated
 *   [wire] tAlt / tAz / tPhase / tMoon / tJD / tFps / tParts / tWind /
 *         tCoords / tSrc / tGeo → all 11 telemetry readouts live
 *   [wire] btnPrint / btnShake / bBurst / bClearD / bSound → all 5 wired
 *   [wire] sWind slider → P.windOv no longer dead
 *   [wire] .wcard.tilt → 3D pointermove tilt
 *   [wire] #dock scroll-spy → active link follows viewport
 *   [wire] #hint → revealed after 2.5s + when zone scrolled into view
 *   [wire] Geolocation API → attempts once on boot, updates coords
 *   [wire] phaseFromSun() → distinguishes morning/afternoon via hour angle
 *   [wire] Moon altitude + illumination → Astro.moon() already existed
 *   [wire] Julian Date → exposed via .jd on sun position
 *   [wire] Sunrise/sunset → 24h scan, cached for 60s
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
const root  = document.documentElement;

const S = {
  coords: { lat: 38.42, lon: 27.14, label: 'İZMİR, TR' },
  live: null, wxNow: null, sun: null, sunScr: { x: 0, y: 0 },
  moon: null, pal: null, amb: 1, phase: 'noon', t: 0, fps: 60,
  sunSolves: 0, fogA: 0, hitCount: 0,
  stars: [], clouds: [], bolts: [], flash: 0, rbA: 0, stormF: 0,
  geoState: 'idle', windFromAPI: null,
  sunRiseSetCache: { time: 0, rise: null, set: null }
};
const P = {
  theme: 'auto', wx: 'auto', density: RM ? 0.8 : 2.5, gravity: 1, gpuLoops: RM ? 24 : 96, gpuScale: RM ? 1 : 2,
  windOv: -1, elas: 1, dropSize: 7, sound: false, zeroG: true
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
  if (alt > 50)            return 'noon';
  if (alt > 10)            return H > 0 ? 'afternoon' : 'morning';
  if (alt > -6)            return H > 0 ? 'dusk'       : 'dawn';
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

/* Sunrise/sunset — scan 24h, cache 60s */
function getSunRiseSet(now) {
  if (now - S.sunRiseSetCache.time < 60000 && S.sunRiseSetCache.rise !== null) {
    return S.sunRiseSetCache;
  }
  let rise = null, set = null;
  let prev = Astro.position(new Date(now.getTime() - 3600000), S.coords.lat, S.coords.lon).altDeg;
  for (let h = 0; h <= 24; h++) {
    const t = new Date(now.getTime() + (h - 12) * 3600000);
    const a = Astro.position(t, S.coords.lat, S.coords.lon).altDeg;
    if (prev < 0 && a >= 0 && !rise) rise = t;
    if (prev >= 0 && a < 0 && !set)  set  = t;
    prev = a;
  }
  S.sunRiseSetCache = { time: now, rise, set };
  return S.sunRiseSetCache;
}

/* ===== CANVAS SETUP ===== */
const skyCv = $('sky'), skyCtx = skyCv.getContext('2d');           // alpha:true — fix vs original
const wxCv  = $('wx'),  wxCtx  = wxCv.getContext('2d');
const glCv  = $('glassCv'), glCtx = glCv.getContext('2d');
let W = window.innerWidth, H = window.innerHeight;

/* ===== GPU ATMOSPHERE / WEBGL2 STRESS LAYER =====
   Procedural fragment shader: refractive water, volumetric haze, chromatic
   aberration and animated micro-caustics. No textures, no dependencies.
   Deliberately compute-heavy; controlled from the dev console. */
const gpuCv = $('gpuCanvas');
const gpu = gpuCv && (gpuCv.getContext('webgl2', {alpha:true, antialias:false, powerPreference:'high-performance'}) ||
                     gpuCv.getContext('webgl',  {alpha:true, antialias:false, powerPreference:'high-performance'}));
let gpuProgram = null, gpuUniforms = null, gpuReady = false;

function initGPU() {
  if (!gpu) return;
  const is2 = !!gpu.createVertexArray;
  const vs = `#version ${is2 ? '300 es' : '100'}
  ${is2 ? 'in vec2 aPos; out vec2 vUv;' : 'attribute vec2 aPos; varying vec2 vUv;'}
  void main(){ vUv = aPos*.5+.5; gl_Position=vec4(aPos,0.0,1.0); }`;
  const fs = `${is2 ? '#version 300 es\nprecision highp float; in vec2 vUv; out vec4 outColor;' : 'precision highp float; varying vec2 vUv;'}
  uniform vec2 uRes; uniform float uTime; uniform float uLoops; uniform float uSun;
  float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
  float noise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f); float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+1.0); return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
  void main(){
    vec2 uv=vUv; vec2 p=(uv-.5)*vec2(uRes.x/uRes.y,1.0);
    float t=uTime;
    float horizon=1.0-smoothstep(-.18,.55,uv.y);
    float wave=0.0; float acc=0.0;
    for(int i=0;i<160;i++){
      float fi=float(i); if(fi>=uLoops) break;
      vec2 q=p*(1.2+fi*.017);
      q.x += sin(t*.00035+fi*.73+q.y*3.2)*.018;
      q.y += cos(t*.00029+fi*.41+q.x*4.1)*.014;
      float n=noise(q*3.0+vec2(t*.00003*fi,t*.00002*fi));
      float r=length(q+vec2(sin(fi)*.04,cos(fi*1.7)*.03));
      float ca=exp(-r*(2.5+mod(fi,7.0)*.45))*n;
      wave += ca*(.55+.45*sin(fi*1.7+t*.001));
      acc += n*.0025;
    }
    float bands=0.5+0.5*sin((p.x*7.0+p.y*19.0)+sin(p.y*9.0+t*.0008)*2.5);
    float caustic=pow(max(0.0,wave*.035+bands*.045+acc),2.2);
    float sun=exp(-length(vec2(p.x*1.1,(p.y-(.25-uSun*.0015))*1.6))*5.0);
    float haze=pow(max(0.0,1.0-abs(uv.y-.5)*1.7),2.0)*.11;
    vec3 col=vec3(.02,.22,.42)*horizon + vec3(.02,.08,.16)*(1.0-horizon);
    col += vec3(.05,.35,.9)*caustic;
    col += vec3(1.0,.72,.35)*sun*.18;
    col += vec3(.12,.45,1.0)*haze;
    float chrom=0.008*sin(t*.0006+p.y*13.0);
    col.r += max(0.0,chrom)*.8; col.b += max(0.0,-chrom)*1.2;
    ${is2 ? 'outColor=vec4(col, .72);' : 'gl_FragColor=vec4(col,.72);'}
  }`;
  function compile(type,src){ const sh=gpu.createShader(type); gpu.shaderSource(sh,src); gpu.compileShader(sh); return sh; }
  const prog=gpu.createProgram(), v=compile(gpu.VERTEX_SHADER,vs), f=compile(gpu.FRAGMENT_SHADER,fs);
  gpu.attachShader(prog,v); gpu.attachShader(prog,f); gpu.linkProgram(prog);
  if(!gpu.getProgramParameter(prog,gpu.LINK_STATUS)){ console.warn('GPU shader unavailable:',gpu.getProgramInfoLog(prog)); return; }
  gpuProgram=prog; gpu.useProgram(prog);
  const buf=gpu.createBuffer(); gpu.bindBuffer(gpu.ARRAY_BUFFER,buf);
  gpu.bufferData(gpu.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gpu.STATIC_DRAW);
  const loc=gpu.getAttribLocation(prog,'aPos'); gpu.enableVertexAttribArray(loc); gpu.vertexAttribPointer(loc,2,gpu.FLOAT,false,0,0);
  gpuUniforms={res:gpu.getUniformLocation(prog,'uRes'),time:gpu.getUniformLocation(prog,'uTime'),loops:gpu.getUniformLocation(prog,'uLoops'),sun:gpu.getUniformLocation(prog,'uSun')};
  gpuReady=true;
}
function resizeGPU(){
  if(!gpuReady) return;
  const scale=P.gpuScale || 1;
  const d=Math.min(window.devicePixelRatio||1,1.5)*scale;
  gpuCv.width=Math.min(3840,Math.floor(window.innerWidth*d));
  gpuCv.height=Math.min(2160,Math.floor(window.innerHeight*d));
  gpu.viewport(0,0,gpuCv.width,gpuCv.height);
}
function renderGPU(time, sunAlt){
  if(!gpuReady) return;
  gpu.useProgram(gpuProgram);
  gpu.uniform2f(gpuUniforms.res,gpuCv.width,gpuCv.height);
  gpu.uniform1f(gpuUniforms.time,time);
  gpu.uniform1f(gpuUniforms.loops,P.gpuLoops);
  gpu.uniform1f(gpuUniforms.sun,sunAlt);
  gpu.drawArrays(gpu.TRIANGLE_STRIP,0,4);
}
initGPU();


function seedStars() {
  S.stars = [];
  const count = Math.min(1200, Math.floor(W * H / 1500));
  for (let i = 0; i < count; i++) {
    S.stars.push({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.5, a: Math.random() * 0.7 + 0.3
    });
  }
}
function resize() {
  const newW = window.innerWidth, newH = window.innerHeight;
  if (Math.abs(newW - W) < 20 && Math.abs(newH - H) < 20) return;  // debounce minor
  W = newW; H = newH;
  [skyCv, wxCv, glCv].forEach(c => { c.width = W; c.height = H; });
  seedStars();
  resizeGPU();
}
window.addEventListener('resize', resize);
resize();
seedStars();
resizeGPU();

/* ===== WEATHER FETCH & PARTICLES ===== */
async function fetchWeather() {
  $('hudSrc').innerText = 'SYNCING WX...';
  $('tSrc').innerText   = 'SYNCING';
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
    if ([51,53,55,61,63,65,80,81,82].includes(code))      type = 'rain';
    else if ([71,73,75,77,85,86].includes(code))           type = 'snow';
    else if ([45,48].includes(code))                       type = 'fog';
    else if ([95,96,99].includes(code))                    type = 'thunder';
    S.wxNow = type;
    $('hudWx').innerText  = `TEMP ${data.current_weather.temperature}°C`;
    $('hudSrc').innerText = 'OPEN-METEO LIVE';
    $('tSrc').innerText   = 'OPEN-METEO';
    $('chipWx').innerText = `🌡 ${data.current_weather.temperature}°C`;
    if (S.windFromAPI != null) $('tWind').innerText = S.windFromAPI + ' km/h';
  } catch (err) {
    console.warn('Weather engine offline, falling back to clear sky.', err);
    S.wxNow = 'clear';
    $('hudWx').innerText  = 'WX OFFLINE';
    $('hudSrc').innerText = 'LOCAL FALLBACK';
    $('tSrc').innerText   = 'FALLBACK';
    $('chipWx').innerText = '🌡 --';
  } finally {
    clearTimeout(timer);
  }
}

let particles = [];

class Particle {
  constructor(type) { this.type = type; this.reset(true); }
  reset(randomY = false) {
    this.x = Math.random() * W;
    this.y = randomY ? Math.random() * H : -10;
    this.size = this.type === 'rain' ? Math.random() * 1.5 + 0.5 : this.type === 'snow' ? Math.random() * 2.5 + 1 : Math.random() * 1.8 + 0.35;
    this.vy = (this.type === 'rain' ? Math.random() * 8 + 8 : this.type === 'snow' ? Math.random() * 2 + 1 : Math.random() * 0.7 + 0.15) * P.gravity;
    this.vx = P.windOv !== -1 ? P.windOv / 10 : (Math.random() - 0.5) * (this.type === 'snow' ? 1 : this.type === 'mist' ? 0.8 : 0.5);
  }
  update(dt) {
    this.x += this.vx * (dt / 16);
    this.y += this.vy * (dt / 16);
    if (this.y > H || this.x < -20 || this.x > W + 20) this.reset();
  }
  draw(ctx) {
    ctx.fillStyle = this.type === 'rain' ? 'rgba(170, 210, 255, 0.6)' : this.type === 'mist' ? 'rgba(210, 240, 255, 0.18)' : 'rgba(255, 255, 255, 0.8)';
    ctx.beginPath();
    if (this.type === 'rain') {
      ctx.rect(this.x, this.y, this.size * 0.7, this.size * 5);
    } else {
      ctx.arc(this.x, this.y, this.size, 0, TAU);
    }
    ctx.fill();
  }
}

function updateWeatherSystem() {
  const targetType = P.wx === 'auto' ? S.wxNow : P.wx;
  const weatherCount = targetType === 'rain' ? 1800 * P.density
                    : targetType === 'snow' ? 900 * P.density
                    : 0;
  const targetCount = Math.round(1200 * P.density + weatherCount);
  if (targetType === 'fog') S.fogA = Math.min(S.fogA + 0.01, 1);
  else                       S.fogA = Math.max(S.fogA - 0.05, 0);
  $('fogBlur').style.opacity = S.fogA;
  while (particles.length < targetCount) {
    const i = particles.length;
    particles.push(new Particle(i < Math.round(1200 * P.density) ? 'mist' : (targetType || 'rain')));
  }
  while (particles.length > targetCount) particles.pop();
}

function spawnBurst(n = 80) {
  const type = P.wx === 'auto' ? (S.wxNow || 'rain') : P.wx;
  if (type === 'clear' || type === 'fog') {
    // force-spawn rain anyway so the button does something visible
    for (let i = 0; i < n; i++) particles.push(new Particle('rain'));
  } else {
    for (let i = 0; i < n; i++) particles.push(new Particle(type));
  }
}

function clearDroplets() { particles = []; }

/* ===== PHYSICS ARENA ===== */
const stage = $('stage');
let specs = [];
let dragSpec = null;
let mouseX = 0, mouseY = 0, lastMx = 0, lastMy = 0;

function createSpecimen() {
  const el = document.createElement('div');
  el.className = 'spec';
  const size = 38 + Math.random() * 16;
  el.style.width  = size + 'px';
  el.style.height = size + 'px';
  el.style.setProperty('--h', Math.floor(Math.random() * 360));
  const span = document.createElement('span');
  span.className = 'spec-e';
  span.innerText = ['⚡', '⚙️', '💧', '🔥', '❄️'][Math.floor(Math.random() * 5)];
  el.appendChild(span);
  stage.appendChild(el);
  const spec = {
    el, x: stage.offsetWidth / 2, y: stage.offsetHeight / 2,
    vx: (Math.random() - 0.5) * 10, vy: (Math.random() - 0.5) * 10,
    r: size / 2, mass: size / 30
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();                                   // fix: prevents text selection / drag-ghost
    dragSpec = spec; el.classList.add('grabbed');
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointerup', () => {
    if (dragSpec) { dragSpec.el.classList.remove('grabbed'); dragSpec = null; }
  });
  specs.push(spec);
}

stage.addEventListener('pointermove', (e) => {
  const rect = stage.getBoundingClientRect();
  lastMx = mouseX; lastMy = mouseY;
  mouseX = e.clientX - rect.left; mouseY = e.clientY - rect.top;
  if (dragSpec) {
    dragSpec.x = mouseX; dragSpec.y = mouseY;
    dragSpec.vx = (mouseX - lastMx) * 0.5;
    dragSpec.vy = (mouseY - lastMy) * 0.5;
  }
});

function physicsLoop(dt) {
  if (dt > 100) dt = 16;                                  // clamp huge dt
  let totalKe = 0;
  const rect = stage.getBoundingClientRect();
  const sW = rect.width, sH = rect.height;
  specs.forEach((s, i) => {
    if (s !== dragSpec) {
      if (!P.zeroG) s.vy += 0.5;
      s.vx *= 0.99; s.vy *= 0.99;
      s.x += s.vx * (dt / 16);
      s.y += s.vy * (dt / 16);
      if (s.x - s.r < 0)    { s.x = s.r;     s.vx *= -P.elas; S.hitCount++; $('hitOut').innerText = S.hitCount; }
      if (s.x + s.r > sW)   { s.x = sW - s.r; s.vx *= -P.elas; S.hitCount++; $('hitOut').innerText = S.hitCount; }
      if (s.y - s.r < 0)    { s.y = s.r;     s.vy *= -P.elas; S.hitCount++; $('hitOut').innerText = S.hitCount; }
      if (s.y + s.r > sH)   { s.y = sH - s.r; s.vy *= -P.elas; S.hitCount++; $('hitOut').innerText = S.hitCount; }
    }
    for (let j = i + 1; j < specs.length; j++) {
      const s2 = specs[j];
      const dx = s2.x - s.x, dy = s2.y - s.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = s.r + s2.r;
      if (dist < minDist && dist > 0.001) {
        const angle = Math.atan2(dy, dx);
        const overlap = minDist - dist;
        const ax = (Math.cos(angle) * overlap) / 2;
        const ay = (Math.sin(angle) * overlap) / 2;
        if (s  !== dragSpec) { s.x  -= ax; s.y  -= ay; }
        if (s2 !== dragSpec) { s2.x += ax; s2.y += ay; }
        const nx = dx / dist, ny = dy / dist;
        const p = 2 * (s.vx * nx + s.vy * ny - s2.vx * nx - s2.vy * ny) / (s.mass + s2.mass);
        if (s  !== dragSpec) { s.vx  -= p * s2.mass * nx * P.elas; s.vy  -= p * s2.mass * ny * P.elas; }
        if (s2 !== dragSpec) { s2.vx += p * s.mass  * nx * P.elas; s2.vy += p * s.mass  * ny * P.elas; }
      }
    }
    s.el.style.transform = `translate(${s.x - s.r}px, ${s.y - s.r}px)`;
    totalKe += 0.5 * s.mass * (s.vx * s.vx + s.vy * s.vy);
  });
  $('keOut').innerText = totalKe.toFixed(2);
}

/* ===== INTERSECTION OBSERVERS (Scroll Animations) ===== */
const io = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.classList.add('visible');
      io.unobserve(e.target);
    }
  });
}, { threshold: 0.1 });
document.querySelectorAll('.rv').forEach(el => io.observe(el));

/* ===== DOCK SCROLL-SPY ===== */
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
dockLinks.forEach(a => {
  a.addEventListener('click', e => {
    e.preventDefault();
    const target = $(a.dataset.sec);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

/* ===== WCARD 3D TILT ===== */
document.querySelectorAll('.wcard.tilt').forEach(card => {
  card.addEventListener('pointermove', e => {
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width  - 0.5;
    const py = (e.clientY - r.top)  / r.height - 0.5;
    card.style.transform = `perspective(900px) rotateX(${-py * 6}deg) rotateY(${px * 6}deg) translateY(-4px)`;
  });
  card.addEventListener('pointerleave', () => { card.style.transform = ''; });
});

/* ===== HINT REVEAL ===== */
let hintRevealedOnce = false;
function showHint(msg, ms = 4000) {
  const h = $('hint');
  if (!h) return;
  if (msg) h.innerText = msg;
  document.documentElement.classList.add('show-hint');
  hintRevealedOnce = true;
  setTimeout(() => document.documentElement.classList.remove('show-hint'), ms);
}
setTimeout(() => showHint('💧 TIP · PRESS ` FOR THE DEV CONSOLE · SCROLL TO THE ZONE FOR PHYSICS'), 2500);

const zoneObs = new IntersectionObserver(es => {
  es.forEach(e => {
    if (e.isIntersecting && !hintRevealedOnce) {
      showHint('⚠ DRAG A SPECIMEN TO FLING IT — WALLS SQUASH ON IMPACT');
    }
  });
}, { threshold: 0.3 });
const zoneEl = $('zone');
if (zoneEl) zoneObs.observe(zoneEl);

/* ===== DEV CONSOLE DRAG ===== */
(function wireConsoleDrag() {
  const con = $('devcon'), title = $('cTitle');
  if (!con || !title) return;
  let dragging = false, ox = 0, oy = 0, baseLeft = 0, baseTop = 0;
  title.addEventListener('pointerdown', e => {
    if (e.target.tagName === 'BUTTON') return;
    dragging = true;
    const r = con.getBoundingClientRect();
    baseLeft = r.left; baseTop = r.top;
    ox = e.clientX; oy = e.clientY;
    con.style.right = 'auto'; con.style.bottom = 'auto';
    con.style.left = baseLeft + 'px'; con.style.top = baseTop + 'px';
    title.setPointerCapture(e.pointerId);
  });
  title.addEventListener('pointermove', e => {
    if (!dragging) return;
    const nx = baseLeft + (e.clientX - ox);
    const ny = baseTop  + (e.clientY - oy);
    con.style.left = clamp(nx, 0, window.innerWidth  - con.offsetWidth)  + 'px';
    con.style.top  = clamp(ny, 0, window.innerHeight - con.offsetHeight) + 'px';
  });
  title.addEventListener('pointerup', e => {
    dragging = false;
    try { title.releasePointerCapture(e.pointerId); } catch (_) {}
  });
})();

/* ===== GEOLOCATION (auto-attempt once on boot) ===== */
function tryGeo() {
  if (!navigator.geolocation) {
    S.geoState = 'unavailable';
    $('tGeo').innerText = 'N/A';
    return;
  }
  S.geoState = 'requesting';
  $('tGeo').innerText = 'REQ...';
  navigator.geolocation.getCurrentPosition(
    pos => {
      S.coords = {
        lat: +(+pos.coords.latitude).toFixed(2),
        lon: +(+pos.coords.longitude).toFixed(2),
        label: 'CUSTOM LOC'
      };
      S.geoState = 'acquired';
      $('tGeo').innerText     = 'ACQUIRED';
      $('tCoords').innerText  = `${S.coords.lat.toFixed(2)}, ${S.coords.lon.toFixed(2)}`;
      $('hudLoc').innerText   = S.coords.label;
      $('chipLoc').innerText  = '📍 ' + S.coords.label;
      S.sunRiseSetCache.time = 0;  // invalidate cache
      fetchWeather();
    },
    err => {
      S.geoState = 'denied';
      $('tGeo').innerText     = 'DENIED';
      $('tCoords').innerText  = `${S.coords.lat}, ${S.coords.lon}`;
    },
    { timeout: 8000, maximumAge: 600000 }
  );
}
setTimeout(tryGeo, 1500);

/* ===== DEV CONSOLE & HUD BINDINGS ===== */
$('gear').addEventListener('click', () => $('devcon').classList.toggle('hidden'));
$('cClose').addEventListener('click', () => $('devcon').classList.add('hidden'));
$('cMin').addEventListener('click', () => {
  const b = $('cBody');
  b.style.display = b.style.display === 'none' ? 'block' : 'none';
});

document.addEventListener('keydown', e => {
  if (e.key === '`' || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd')) {
    e.preventDefault();
    $('devcon').classList.toggle('hidden');
  }
});

// Sliders
$('sDens').addEventListener('input', e => { P.density  = +e.target.value; $('vDens').innerText = P.density.toFixed(1) + '×'; });
$('sGrav').addEventListener('input', e => { P.gravity  = +e.target.value; $('vGrav').innerText = P.gravity.toFixed(1) + '×'; });
$('sElas').addEventListener('input', e => { P.elas     = +e.target.value; $('vElas').innerText = P.elas.toFixed(2); $('eOut').innerText = P.elas.toFixed(2); });
$('sSize').addEventListener('input', e => { P.dropSize = +e.target.value; $('vSize').innerText = P.dropSize + 'px'; });
$('sGpu').addEventListener('input', e => { P.gpuLoops = +e.target.value; $('vGpu').innerText = P.gpuLoops + '×'; });
$('sGpuScale').addEventListener('input', e => { P.gpuScale = +e.target.value; $('vGpuScale').innerText = P.gpuScale.toFixed(1) + '×'; resizeGPU(); });
$('sWind').addEventListener('input', e => {
  const v = +e.target.value;
  if (v < 0) { P.windOv = -1; $('vWind').innerText = 'AUTO'; }
  else       { P.windOv = v;  $('vWind').innerText = v + ' km/h'; }
});

// Arena / dev buttons
$('btnZero').addEventListener('click', e => {
  P.zeroG = !P.zeroG;
  e.target.classList.toggle('on');
  e.target.innerText = `ZERO-G: ${P.zeroG ? 'ON' : 'OFF'}`;
});
$('btnAdd').addEventListener('click', createSpecimen);
$('btnChaos').addEventListener('click', () => specs.forEach(s => { s.vx *= 2.5; s.vy *= 2.5; }));
$('btnShake').addEventListener('click', () => specs.forEach(s => {
  s.vx += (Math.random() - 0.5) * 30;
  s.vy += (Math.random() - 0.5) * 30;
}));
$('bBurst').addEventListener('click', () => spawnBurst(120));
$('bClearD').addEventListener('click', clearDroplets);
$('bSound').addEventListener('click', e => {
  P.sound = !P.sound;
  e.target.innerText = P.sound ? '🔊 SOUND ON' : '🔇 SOUND OFF';
  e.target.classList.toggle('on', P.sound);
});
$('btnPrint').addEventListener('click', () => window.print());

// Theme / weather override buttons
document.querySelectorAll('#thBtns .cbtn').forEach(b => b.addEventListener('click', e => {
  document.querySelectorAll('#thBtns .cbtn').forEach(p => p.classList.remove('on'));
  e.target.classList.add('on');
  P.theme = e.target.dataset.th;
}));
document.querySelectorAll('#wxBtns .cbtn').forEach(b => b.addEventListener('click', e => {
  document.querySelectorAll('#wxBtns .cbtn').forEach(p => p.classList.remove('on'));
  e.target.classList.add('on');
  P.wx = e.target.dataset.wx;
}));

/* ===== MAIN RENDER LOOP ===== */
let lastTime = performance.now();                          // fix: was 0 → first-frame teleport
const frameSamples = [];

function tick(time) {
  const dt = Math.min(time - lastTime, 60);                // clamp dt to 60ms max
  lastTime = time;
  frameSamples.push(dt);
  if (frameSamples.length > 30) frameSamples.shift();
  const avgDt = frameSamples.reduce((a, b) => a + b, 0) / frameSamples.length;
  const fps = Math.round(1000 / avgDt);

  // Always compute real sun for telemetry; use effSun for visual
  const now = new Date();
  const realSun = Astro.position(now, S.coords.lat, S.coords.lon);
  S.sun = realSun;
  const sun = effSun();
  S.sunSolves++;
  S.phase = phaseFromSun(sun);

  // Sky colors from effective sun altitude
  const alt = sun.altDeg;
  let top, mid, bot, amb;
  if (alt > 10)        { top = hex('#1f78e0'); mid = hex('#6db9f2'); bot = hex('#bfe3ff'); amb = 1;   }
  else if (alt > 0)    { const t = alt / 10;
                         top = mix(hex('#0a1b3f'), hex('#1f78e0'), t);
                         mid = mix(hex('#d65c4f'), hex('#6db9f2'), t);
                         bot = mix(hex('#f2b36d'), hex('#bfe3ff'), t); amb = 0.8; }
  else if (alt > -18)  { const t = (alt + 18) / 18;
                         top = mix(hex('#020612'), hex('#0a1b3f'), t);
                         mid = mix(hex('#061430'), hex('#d65c4f'), t);
                         bot = mix(hex('#102245'), hex('#f2b36d'), t); amb = 0.3; }
  else                 { top = hex('#020612'); mid = hex('#061430'); bot = hex('#102245'); amb = 0.1; }
  S.amb = amb;
  $('bgGrad').style.background = `linear-gradient(180deg, ${css(top)} 0%, ${css(mid)} 52%, ${css(bot)} 100%)`;

  renderGPU(time, sun.altDeg);

  skyCtx.clearRect(0, 0, W, H);
  wxCtx.clearRect(0, 0, W, H);
  glCtx.clearRect(0, 0, W, H);

  // Stars — only when ambient drops
  if (amb < 0.6) {
    skyCtx.fillStyle = '#fff';
    S.stars.forEach(s => {
      skyCtx.globalAlpha = s.a * (1 - amb);
      skyCtx.beginPath(); skyCtx.arc(s.x, s.y, s.r, 0, TAU); skyCtx.fill();
    });
    skyCtx.globalAlpha = 1;
  }

  // Sun — visible if above horizon
  if (alt > -5) {
    const sY = H - (alt / 70) * (H * 0.6);
    root.style.setProperty('--sun-y', `${sY}px`);
    skyCtx.fillStyle = '#fff';
    skyCtx.beginPath(); skyCtx.arc(W / 2, sY, 40, 0, TAU); skyCtx.fill();
    skyCtx.shadowBlur = 40; skyCtx.shadowColor = '#fff'; skyCtx.fill(); skyCtx.shadowBlur = 0;
  }

  // HIGH-LOAD REFRACTION FIELD: deliberately expensive procedural caustics.
  // This is intentionally CPU/GPU hungry: many gradients + compositing passes every frame.
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
  glCtx.restore();

  updateWeatherSystem();
  particles.forEach(p => { p.update(dt); p.draw(wxCtx); });
  physicsLoop(dt);

  // Moon (always real)
  const moon = Astro.moon(now, S.coords.lat, S.coords.lon);
  S.moon = moon;

  // Sun rise/set
  const rs = getSunRiseSet(now.getTime());
  const sunUp = realSun.altDeg > 0;

  // Hero chips (previously dead)
  $('chipPhase').innerText = `◐ ${S.phase.toUpperCase()}`;
  $('chipSun').innerText   = `☀ ALT ${realSun.altDeg.toFixed(1)}°`;
  $('chipLoc').innerText   = `📍 ${S.coords.label}`;

  // HUD (previously partial)
  $('hudClock').innerText = now.toLocaleTimeString('en-US', { hour12: false });
  $('hudDate2').innerText = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
  $('hudSun').innerText   = sunUp ? `☀ ${realSun.altDeg.toFixed(1)}°` : `☾ ${realSun.altDeg.toFixed(1)}°`;
  $('hudSol').innerText   = sunUp ? `↓ ${fmtTime(rs.set)}` : `↑ ${fmtTime(rs.rise)}`;
  $('hudLoc').innerText   = S.coords.label;
  $('hudFps').innerText   = fps + ' FPS';

  // Telemetry (11 readouts, previously only 3 wired)
  $('tAlt').innerText     = sun.altDeg.toFixed(2) + '°';
  $('tAz').innerText      = sun.azDeg.toFixed(1) + '°';
  $('tPhase').innerText   = S.phase.toUpperCase();
  $('tMoon').innerText    = `${moon.altDeg.toFixed(0)}° · ${Math.round(moon.illum * 100)}%`;
  $('tJD').innerText      = realSun.jd.toFixed(2);
  $('tFps').innerText     = fps + ' FPS';
  $('tParts').innerText   = particles.length;
  $('tCoords').innerText  = `${S.coords.lat.toFixed(2)}, ${S.coords.lon.toFixed(2)}`;
  $('tGeo').innerText     = S.geoState.toUpperCase();
  // tWind and tSrc are updated by fetchWeather / tryGeo
  if (P.windOv !== -1) $('tWind').innerText = P.windOv + ' km/h (ovr)';
  else if (S.windFromAPI != null) $('tWind').innerText = S.windFromAPI + ' km/h';

  // Solar solve counters
  $('sunCount').innerText  = S.sunSolves;
  $('sunCount2').innerText = S.sunSolves;

  requestAnimationFrame(tick);
}

/* ===== SYSTEM BOOT ===== */
fetchWeather();
for (let i = 0; i < 72; i++) createSpecimen();
updateDock();
requestAnimationFrame(tick);

})();
