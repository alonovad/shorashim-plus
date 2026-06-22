/* ============================================
   SHORASHIM PLUS — EFFECTS ENGINE
   Vanilla JS — no dependencies
   
   Usage:
     import { initEffects } from './effects.js';
     initEffects();  // call after DOM ready
   
   Or selectively:
     import { initBgOrbs, initSparkles, initFallingLeaves, initBotanicals, initButtonEffects } from './effects.js';
   ============================================ */

// --- Configuration ---
const CONFIG = {
  sparkles: { count: 10, minSize: 2, maxSize: 4 },
  leaves: { count: 4, minDur: 8, maxDur: 14, minSize: 10, maxSize: 20 },
  botanicals: true,
  buttonBurstCount: 6,
};

// --- SVG Templates ---
const SVG = {
  leaf: (color, w = 24, h = 32) => `
    <svg width="${w}" height="${h}" viewBox="0 0 24 32" class="botanical" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 0C12 0 0 10 0 20c0 6.6 5.4 12 12 12s12-5.4 12-12C24 10 12 0 12 0z" fill="${color}" opacity="0.12"/>
      <path d="M12 4c0 0-8 7-8 14.5c0 0 3-2 8-2s8 2 8 2C20 11 12 4 12 4z" fill="${color}" opacity="0.08"/>
      <path d="M12 2 L12 28" stroke="${color}" stroke-width="0.5" opacity="0.2"/>
      <path d="M12 10 L7 16 M12 14 L6 21 M12 18 L8 24 M12 10 L17 16 M12 14 L18 21 M12 18 L16 24" stroke="${color}" stroke-width="0.3" opacity="0.15" fill="none"/>
    </svg>`,

  palmFrond: (color) => `
    <svg width="60" height="80" viewBox="0 0 60 80" class="botanical" xmlns="http://www.w3.org/2000/svg">
      <path d="M30 80 C30 80 30 40 30 20 C30 10 20 0 10 0 C20 5 25 15 28 30 C20 15 10 10 0 12 C15 15 22 22 26 35 C18 25 8 22 0 25 C12 28 20 33 25 42 Z" fill="${color}" opacity="0.08"/>
      <path d="M30 80 C30 80 30 40 30 20 C30 10 40 0 50 0 C40 5 35 15 32 30 C40 15 50 10 60 12 C45 15 38 22 34 35 C42 25 52 22 60 25 C48 28 40 33 35 42 Z" fill="${color}" opacity="0.08"/>
      <path d="M30 78 L30 18" stroke="${color}" stroke-width="0.8" opacity="0.12" fill="none"/>
    </svg>`,

  branch: (color) => `
    <svg width="50" height="60" viewBox="0 0 50 60" class="botanical" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 58 C5 58 10 40 15 30 C20 20 25 15 30 10 C35 5 40 2 45 0" stroke="${color}" stroke-width="1" opacity="0.12" fill="none" stroke-linecap="round"/>
      <path d="M20 35 C20 35 15 28 8 26" stroke="${color}" stroke-width="0.6" opacity="0.1" fill="none" stroke-linecap="round"/>
      <path d="M28 22 C28 22 22 18 16 18" stroke="${color}" stroke-width="0.6" opacity="0.1" fill="none" stroke-linecap="round"/>
      <path d="M35 12 C35 12 30 10 26 12" stroke="${color}" stroke-width="0.6" opacity="0.1" fill="none" stroke-linecap="round"/>
      <circle cx="8" cy="26" r="4" fill="${color}" opacity="0.06"/>
      <circle cx="16" cy="18" r="3.5" fill="${color}" opacity="0.06"/>
      <circle cx="26" cy="12" r="3" fill="${color}" opacity="0.06"/>
    </svg>`,

  // Minimal falling leaf (simpler for animation performance)
  fallingLeaf: (color, size) => `
    <svg width="${size}" height="${size * 1.3}" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 0C12 0 0 10 0 20c0 6.6 5.4 12 12 12s12-5.4 12-12C24 10 12 0 12 0z" fill="${color}" opacity="0.3"/>
      <path d="M12 2L12 28" stroke="${color}" stroke-width="0.5" opacity="0.35"/>
    </svg>`,
};


// --- Background Orbs ---
export function initBgOrbs(container) {
  const target = container || document.body;
  
  // Remove existing if re-initializing
  const existing = target.querySelector('.bg-layer');
  if (existing) existing.remove();

  const layer = document.createElement('div');
  layer.className = 'bg-layer';
  layer.innerHTML = `
    <div class="bg-orb bg-orb--1"></div>
    <div class="bg-orb bg-orb--2"></div>
    <div class="bg-orb bg-orb--3"></div>
  `;
  target.prepend(layer);
  return layer;
}


// --- Sparkles ---
export function initSparkles(container, count) {
  const target = container || document.body;
  const n = count || CONFIG.sparkles.count;
  
  const wrapper = document.createElement('div');
  wrapper.className = 'sparkle-layer';
  wrapper.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0;';

  for (let i = 0; i < n; i++) {
    const size = CONFIG.sparkles.minSize + Math.random() * (CONFIG.sparkles.maxSize - CONFIG.sparkles.minSize);
    const spark = document.createElement('div');
    spark.style.cssText = `
      position:absolute;
      left:${Math.random() * 100}%;
      top:${Math.random() * 100}%;
      width:${size}px;
      height:${size}px;
      background:var(--spark-color, #76ff03);
      border-radius:50%;
      box-shadow:0 0 ${size * 2}px var(--spark-color, #76ff03);
      animation:sparkle ${2 + Math.random() * 3}s ${Math.random() * 5}s infinite;
    `;
    wrapper.appendChild(spark);
  }

  target.style.position = target.style.position || 'relative';
  target.appendChild(wrapper);
  return wrapper;
}


// --- Falling Leaves ---
export function initFallingLeaves(container, count) {
  const target = container || document.body;
  const n = count || CONFIG.leaves.count;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--leaf-color').trim() || '#39ff14';

  const wrapper = document.createElement('div');
  wrapper.className = 'falling-leaves-layer';
  wrapper.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0;';

  for (let i = 0; i < n; i++) {
    const size = CONFIG.leaves.minSize + Math.random() * (CONFIG.leaves.maxSize - CONFIG.leaves.minSize);
    const dur = CONFIG.leaves.minDur + Math.random() * (CONFIG.leaves.maxDur - CONFIG.leaves.minDur);
    const delay = i * 3 + Math.random() * 2;
    
    const leaf = document.createElement('div');
    leaf.style.cssText = `
      position:absolute;
      left:${15 + Math.random() * 70}%;
      top:-30px;
      animation:leafDrift ${dur}s ${delay}s infinite linear;
      pointer-events:none;
    `;
    leaf.innerHTML = SVG.fallingLeaf(color, size);
    wrapper.appendChild(leaf);
  }

  target.style.position = target.style.position || 'relative';
  target.appendChild(wrapper);
  return wrapper;
}


// --- Botanical Decorations ---
export function initBotanicals(container) {
  const target = container || document.body;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--leaf-color').trim() || '#39ff14';

  const placements = [
    { svg: 'palmFrond', top: '10px', right: '-8px', left: 'auto', opacity: 0.5, anim: 'botanical--float1' },
    { svg: 'branch', bottom: '60px', left: '5px', top: 'auto', right: 'auto', opacity: 0.4, anim: 'botanical--float2', scaleX: -1 },
    { svg: 'leaf', top: '140px', left: '12px', right: 'auto', opacity: 0.5, anim: 'botanical--float3', w: 20, h: 26 },
  ];

  placements.forEach(p => {
    const el = document.createElement('div');
    el.className = `botanical ${p.anim}`;
    el.style.cssText = `
      position:absolute;
      top:${p.top || 'auto'};
      right:${p.right || 'auto'};
      bottom:${p.bottom || 'auto'};
      left:${p.left || 'auto'};
      opacity:${p.opacity};
      z-index:0;
      pointer-events:none;
      ${p.scaleX ? `transform:scaleX(${p.scaleX});` : ''}
    `;
    if (p.svg === 'leaf') {
      el.innerHTML = SVG.leaf(color, p.w, p.h);
    } else {
      el.innerHTML = SVG[p.svg](color);
    }
    target.appendChild(el);
  });
}


// --- Button Burst Effect ---
export function initButtonEffects(scope) {
  const target = scope || document;

  target.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn');
    if (!btn) return;

    // Press animation
    btn.style.animation = 'btnPress 0.2s ease';
    setTimeout(() => { btn.style.animation = ''; }, 200);

    // Spark burst
    const rect = btn.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    for (let i = 0; i < CONFIG.buttonBurstCount; i++) {
      const spark = document.createElement('span');
      const sx = (Math.random() - 0.5) * 60;
      const sy = (Math.random() - 0.5) * 60;
      spark.style.cssText = `
        position:absolute;
        left:${x}px;
        top:${y}px;
        width:4px;
        height:4px;
        border-radius:50%;
        background:#fff;
        box-shadow:0 0 6px var(--spark-color, #76ff03);
        --sx:${sx}px;
        --sy:${sy}px;
        animation:sparkBurst 0.5s ease-out forwards;
        pointer-events:none;
        z-index:10;
      `;
      btn.appendChild(spark);
      setTimeout(() => spark.remove(), 500);
    }
  });
}


// --- Input Focus Glow ---
export function initInputEffects(scope) {
  const target = scope || document;

  target.addEventListener('focusin', (e) => {
    if (e.target.matches('.input, input, select, textarea')) {
      e.target.style.borderColor = 'var(--primary)';
      e.target.style.boxShadow = 'var(--shadow-glow-sm)';
    }
  });

  target.addEventListener('focusout', (e) => {
    if (e.target.matches('.input, input, select, textarea')) {
      e.target.style.borderColor = '';
      e.target.style.boxShadow = '';
    }
  });
}


// --- Master Init ---
export function initEffects(options = {}) {
  const root = options.container || document.body;

  // Background orbs
  if (options.bgOrbs !== false) {
    initBgOrbs(root);
  }

  // Sparkles on the bg layer
  if (options.sparkles !== false) {
    const bgLayer = root.querySelector('.bg-layer');
    if (bgLayer) initSparkles(bgLayer, options.sparkleCount);
  }

  // Falling leaves
  if (options.fallingLeaves !== false) {
    const bgLayer = root.querySelector('.bg-layer');
    if (bgLayer) initFallingLeaves(bgLayer, options.leafCount);
  }

  // Button effects (event delegation on body)
  if (options.buttonEffects !== false) {
    initButtonEffects();
  }

  // Input focus glow
  if (options.inputEffects !== false) {
    initInputEffects();
  }

  console.log('🌿 Shorashim+ effects initialized');
}


// --- Utility: Add botanicals to a specific section ---
export function addBotanicalDecor(element, type, position) {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--leaf-color').trim() || '#39ff14';
  const el = document.createElement('div');
  el.className = 'botanical botanical--float1';
  el.style.cssText = `position:absolute;pointer-events:none;z-index:0;opacity:0.12;${position}`;
  el.innerHTML = SVG[type] ? SVG[type](color) : SVG.leaf(color);
  element.style.position = element.style.position || 'relative';
  element.style.overflow = 'hidden';
  element.appendChild(el);
}


// --- Utility: Add sparkles to a card ---
export function addCardSparkles(card, count = 3) {
  initSparkles(card, count);
}
