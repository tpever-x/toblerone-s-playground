/**
 * YK_LOGIC // EDA AUTOROUTER SIMULATION
 * Replaces generic particles with a 2D canvas procedural A* / Manhattan routing 
 * algorithm to simulate FPGA interconnect tracks compiling in real-time.
 */

(() => {
  'use strict';

  // --- Master Clock UI ---
  const clockEl = document.getElementById('sysClock');
  setInterval(() => {
    const d = new Date();
    clockEl.innerText = d.toLocaleTimeString('en-US', { hour12: false });
  }, 1000);

  // --- Procedural Canvas Router ---
  const canvas = document.getElementById('substrate');
  const ctx = canvas.getContext('2d', { alpha: false });
  let W, H;
  const gridSize = 40; // Must match CSS background-size
  
  let traces = [];
  const maxTraces = 25;
  const colors = ['#3B82F6', '#D4AF37', '#2D3748']; // UV Litho, Gold, Active Trace

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W;
    canvas.height = H;
    traces = [];
  }
  window.addEventListener('resize', resize);
  resize();

  class Trace {
    constructor() {
      this.reset();
    }

    reset() {
      // Snap to grid
      this.x = Math.floor((Math.random() * W) / gridSize) * gridSize;
      this.y = Math.floor((Math.random() * H) / gridSize) * gridSize;
      this.path = [{ x: this.x, y: this.y }];
      this.color = colors[Math.floor(Math.random() * colors.length)];
      this.length = Math.floor(Math.random() * 15) + 5;
      this.speed = (Math.random() > 0.5 ? 1 : 2) * (gridSize / 10);
      this.dir = Math.floor(Math.random() * 4); // 0: N, 1: E, 2: S, 3: W
      this.isRouting = true;
      this.life = 1.0;
    }

    update() {
      if (!this.isRouting) {
        this.life -= 0.005;
        if (this.life <= 0) this.reset();
        return;
      }

      // 90-degree routing logic
      if (Math.random() < 0.1) {
        // Change direction (must remain orthogonal)
        this.dir = (this.dir + (Math.random() > 0.5 ? 1 : 3)) % 4;
      }

      let dx = 0, dy = 0;
      if (this.dir === 0) dy = -this.speed;
      if (this.dir === 1) dx = this.speed;
      if (this.dir === 2) dy = this.speed;
      if (this.dir === 3) dx = -this.speed;

      this.x += dx;
      this.y += dy;

      // Check grid intersection to anchor path nodes
      if (this.x % gridSize === 0 && this.y % gridSize === 0) {
        this.path.push({ x: this.x, y: this.y });
        if (this.path.length > this.length || this.x < 0 || this.x > W || this.y < 0 || this.y > H) {
          this.isRouting = false; // Finished routing, begin decay
        }
      }
    }

    draw(ctx) {
      if (this.path.length < 2) return;
      ctx.beginPath();
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = this.life * 0.6; // Keep subtle

      ctx.moveTo(this.path[0].x, this.path[0].y);
      for (let i = 1; i < this.path.length; i++) {
        ctx.lineTo(this.path[i].x, this.path[i].y);
      }
      // Draw active routing tip
      if (this.isRouting) {
        ctx.lineTo(this.x, this.y);
        ctx.fillStyle = this.color;
        ctx.fillRect(this.x - 2, this.y - 2, 4, 4);
      }
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    }
  }

  // Populate initial traces
  for (let i = 0; i < maxTraces; i++) {
    setTimeout(() => {
      traces.push(new Trace());
    }, i * 200); // Stagger start times
  }

  // Master clock cycle
  function render() {
    // Substrate background clear
    ctx.fillStyle = '#090A0C';
    ctx.fillRect(0, 0, W, H);

    traces.forEach(t => {
      t.update();
      t.draw(ctx);
    });

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);

})();
