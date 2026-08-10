(() => {
'use strict';
const TAU=Math.PI*2, RAD=Math.PI/180, DEG=180/Math.PI;
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const lerp=(a,b,t)=>a+(b-a)*t;
const normD=d=>((d%360)+360)%360;
const hex=h=>[parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
const mix=(a,b,t)=>[lerp(a[0],b[0],t),lerp(a[1],b[1],t),lerp(a[2],b[2],t)];
const css=(c,a=1)=>`rgba(${c[0]|0},${c[1]|0},${c[2]|0},${a})`;
const $=id=>document.getElementById(id);
const RM=matchMedia('(prefers-reduced-motion: reduce)').matches;
const root=document.documentElement;

const S={ coords:{lat:38.42,lon:27.14,label:'İZMİR, TR'}, live:null, wxNow:null, sun:null, sunScr:{x:0,y:0},
  moon:null, pal:null, amb:1, phase:'noon', t:0, fps:60, sunSolves:0, fogA:0,
  stars:[], clouds:[], bolts:[], boltT:2, flash:0, rbA:0, stormF:0, geoState:'idle' };
const P={ theme:'auto', wx:'auto', density:RM?0.4:1, gravity:1, windOv:-1, elas:1, dropSize:7, sound:false, zeroG:true };

/* ===== ASTRONOMY ===== */
const Astro={
  gmst(d){return normD(280.46061837+360.98564736629*d)*RAD;},
  sunEcl(d){const g=normD(357.529+0.98560028*d)*RAD;return normD(280.459+0.98564736*d+1.915*Math.sin(g)+0.020*Math.sin(2*g));},
  position(date,latDeg,lonDeg){
    const d=date.getTime()/86400000+2440587.5-2451545.0;
    const L=this.sunEcl(d)*RAD, e=(23.439-0.00000036*d)*RAD;
    const RA=Math.atan2(Math.cos(e)*Math.sin(L),Math.cos(L));
    const dec=Math.asin(Math.sin(e)*Math.sin(L));
    const H=this.gmst(d)+lonDeg*RAD-RA, lat=latDeg*RAD;
    const alt=Math.asin(Math.sin(lat)*Math.sin(dec)+Math.cos(lat)*Math.cos(dec)*Math.cos(H));
    const azS=Math.atan2(Math.sin(H),Math.cos(H)*Math.sin(lat)-Math.tan(dec)*Math.cos(lat));
    return {altDeg:alt*DEG, azDeg:normD(azS*DEG+180), H, decDeg:dec*DEG};
  },
  moon(date,latDeg,lonDeg){
    const d=date.getTime()/86400000+2440587.5-2451545.0;
    const Lm=normD(218.316+13.176396*d)*RAD, M=normD(134.963+13.064993*d)*RAD, F=normD(93.272+13.229350*d)*RAD;
    const lo=Lm+6.289*RAD*Math.sin(M), la=5.128*RAD*Math.sin(F), e=(23.439-0.00000036*d)*RAD;
    const RA=Math.atan2(Math.sin(lo)*Math.cos(e)-Math.tan(la)*Math.sin(e),Math.cos(lo));
    const dec=Math.asin(Math.sin(la)*Math.cos(e)+Math.cos(la)*Math.sin(e)*Math.sin(lo));
    const H=this.gmst(d)+lonDeg*RAD-RA, lat=latDeg*RAD;
    const alt=Math.asin(Math.sin(lat)*Math.sin(dec)+Math.cos(lat)*Math.cos(dec)*Math.cos(H));
    const azS=Math.atan2(Math.sin(H),Math.cos(H)*Math.sin(lat)-Math.tan(dec)*Math.cos(lat));
    const elong=normD(lo*DEG-this.sunEcl(d));
    return {altDeg:alt*DEG, azDeg:normD(azS*DEG+180), H, illum:(1-Math.cos(elong*RAD))/2, waxing:elong<180};
  }
};
const THEME_SYNTH={dawn:{alt:-4,H:-1.6},morning:{alt:16,H:-0.9},noon:{alt:64,H:0.02},afternoon:{alt:16,H:0.9},dusk:{alt:-4,H:1.6},night:{alt:-32,H:Math.PI}};

function effSun(){
  if(P.theme!=='auto'){
    const s=THEME_SYNTH[P.theme];
    return { altDeg: s.alt, azDeg: 180, H: s.H, decDeg: 0 };
  }
  return S.sun || Astro.position(new Date(), S.coords.lat, S.coords.lon);
}

/* ===== CANVAS SETUP ===== */
const skyCv = $('sky'), skyCtx = skyCv.getContext('2d', { alpha: false });
const wxCv = $('wx'), wxCtx = wxCv.getContext('2d');
const glCv = $('glassCv'), glCtx = glCv.getContext('2d');
let W = window.innerWidth, H = window.innerHeight;

function resize() {
  W = window.innerWidth; H = window.innerHeight;
  [skyCv, wxCv, glCv].forEach(c => { c.width = W; c.height = H; });
  
  S.stars = [];
  for (let i = 0; i < 200; i++) {
    S.stars.push({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.5, a: Math.random()
    });
  }
}
window.addEventListener('resize', resize);
resize();

/* ===== WEATHER FETCH & PARTICLES ===== */
async function fetchWeather() {
  $('hudSrc').innerText = 'SYNCING WX...';
  try {
    const { lat, lon } = S.coords; 
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
    if (!res.ok) throw new Error('API blocked or unavailable');
    
    const data = await res.json();
    const code = data.current_weather.weathercode;
    
    let type = 'clear';
    if ([51,53,55,61,63,65,80,81,82].includes(code)) type = 'rain';
    else if ([71,73,75,77,85,86].includes(code)) type = 'snow';
    else if ([45,48].includes(code)) type = 'fog';
    else if ([95,96,99].includes(code)) type = 'thunder';
    
    S.wxNow = type;
    $('hudWx').innerText = `TEMP ${data.current_weather.temperature}°C`;
    $('hudSrc').innerText = 'OPEN-METEO LIVE';
    $('chipWx').innerText = `🌡 ${data.current_weather.temperature}°C`;
    
  } catch (err) {
    console.warn('Weather engine offline, falling back to clear sky.', err);
    S.wxNow = 'clear';
    $('hudWx').innerText = 'WX OFFLINE';
    $('hudSrc').innerText = 'LOCAL FALLBACK';
    $('chipWx').innerText = `🌡 --`;
  }
}

let particles = [];

class Particle {
  constructor(type) {
    this.type = type; 
    this.reset(true);
  }
  reset(randomY = false) {
    this.x = Math.random() * W;
    this.y = randomY ? Math.random() * H : -10;
    this.size = this.type === 'rain' ? Math.random() * 1.5 + 0.5 : Math.random() * 2.5 + 1;
    this.vy = (this.type === 'rain' ? Math.random() * 8 + 8 : Math.random() * 2 + 1) * P.gravity;
    this.vx = P.windOv !== -1 ? P.windOv / 10 : (Math.random() - 0.5) * (this.type === 'snow' ? 1 : 0.5);
  }
  update(dt) {
    this.x += this.vx * (dt / 16);
    this.y += this.vy * (dt / 16);
    if (this.y > H || this.x < -20 || this.x > W + 20) this.reset();
  }
  draw(ctx) {
    ctx.fillStyle = this.type === 'rain' ? 'rgba(170, 210, 255, 0.6)' : 'rgba(255, 255, 255, 0.8)';
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
  const targetCount = targetType === 'rain' ? 300 * P.density : targetType === 'snow' ? 150 * P.density : 0;
  
  if (targetType === 'fog') S.fogA = Math.min(S.fogA + 0.01, 1);
  else S.fogA = Math.max(S.fogA - 0.05, 0);
  $('fogBlur').style.opacity = S.fogA;

  if (particles.length < targetCount) particles.push(new Particle(targetType));
  else if (particles.length > targetCount) particles.pop();
}

/* ===== PHYSICS ARENA ===== */
const stage = $('stage');
let specs = [];
let dragSpec = null;
let mouseX = 0, mouseY = 0, lastMx = 0, lastMy = 0;

function createSpecimen() {
  const el = document.createElement('div');
  el.className = 'spec';
  el.style.width = '42px'; el.style.height = '42px';
  el.style.setProperty('--h', Math.floor(Math.random() * 360));
  
  const span = document.createElement('span');
  span.className = 'spec-e'; span.innerText = ['⚡','⚙️','💧','🔥','❄️'][Math.floor(Math.random()*5)];
  el.appendChild(span);
  
  stage.appendChild(el);
  
  const spec = {
    el, x: stage.offsetWidth / 2, y: stage.offsetHeight / 2,
    vx: (Math.random() - 0.5) * 10, vy: (Math.random() - 0.5) * 10,
    r: 21, mass: 1
  };
  
  el.addEventListener('pointerdown', (e) => {
    dragSpec = spec; el.classList.add('grabbed');
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointerup', () => {
    if(dragSpec) { dragSpec.el.classList.remove('grabbed'); dragSpec = null; }
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
  let totalKe = 0;
  const rect = stage.getBoundingClientRect();
  const W = rect.width, H = rect.height;

  specs.forEach((s, i) => {
    if (s !== dragSpec) {
      if (!P.zeroG) s.vy += 0.5; // Gravity pull
      s.vx *= 0.99; s.vy *= 0.99; // Friction
      s.x += s.vx * (dt / 16);
      s.y += s.vy * (dt / 16);

      // Arena Boundaries
      if (s.x - s.r < 0) { s.x = s.r; s.vx *= -P.elas; $('hitOut').innerText = ++S.boltT; }
      if (s.x + s.r > W) { s.x = W - s.r; s.vx *= -P.elas; $('hitOut').innerText = ++S.boltT; }
      if (s.y - s.r < 0) { s.y = s.r; s.vy *= -P.elas; $('hitOut').innerText = ++S.boltT; }
      if (s.y + s.r > H) { s.y = H - s.r; s.vy *= -P.elas; $('hitOut').innerText = ++S.boltT; }
    }

    // Specimen Inter-Collisions (Elastic)
    for (let j = i + 1; j < specs.length; j++) {
      const s2 = specs[j];
      const dx = s2.x - s.x, dy = s2.y - s.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = s.r + s2.r;
      
      if (dist < minDist) {
        const angle = Math.atan2(dy, dx);
        const overlap = minDist - dist;
        const ax = (Math.cos(angle) * overlap) / 2;
        const ay = (Math.sin(angle) * overlap) / 2;
        
        if(s !== dragSpec) { s.x -= ax; s.y -= ay; }
        if(s2 !== dragSpec) { s2.x += ax; s2.y += ay; }
        
        const nx = dx / dist, ny = dy / dist;
        const p = 2 * (s.vx * nx + s.vy * ny - s2.vx * nx - s2.vy * ny) / (s.mass + s2.mass);
        
        if(s !== dragSpec) { s.vx -= p * s2.mass * nx * P.elas; s.vy -= p * s2.mass * ny * P.elas; }
        if(s2 !== dragSpec) { s2.vx += p * s.mass * nx * P.elas; s2.vy += p * s.mass * ny * P.elas; }
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

/* ===== DEV CONSOLE & HUD BINDINGS ===== */
$('gear').addEventListener('click', () => $('devcon').classList.toggle('hidden'));
$('cClose').addEventListener('click', () => $('devcon').classList.add('hidden'));
$('cMin').addEventListener('click', () => $('cBody').style.display = $('cBody').style.display === 'none' ? 'block' : 'none');

document.addEventListener('keydown', e => {
  if (e.key === '`' || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd')) {
    e.preventDefault(); $('devcon').classList.toggle('hidden');
  }
});

// UI Inputs
$('sDens').addEventListener('input', e => { P.density = e.target.value; $('vDens').innerText = P.density + '×'; });
$('sGrav').addEventListener('input', e => { P.gravity = e.target.value; $('vGrav').innerText = P.gravity + '×'; });
$('sElas').addEventListener('input', e => { P.elas = e.target.value; $('vElas').innerText = P.elas; $('eOut').innerText = P.elas; });
$('sSize').addEventListener('input', e => { P.dropSize = parseFloat(e.target.value); $('vSize').innerText = P.dropSize + 'px'; });

$('btnZero').addEventListener('click', (e) => { P.zeroG = !P.zeroG; e.target.classList.toggle('on'); e.target.innerText = `ZERO-G: ${P.zeroG ? 'ON' : 'OFF'}`; });
$('btnAdd').addEventListener('click', createSpecimen);
$('btnChaos').addEventListener('click', () => specs.forEach(s => { s.vx *= 2.5; s.vy *= 2.5; }));

document.querySelectorAll('#thBtns .cbtn').forEach(b => b.addEventListener('click', e => {
  document.querySelectorAll('#thBtns .cbtn').forEach(btn => btn.classList.remove('on'));
  e.target.classList.add('on');
  P.theme = e.target.dataset.th;
}));

document.querySelectorAll('#wxBtns .cbtn').forEach(b => b.addEventListener('click', e => {
  document.querySelectorAll('#wxBtns .cbtn').forEach(btn => btn.classList.remove('on'));
  e.target.classList.add('on');
  P.wx = e.target.dataset.wx;
}));

/* ===== MAIN RENDER LOOP ===== */
let lastTime = 0;
function tick(time) {
  const dt = time - lastTime;
  lastTime = time;
  
  const sun = effSun();
  S.sunSolves++;
  
  // Sky Background Colors based on Altitude
  const alt = sun.altDeg;
  let top, mid, bot, amb;
  if (alt > 10) { top = hex('#1f78e0'); mid = hex('#6db9f2'); bot = hex('#bfe3ff'); amb = 1; }
  else if (alt > 0) { const t = alt/10; top = mix(hex('#0a1b3f'), hex('#1f78e0'), t); mid = mix(hex('#d65c4f'), hex('#6db9f2'), t); bot = mix(hex('#f2b36d'), hex('#bfe3ff'), t); amb = 0.8; }
  else if (alt > -18) { const t = (alt+18)/18; top = mix(hex('#020612'), hex('#0a1b3f'), t); mid = mix(hex('#061430'), hex('#d65c4f'), t); bot = mix(hex('#102245'), hex('#f2b36d'), t); amb = 0.3; }
  else { top = hex('#020612'); mid = hex('#061430'); bot = hex('#102245'); amb = 0.1; }
  
  $('bgGrad').style.background = `linear-gradient(180deg, ${css(top)} 0%, ${css(mid)} 52%, ${css(bot)} 100%)`;
  
  skyCtx.clearRect(0, 0, W, H);
  wxCtx.clearRect(0, 0, W, H);
  glCtx.clearRect(0, 0, W, H);

  // Starlight (drawn only when ambient light drops)
  if (amb < 0.6) {
    skyCtx.fillStyle = '#fff';
    S.stars.forEach(s => {
      skyCtx.globalAlpha = s.a * (1 - amb);
      skyCtx.beginPath(); skyCtx.arc(s.x, s.y, s.r, 0, TAU); skyCtx.fill();
    });
    skyCtx.globalAlpha = 1;
  }

  // Solar Draw (only visible if above horizon)
  if (alt > -5) {
    const sY = H - (alt / 70) * (H * 0.6);
    root.style.setProperty('--sun-y', `${sY}px`);
    skyCtx.fillStyle = '#fff';
    skyCtx.beginPath(); skyCtx.arc(W/2, sY, 40, 0, TAU); skyCtx.fill();
    skyCtx.shadowBlur = 40; skyCtx.shadowColor = '#fff'; skyCtx.fill(); skyCtx.shadowBlur = 0;
  }

  updateWeatherSystem();
  particles.forEach(p => { p.update(dt); p.draw(wxCtx); });
  physicsLoop(dt);

  // HUD Metrics
  const now = new Date();
  $('hudClock').innerText = now.toLocaleTimeString('en-US', {hour12:false});
  $('tAlt').innerText = sun.altDeg.toFixed(2) + '°';
  $('tFps').innerText = Math.round(1000 / dt) + ' FPS';
  $('hudFps').innerText = Math.round(1000 / dt) + ' FPS';
  $('sunCount').innerText = S.sunSolves;
  $('sunCount2').innerText = S.sunSolves;
  $('tParts').innerText = particles.length;

  requestAnimationFrame(tick);
}

// System Boot
fetchWeather(); 
createSpecimen();
createSpecimen();
createSpecimen();
requestAnimationFrame(tick);

})();
