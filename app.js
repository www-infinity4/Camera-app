/**
 * Camera App – app.js
 *
 * Modes:
 *   normal      – passthrough (no effect)
 *   nightvision – green-amplified night-vision simulation
 *   infrared    – thermal heat-map (luminance → colour spectrum)
 *   radiation   – yellow-green tint with animated radiation meter
 *   ghost       – blue-purple tint with animated EMF detector
 */

'use strict';

/* ─── DOM refs ─────────────────────────────────────────────────── */
const video       = document.getElementById('video');
const canvas      = document.getElementById('canvas');
const ctx         = canvas.getContext('2d', { willReadFrequently: true });
const modeButtons = document.querySelectorAll('.mode-btn');
const captureBtn  = document.getElementById('capture-btn');
const retryBtn    = document.getElementById('retry-btn');
const cameraError = document.getElementById('camera-error');

/* ─── HUD elements ─────────────────────────────────────────────── */
const huds = {
  nightvision : document.getElementById('hud-nightvision'),
  infrared    : document.getElementById('hud-infrared'),
  radiation   : document.getElementById('hud-radiation'),
  ghost       : document.getElementById('hud-ghost'),
};

/* ─── Radiation meter ──────────────────────────────────────────── */
const radBar   = document.getElementById('rad-bar');
const radValue = document.getElementById('rad-value');

/* ─── EMF bars ─────────────────────────────────────────────────── */
const emfBars   = [1, 2, 3, 4, 5].map(n => document.getElementById(`emf-b${n}`));
const emfStatus = document.getElementById('emf-status');

/* ─── State ────────────────────────────────────────────────────── */
let currentMode    = 'normal';
let animFrameId    = null;
let stream         = null;

/* Radiation state */
let radTarget  = 0.12;
let radCurrent = 0.12;

/* EMF state */
let emfLevel   = 0;   // 0-5
let emfTarget  = 0;

/* ─── Filter coefficients ───────────────────────────────────────── */
const NV = {
  LUM_BOOST   : 1.8,   // brightness amplification
  GREEN_GAIN  : 1.1,   // extra green channel gain
  BLUE_TRACE  : 0.05,  // faint blue residual
};

const RAD = {
  R_MIX_R: 0.8,  R_MIX_G: 0.4,
  G_MIX_R: 0.3,  G_MIX_G: 1.1, G_MIX_B: 0.1,
  B_SCALE : 0.15,
};

const GHOST = {
  R_MIX_R: 0.35, R_MIX_B: 0.25,
  G_SCALE : 0.25,
  B_MIX_R: 0.20, B_MIX_B: 1.1, B_OFFSET: 40,
  NOISE_CHANCE: 0.015,
  NOISE_RANGE : 80,
};

/* ─── Thermal colour palette (256 entries) ─────────────────────── */
const thermalPalette = buildThermalPalette();

function buildThermalPalette() {
  // Maps luminance 0-255 → [r, g, b]
  // Colour ramp: black → dark-blue → cyan → green → yellow → orange → red → white
  const stops = [
    [0,   [0,   0,   0  ]],
    [32,  [0,   0,   128]],
    [80,  [0,   0,   255]],
    [110, [0,   255, 255]],
    [140, [0,   255, 0  ]],
    [170, [255, 255, 0  ]],
    [200, [255, 128, 0  ]],
    [230, [255, 0,   0  ]],
    [255, [255, 255, 255]],
  ];

  const palette = new Uint8Array(256 * 3);
  for (let i = 0; i < stops.length - 1; i++) {
    const [v0, c0] = stops[i];
    const [v1, c1] = stops[i + 1];
    for (let v = v0; v <= v1; v++) {
      const t = (v - v0) / (v1 - v0);
      palette[v * 3 + 0] = Math.round(c0[0] + t * (c1[0] - c0[0]));
      palette[v * 3 + 1] = Math.round(c0[1] + t * (c1[1] - c0[1]));
      palette[v * 3 + 2] = Math.round(c0[2] + t * (c1[2] - c0[2]));
    }
  }
  return palette;
}

/* ─── Camera initialisation ────────────────────────────────────── */
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    cameraError.hidden = true;
    scheduleFrame();
  } catch (err) {
    console.error('Camera error:', err);
    cameraError.hidden = false;
  }
}

/* ─── Render loop ──────────────────────────────────────────────── */
function scheduleFrame() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  animFrameId = requestAnimationFrame(renderFrame);
}

function renderFrame() {
  if (!stream || video.readyState < video.HAVE_ENOUGH_DATA) {
    animFrameId = requestAnimationFrame(renderFrame);
    return;
  }

  // Match canvas to video dimensions
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 480;
  }

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  if (currentMode !== 'normal') {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyFilter(imageData, currentMode);
    ctx.putImageData(imageData, 0, 0);
  }

  animFrameId = requestAnimationFrame(renderFrame);
}

/* ─── Filter dispatcher ────────────────────────────────────────── */
function applyFilter(imageData, mode) {
  switch (mode) {
    case 'nightvision': filterNightVision(imageData); break;
    case 'infrared':    filterInfrared(imageData);    break;
    case 'radiation':   filterRadiation(imageData);   break;
    case 'ghost':       filterGhost(imageData);       break;
  }
}

/* ─── Night Vision filter ──────────────────────────────────────── */
function filterNightVision(imageData) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    // Perceived luminance
    const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    // Boost brightness and push into green channel
    const boosted = Math.min(255, lum * NV.LUM_BOOST);
    data[i]     = 0;                                           // R – off
    data[i + 1] = Math.min(255, boosted * NV.GREEN_GAIN);     // G – amplified
    data[i + 2] = Math.round(boosted * NV.BLUE_TRACE);        // B – slight trace
    // data[i + 3] unchanged (alpha)
  }
}

/* ─── Infrared / Thermal filter ────────────────────────────────── */
function filterInfrared(imageData) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    const p   = lum * 3;
    data[i]     = thermalPalette[p];
    data[i + 1] = thermalPalette[p + 1];
    data[i + 2] = thermalPalette[p + 2];
  }
}

/* ─── Radiation filter ─────────────────────────────────────────── */
function filterRadiation(imageData) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Yellow-green tint: boost R+G, suppress B
    data[i]     = Math.min(255, r * RAD.R_MIX_R + g * RAD.R_MIX_G);
    data[i + 1] = Math.min(255, r * RAD.G_MIX_R + g * RAD.G_MIX_G + b * RAD.G_MIX_B);
    data[i + 2] = Math.round(b * RAD.B_SCALE);
  }
}

/* ─── Ghost / EMF filter ───────────────────────────────────────── */
function filterGhost(imageData) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Blue-purple tint
    data[i]     = Math.round(r * GHOST.R_MIX_R + b * GHOST.R_MIX_B);
    data[i + 1] = Math.round(g * GHOST.G_SCALE);
    data[i + 2] = Math.min(255, r * GHOST.B_MIX_R + b * GHOST.B_MIX_B + GHOST.B_OFFSET);
    // Add faint random noise for "static" feel
    if (Math.random() < GHOST.NOISE_CHANCE) {
      const noise = Math.random() * GHOST.NOISE_RANGE - GHOST.NOISE_RANGE / 2;
      data[i]     = clamp(data[i]     + noise);
      data[i + 1] = clamp(data[i + 1] + noise);
      data[i + 2] = clamp(data[i + 2] + noise);
    }
  }
}

function clamp(v) { return Math.max(0, Math.min(255, Math.round(v))); }

/* ─── HUD management ───────────────────────────────────────────── */
function showHud(mode) {
  Object.values(huds).forEach(h => { h.style.display = 'none'; });
  if (huds[mode]) huds[mode].style.display = 'block';
}

/* ─── Radiation meter animation ────────────────────────────────── */
function tickRadiation() {
  // Wander the target value
  radTarget += (Math.random() - 0.5) * 0.08;
  radTarget  = Math.max(0.01, Math.min(4.5, radTarget));
  radCurrent += (radTarget - radCurrent) * 0.12;

  const pct = Math.min(100, (radCurrent / 4.5) * 100);
  radBar.style.width = pct + '%';

  // Change colour at high levels
  if (pct > 70) {
    radBar.style.background = 'linear-gradient(to right, #ffaa00, #ff4400)';
  } else {
    radBar.style.background = 'linear-gradient(to right, #6aff00, #c8ff00, #ffff00)';
  }

  radValue.textContent = radCurrent.toFixed(2);
}

/* ─── EMF bar animation ─────────────────────────────────────────── */
const EMF_STATUSES = ['SCANNING…', 'NO SIGNAL', 'WEAK SIGNAL', 'EMF DETECTED', 'ENTITY NEAR', '⚠ ALERT'];

function tickEMF() {
  // Occasionally spike
  if (Math.random() < 0.06) {
    emfTarget = Math.floor(Math.random() * 6); // 0-5
  } else if (Math.random() < 0.15) {
    emfTarget = Math.max(0, emfTarget - 1);
  }

  // Drift current level toward target
  if (Math.random() < 0.3) {
    if (emfLevel < emfTarget) emfLevel++;
    else if (emfLevel > emfTarget) emfLevel--;
  }

  emfBars.forEach((bar, idx) => {
    // Bar is active if its index < emfLevel
    bar.className = 'emf-bar' + (idx < emfLevel ? ` lvl${idx + 1}` : '');
  });

  emfStatus.textContent = EMF_STATUSES[Math.min(emfLevel, EMF_STATUSES.length - 1)];
  if (emfLevel >= 4) {
    emfStatus.style.color = '#ff44ff';
  } else {
    emfStatus.style.color = '#bf80ff';
  }
}

/* ─── Per-mode interval tickers ────────────────────────────────── */
let hudTickInterval = null;

function startHudTick(mode) {
  clearInterval(hudTickInterval);
  if (mode === 'radiation') {
    hudTickInterval = setInterval(tickRadiation, 250);
  } else if (mode === 'ghost') {
    hudTickInterval = setInterval(tickEMF, 180);
  }
}

/* ─── Mode switching ────────────────────────────────────────────── */
function setMode(mode) {
  currentMode = mode;
  showHud(mode);
  startHudTick(mode);

  modeButtons.forEach(btn => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

modeButtons.forEach(btn => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

/* ─── Capture / photo ───────────────────────────────────────────── */
captureBtn.addEventListener('click', () => {
  // Flash effect
  const flash = document.createElement('div');
  flash.className = 'capture-flash';
  document.body.appendChild(flash);
  flash.addEventListener('animationend', () => flash.remove());

  // Download current frame as PNG
  canvas.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href    = url;
    a.download = `capture-${currentMode}-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
});

/* ─── Retry button ──────────────────────────────────────────────── */
retryBtn.addEventListener('click', () => {
  cameraError.hidden = true;
  startCamera();
});

/* ─── Boot ──────────────────────────────────────────────────────── */
startCamera();
