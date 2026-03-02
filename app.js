// MOT Factorial Load Model Experiment
// Vanilla JS PWA — optimised for iPhone Safari
// Targets always balls 0-2. Distractors 3-9 (sliced per trial).

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const CSS_PPI       = 460 / 3;
const INCH_PER_CM   = 0.3937;
const N_TARGETS     = 3;
const BALL_R        = 18;
const SPEED_REF     = 150;
const SPEED_MAX_PX  = SPEED_REF * 1.8;
const BOUMA_MAX     = 3.0;
const ALPHA         = 0.45;   // speed weight in load model
const BETA          = 0.55;   // crowding weight
const SAMPLE_HZ     = 12;     // time series sample rate
const MEMORISE_MS   = 2500;

// Colour palette
const C = {
  bg: '#060c10', dim: '#0c1a22', muted: '#2a4050',
  accent: '#00c9a7', warn: '#f0a060', danger: '#ff6b6b',
  flash: '#00ffcc', yellow: '#f0e060',
};

// Phase names
const PH = { SETUP:0, MEMORISE:1, TRACK:2, PROBE:3, BETWEEN:4, DONE:5 };

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  phase: PH.SETUP,
  distanceCm: 30,
  trials: [],          // shuffled trial list loaded from trials.csv
  trialIdx: 0,
  balls: [],           // current visible ball positions [{id,x,y}]
  selected: new Set(), // chosen ball ids during probe
  timeLeft: 0,
  liveLoad: 0,
  trialLog: [],        // completed trial results
  // per-trial accumulators
  timeSeries: [],
  nmActive: [],        // active near-miss windows
  nmDone: [],          // completed near-miss events
  flashEvents: [],
  playT: 0,            // current playback time in recording coords
};

// Recording was generated at this canvas size — all x,y are in this coordinate space
const REC_W = 393;
const REC_H = 340;

// ─── DOM refs ────────────────────────────────────────────────────────────────
let canvas, ctx, ballEls = [], fixCross, loadBar, loadLabel, timeLabel,
    trialLabel, memoriseLabel, probeLabel, confirmBtn,
    setupPanel, betweenPanel, donePanel,
    scoreHistory;

// ─── Animation ────────────────────────────────────────────────────────────────
let animId = null;
let lastTs = null;
let trialStartTs = null;
let flashTimer = null;
let lastSampleT = 0;

// ─── Math helpers ─────────────────────────────────────────────────────────────
const pxToDeg = (px, dcm) =>
  (180/Math.PI) * Math.atan((px / CSS_PPI / INCH_PER_CM) / dcm);

const eccDeg = (b, cx, cy, dcm) =>
  pxToDeg(Math.hypot(b.x - cx, b.y - cy), dcm);

const boumaRatio = (tgt, dst, cx, cy, dcm) => {
  const ecc = Math.max(eccDeg(tgt, cx, cy, dcm), 0.5);
  return pxToDeg(Math.hypot(tgt.x - dst.x, tgt.y - dst.y), dcm) / (ecc * 0.5);
};

const ambientBouma = (tgts, dsts, cx, cy, dcm) => {
  let min = Infinity;
  tgts.forEach(t => dsts.forEach(d => { min = Math.min(min, boumaRatio(t, d, cx, cy, dcm)); }));
  return min === Infinity ? 99 : min;
};

const computeLoad = (speedPx, amb) => {
  const sc = Math.min(speedPx / SPEED_MAX_PX, 1);
  const cp = Math.max(0, 1 - Math.min(amb, BOUMA_MAX) / BOUMA_MAX);
  return ALPHA * sc + BETA * cp;
};

const mean = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
const rand = (a,b) => a + Math.random()*(b-a);
const clamp = (v,lo,hi) => Math.max(lo, Math.min(hi, v));

// ─── Recording interpolation ──────────────────────────────────────────────────
function interpolate(frames, t) {
  if (!frames.length) return [];
  if (t <= frames[0].t) return frames[0].balls;
  if (t >= frames[frames.length-1].t) return frames[frames.length-1].balls;
  let lo = 0, hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= t) lo = mid; else hi = mid;
  }
  const f0 = frames[lo], f1 = frames[hi], a = (t - f0.t) / (f1.t - f0.t);
  return f0.balls.map((b,i) => ({
    id: b.id,
    x: b.x + (f1.balls[i].x - b.x) * a,
    y: b.y + (f1.balls[i].y - b.y) * a,
  }));
}

// ─── Load trials from CSV ─────────────────────────────────────────────────────
async function loadTrials() {
  const res = await fetch('trials.csv');
  const text = await res.text();
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  const trials = lines.slice(1).map(line => {
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, i) => obj[h.trim()] = vals[i]?.trim());
    return {
      trial_id:       parseInt(obj.trial_id),
      rec_name:       obj.rec_name,
      rec_idx:        parseInt(obj.rec_name.replace('rec_','')) - 1,
      speedMult:      parseFloat(obj.speed_mult),
      speedPx:        parseFloat(obj.speed_px),
      nDistractors:   parseInt(obj.n_distractors),
      nTotal:         parseInt(obj.n_total),
      recSpan:        parseFloat(obj.rec_span_s),
      playDuration:   parseFloat(obj.play_duration_s),
      hasBoumaEvents: obj.has_bouma_events === 'True',
    };
  });
  // Shuffle
  for (let i = trials.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [trials[i],trials[j]] = [trials[j],trials[i]];
  }
  return trials;
}

// ─── DOM builder ─────────────────────────────────────────────────────────────
function buildDOM() {
  document.body.style.cssText = `color:#d0e8f0;font-family:'Courier New',monospace;user-select:none;-webkit-user-select:none;`;

  const root = document.getElementById('app');
  root.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;';

  // Header
  const hdr = el('div', `padding:7px 14px;border-bottom:1px solid ${C.dim};display:flex;justify-content:space-between;align-items:center;flex-shrink:0;`);
  hdr.innerHTML = `<div style="font-size:11px;color:${C.accent};letter-spacing:4px;font-weight:bold">MOT</div>
    <div style="font-size:8px;color:${C.muted};letter-spacing:2px">FACTORIAL LOAD MODEL</div>
    <div id="trialLabel" style="font-size:8px;color:${C.muted}"></div>`;
  root.appendChild(hdr);
  trialLabel = document.getElementById('trialLabel');

  // Canvas area
  const canvasWrap = el('div', `position:relative;flex:1;min-height:0;background:#000;overflow:hidden;touch-action:none;`);
  root.appendChild(canvasWrap);

  // Fixation cross
  fixCross = el('div', `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:10;display:none;`);
  fixCross.innerHTML = `<div id="fcV" style="position:absolute;left:50%;top:0;width:2px;height:22px;background:#fff;transform:translateX(-50%);"></div>
    <div id="fcH" style="position:absolute;top:50%;left:0;height:2px;width:22px;background:#fff;transform:translateY(-50%);"></div>`;
  canvasWrap.appendChild(fixCross);

  memoriseLabel = el('div', `position:absolute;bottom:10px;left:0;right:0;text-align:center;font-size:10px;color:${C.accent};letter-spacing:2px;pointer-events:none;display:none;`);
  memoriseLabel.textContent = 'MEMORISE TARGETS';
  canvasWrap.appendChild(memoriseLabel);

  probeLabel = el('div', `position:absolute;bottom:10px;left:0;right:0;text-align:center;font-size:10px;color:${C.accent};letter-spacing:2px;pointer-events:none;display:none;`);
  canvasWrap.appendChild(probeLabel);

  timeLabel = el('div', `position:absolute;top:7px;right:10px;font-size:12px;color:${C.accent};display:none;`);
  canvasWrap.appendChild(timeLabel);

  // Ball container (divs, not canvas — cleaner on iOS)
  canvas = canvasWrap; // canvas is really the wrap div

  // Load bar
  const loadRow = el('div', `padding:4px 14px;flex-shrink:0;border-bottom:1px solid ${C.dim};display:none;`, 'loadRow');
  loadRow.innerHTML = `<div style="display:flex;justify-content:space-between;margin-bottom:2px;">
    <div style="font-size:8px;color:${C.muted}">LOAD · α=${ALPHA}·spd + β=${BETA}·crowd</div>
    <div id="loadLabel" style="font-size:8px;color:${C.accent}">L0</div>
  </div>
  <div style="background:#0a1018;border-radius:2px;height:4px;">
    <div id="loadBar" style="width:0%;height:100%;background:${C.accent};border-radius:2px;transition:width 0.1s;"></div>
  </div>`;
  root.appendChild(loadRow);
  loadBar = document.getElementById('loadBar');
  loadLabel = document.getElementById('loadLabel');

  // Confirm button
  confirmBtn = el('div', `padding:8px 14px;flex-shrink:0;display:none;`, 'confirmWrap');
  confirmBtn.innerHTML = `<button id="confirmBtn" style="width:100%;background:transparent;border:1px solid ${C.accent};color:${C.accent};padding:10px 0;font-size:10px;letter-spacing:3px;cursor:pointer;font-family:'Courier New',monospace;border-radius:3px;">CONFIRM</button>`;
  root.appendChild(confirmBtn);
  document.getElementById('confirmBtn').addEventListener('click', submitProbe);

  // Score history strip
  scoreHistory = el('div', `padding:3px 14px;flex-shrink:0;display:flex;gap:3px;flex-wrap:wrap;display:none;`, 'scoreHistory');
  root.appendChild(scoreHistory);

  // Setup panel
  setupPanel = el('div', `flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px;`, 'setupPanel');
  setupPanel.innerHTML = `
    <div style="font-size:9px;color:${C.accent};letter-spacing:3px;">EXPERIMENT</div>
    <div style="background:${C.dim};border-radius:3px;padding:9px 11px;font-size:9px;color:#3a5a40;line-height:1.9;">
      20 pre-defined trials · 8s each · randomised order<br>
      3 speeds: 0.5× / 1.0× / 1.8× of 150px/s reference<br>
      Distractors: 2 / 4 / 6 extra → 5 / 7 / 9 total balls<br>
      Targets always balls 0–2 (teal). No re-memorisation.<br>
      <span style="color:${C.accent}">Fixation cross flashes — just keep watching it.</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="font-size:9px;color:${C.muted};min-width:80px;">DISTANCE</div>
      <input id="distInput" type="number" value="30" min="15" max="60"
        style="background:${C.dim};border:1px solid ${C.muted};color:#d0e8f0;padding:4px 8px;font-size:12px;width:55px;font-family:'Courier New',monospace;border-radius:3px;">
      <span style="font-size:10px;color:${C.muted};">cm</span>
    </div>
    <button id="beginBtn" style="width:100%;background:transparent;border:2px solid ${C.accent};color:${C.accent};padding:12px 0;font-size:13px;letter-spacing:4px;cursor:pointer;font-family:'Courier New',monospace;border-radius:4px;">
      BEGIN SESSION
    </button>
    <div id="prevResults" style="display:none;background:${C.dim};border-radius:3px;padding:8px 10px;font-size:9px;color:${C.muted};">
      Previous session data present — beginning new session will start fresh.
    </div>`;
  root.appendChild(setupPanel);
  document.getElementById('beginBtn').addEventListener('click', beginSession);

  // Between panel
  betweenPanel = el('div', `flex:1;overflow-y:auto;padding:10px 14px;display:flex;flex-direction:column;gap:9px;display:none;`, 'betweenPanel');
  root.appendChild(betweenPanel);

  // Done panel
  donePanel = el('div', `flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px;display:none;`, 'donePanel');
  root.appendChild(donePanel);
}

// ─── Session begin ────────────────────────────────────────────────────────────
async function beginSession() {
  state.distanceCm = parseInt(document.getElementById('distInput').value) || 30;
  if (!state.trials.length) {
    state.trials = await loadTrials();
  }
  state.trialIdx = 0;
  state.trialLog = [];
  setPhase(PH.MEMORISE);
  launchTrial();
}

// ─── Trial launch ─────────────────────────────────────────────────────────────
function launchTrial() {
  const trial = currentTrial();
  const rec = RECORDINGS[trial.rec_idx];
  state.playT = 0;
  state.timeSeries = [];
  state.nmActive = [];
  state.nmDone = [];
  state.flashEvents = [];
  state.selected = new Set();
  lastSampleT = 0;

  // Show initial positions
  const initPos = interpolate(rec.frames, 0).slice(0, trial.nTotal);
  renderBalls(initPos, PH.MEMORISE);
  updateTrialLabel();
  setPhase(PH.MEMORISE);

  setTimeout(() => {
    lastTs = null;
    trialStartTs = performance.now();
    scheduleFlash(trial);
    setPhase(PH.TRACK);
    animId = requestAnimationFrame(trackFrame);
  }, MEMORISE_MS);
}

// ─── Track frame ──────────────────────────────────────────────────────────────
function trackFrame(ts) {
  const trial = currentTrial();
  const rec = RECORDINGS[trial.rec_idx];
  // Physics/Bouma math always in recording coordinate space
  const cx = REC_W / 2, cy = REC_H / 2;
  const { w, h } = getDims();
  const wallDt = lastTs ? Math.min((ts - lastTs) / 1000, 0.05) : 0.016;
  lastTs = ts;
  const wallEl = (ts - trialStartTs) / 1000;
  const rem = trial.playDuration - wallEl;
  state.timeLeft = Math.max(0, rem);
  updateTimeLabel();

  if (rem <= 0) {
    cancelAnimationFrame(animId);
    clearTimeout(flashTimer);
    setPhase(PH.PROBE);
    return;
  }

  // Advance playback
  state.playT = Math.min(state.playT + wallDt * trial.speedMult, trial.recSpan);
  const allPos = interpolate(rec.frames, state.playT);
  const vis = allPos.slice(0, trial.nTotal);
  const tgts = vis.filter(b => b.id < N_TARGETS);
  const dsts = vis.filter(b => b.id >= N_TARGETS);

  // Time series sample
  if (wallEl - lastSampleT >= 1 / SAMPLE_HZ) {
    lastSampleT = wallEl;
    const dcm = state.distanceCm;
    const amb = ambientBouma(tgts, dsts, cx, cy, dcm);
    const sc = Math.min(trial.speedPx / SPEED_MAX_PX, 1);
    const cp = Math.max(0, 1 - Math.min(amb, BOUMA_MAX) / BOUMA_MAX);
    const load = ALPHA * sc + BETA * cp;
    state.timeSeries.push({ t: wallEl, ambientBouma: amb, load, speedComp: sc, crowdPress: cp });
    updateLoadBar(load);
  }

  // Near-miss tracking
  const dcm = state.distanceCm;
  tgts.forEach(tgt => dsts.forEach(dst => {
    const key = `${tgt.id}-${dst.id}`;
    const br = boumaRatio(tgt, dst, cx, cy, dcm);
    const ex = state.nmActive.find(e => e.key === key);
    if (br < 1.5) {
      if (!ex) state.nmActive.push({ key, tgtId: tgt.id, dstId: dst.id, minBouma: br, minT: wallEl, tStart: wallEl });
      else if (br < ex.minBouma) { ex.minBouma = br; ex.minT = wallEl; }
    } else if (ex) {
      state.nmDone.push({ ...ex, tEnd: wallEl });
      state.nmActive = state.nmActive.filter(e => e.key !== key);
    }
  }));

  renderBalls(vis, PH.TRACK);
  animId = requestAnimationFrame(trackFrame);
}

// ─── Flash fixation cross ─────────────────────────────────────────────────────
function scheduleFlash(trial) {
  const delay = rand(2000, (trial.playDuration - 2) * 1000);
  flashTimer = setTimeout(() => {
    showFlash(true);
    state.flashEvents.push((performance.now() - trialStartTs) / 1000);
    setTimeout(() => {
      showFlash(false);
      const el = (performance.now() - trialStartTs) / 1000;
      if (el < trial.playDuration - 2.5) scheduleFlash(trial);
    }, 380);
  }, delay);
}

function showFlash(on) {
  const fcV = document.getElementById('fcV');
  const fcH = document.getElementById('fcH');
  if (!fcV) return;
  if (on) {
    fixCross.style.display = 'block';
    fcV.style.cssText = `position:absolute;left:50%;top:0;width:3px;height:28px;background:${C.flash};transform:translateX(-50%);`;
    fcH.style.cssText = `position:absolute;top:50%;left:0;height:3px;width:28px;background:${C.flash};transform:translateY(-50%);`;
  } else {
    fcV.style.cssText = `position:absolute;left:50%;top:0;width:2px;height:22px;background:#fff;transform:translateX(-50%);`;
    fcH.style.cssText = `position:absolute;top:50%;left:0;height:2px;width:22px;background:#fff;transform:translateY(-50%);`;
  }
}

// ─── Submit probe ─────────────────────────────────────────────────────────────
function submitProbe() {
  const trial = currentTrial();
  // Finalise active near-misses
  state.nmActive.forEach(ev => state.nmDone.push({ ...ev, tEnd: trial.playDuration }));
  state.nmActive = [];

  const trueTargets = new Set([0, 1, 2]);
  const missed = new Set([...trueTargets].filter(id => !state.selected.has(id)));
  const fa = new Set([...state.selected].filter(id => !trueTargets.has(id)));
  const score = (N_TARGETS - missed.size) / N_TARGETS;

  const scored = state.nmDone.map(ev => ({
    ...ev,
    outcome: !missed.has(ev.tgtId) ? 'survived' : fa.has(ev.dstId) ? 'swap' : 'miss_event',
  }));
  const tgtsWithEv = new Set(state.nmDone.map(e => e.tgtId));
  const missNone = [...missed].filter(id => !tgtsWithEv.has(id)).map(id => ({
    tgtId: id, dstId: null, outcome: 'miss_none', minBouma: null, minT: null,
  }));

  const ts = state.timeSeries;
  const result = {
    ...trial,
    score, missed: missed.size,
    nearMisses: [...scored, ...missNone],
    timeSeries: ts,
    flashEvents: state.flashEvents,
    meanLoad: mean(ts.map(f => f.load)),
    peakLoad: ts.length ? Math.max(...ts.map(f => f.load)) : 0,
    meanAmbBouma: mean(ts.map(f => f.ambientBouma)),
    pctBelowCrit: ts.length ? ts.filter(f => f.ambientBouma < 1).length / ts.length : 0,
  };
  state.trialLog.push(result);
  showBetween(result);
}

// ─── Between-trial screen ─────────────────────────────────────────────────────
function showBetween(result) {
  setPhase(PH.BETWEEN);
  const trial = currentTrial();
  const isLast = state.trialIdx + 1 >= state.trials.length;
  const nm = result.nearMisses.filter(e => e.outcome !== 'miss_none');
  const mn = result.nearMisses.filter(e => e.outcome === 'miss_none');

  const nextLabel = isLast
    ? 'SESSION COMPLETE → EXPORT'
    : `NEXT → ${state.trialIdx + 2}/${state.trials.length}`;

  betweenPanel.innerHTML = `
    <div style="font-size:9px;color:${C.accent};letter-spacing:3px;">TRIAL ${state.trialIdx+1} / ${state.trials.length}</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px;">
      ${statCard('SCORE', pct(result.score))}
      ${statCard('NM EVENTS', nm.length)}
      ${statCard('SPONTANEOUS', mn.length)}
    </div>
    <div style="background:${C.dim};border-radius:3px;padding:7px 10px;font-size:9px;color:${C.muted};line-height:1.8;">
      ${trial.rec_name} · ${trial.speedMult}× · ${trial.nDistractors} distractors<br>
      L̄=${result.meanLoad.toFixed(2)} · peak=${result.peakLoad.toFixed(2)} · ${pct(result.pctBelowCrit)} below crit
    </div>
    ${nm.length ? `
    <div style="background:${C.dim};border-radius:3px;padding:7px 10px;">
      <div style="font-size:7px;color:${C.muted};letter-spacing:2px;margin-bottom:5px;">NEAR-MISS EVENTS</div>
      ${nm.map(e=>`<div style="display:flex;gap:10px;font-size:8px;margin-bottom:2px;">
        <span style="color:${outcomeCol(e.outcome)}">${e.outcome.toUpperCase().replace('_',' ')}</span>
        <span style="color:${C.muted}">t${e.tgtId}↔d${e.dstId}</span>
        <span style="color:${e.minBouma<1?C.danger:C.accent}">BR=${e.minBouma?.toFixed(2)??'—'}</span>
      </div>`).join('')}
    </div>` : ''}
    <div style="display:flex;gap:3px;flex-wrap:wrap;">
      ${state.trialLog.slice(-14).map(t=>`<div style="font-size:7px;color:${t.score===1?C.accent:t.score===0?C.danger:C.warn};background:${C.dim};padding:2px 5px;border-radius:2px;">${pct(t.score)}</div>`).join('')}
    </div>
    <button onclick="nextTrial()" style="width:100%;background:transparent;border:1px solid ${C.accent};color:${C.accent};padding:10px 0;font-size:10px;letter-spacing:3px;cursor:pointer;font-family:'Courier New',monospace;border-radius:3px;">
      ${nextLabel}
    </button>`;
  betweenPanel.style.display = 'flex';
}

function nextTrial() {
  state.trialIdx++;
  if (state.trialIdx >= state.trials.length) {
    showDone();
  } else {
    launchTrial();
  }
}

// ─── Session done ─────────────────────────────────────────────────────────────
function showDone() {
  setPhase(PH.DONE);
  const log = state.trialLog;
  const avgScore = mean(log.map(t => t.score));
  const allNM = log.flatMap(t => t.nearMisses.filter(e => e.outcome !== 'miss_none' && e.minBouma != null));
  const swaps = allNM.filter(e => e.outcome === 'swap');
  const missEv = allNM.filter(e => e.outcome === 'miss_event');
  const surv = allNM.filter(e => e.outcome === 'survived');

  donePanel.innerHTML = `
    <div style="font-size:9px;color:${C.accent};letter-spacing:3px;">SESSION COMPLETE</div>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:5px;">
      ${statCard('MEAN SCORE', pct(avgScore))}
      ${statCard('TRIALS', log.length)}
      ${statCard('SWAPS', swaps.length)}
      ${statCard('SURVIVED', surv.length)}
    </div>
    <div style="background:${C.dim};border-radius:3px;padding:9px 11px;font-size:9px;color:#3a6050;line-height:1.9;">
      Export CSVs and feed into analysis.<br>
      Three files: trials · events · timeseries
    </div>
    <button onclick="exportAll()" style="width:100%;background:#001020;border:1px solid #2a4060;color:#4a8fa8;padding:10px 0;font-size:10px;letter-spacing:3px;cursor:pointer;font-family:'Courier New',monospace;border-radius:3px;">
      EXPORT ALL CSV
    </button>
    <button onclick="resetSession()" style="width:100%;background:transparent;border:1px solid ${C.muted};color:${C.muted};padding:8px 0;font-size:9px;letter-spacing:3px;cursor:pointer;font-family:'Courier New',monospace;border-radius:3px;">
      NEW SESSION
    </button>`;
}

function resetSession() {
  state.trialLog = [];
  state.trialIdx = 0;
  setPhase(PH.SETUP);
}

// ─── Phase transitions ────────────────────────────────────────────────────────
function setPhase(ph) {
  state.phase = ph;

  // Hide everything
  setupPanel.style.display = 'none';
  betweenPanel.style.display = 'none';
  donePanel.style.display = 'none';
  confirmBtn.style.display = 'none';
  document.getElementById('loadRow').style.display = 'none';
  memoriseLabel.style.display = 'none';
  probeLabel.style.display = 'none';
  timeLabel.style.display = 'none';
  fixCross.style.display = 'none';

  if (ph === PH.SETUP) {
    setupPanel.style.display = 'flex';
    clearBalls();
  }
  if (ph === PH.MEMORISE) {
    fixCross.style.display = 'block';
    showFlash(false);
    memoriseLabel.style.display = 'block';
  }
  if (ph === PH.TRACK) {
    fixCross.style.display = 'block';
    showFlash(false);
    timeLabel.style.display = 'block';
    document.getElementById('loadRow').style.display = 'block';
  }
  if (ph === PH.PROBE) {
    probeLabel.style.display = 'block';
    updateProbeLabel();
    fixCross.style.display = 'block';
    // Re-render balls as tappable — this is what actually enables selection
    renderBalls(state.balls, PH.PROBE);
  }
  if (ph === PH.BETWEEN) {
    clearBalls();
    betweenPanel.style.display = 'flex';
    // update score history strip
  }
  if (ph === PH.DONE) {
    clearBalls();
    donePanel.style.display = 'flex';
  }
}

// ─── Ball rendering ───────────────────────────────────────────────────────────
function clearBalls() {
  ballEls.forEach(el => el.remove());
  ballEls = [];
}

function renderBalls(balls, phase) {
  // Create missing elements
  while (ballEls.length < balls.length) {
    const div = document.createElement('div');
    div.style.cssText = `position:absolute;border-radius:50%;pointer-events:none;transition:border-color 0.1s,box-shadow 0.1s;`;
    canvas.appendChild(div);
    ballEls.push(div);
    if (phase === PH.PROBE) {
      div.style.pointerEvents = 'auto';
      div.style.cursor = 'pointer';
    }
  }
  // Remove extra
  while (ballEls.length > balls.length) {
    ballEls.pop().remove();
  }

  balls.forEach((b, i) => {
    const div = ballEls[i];
    const sb = scalePos(b);   // recording coords → canvas coords
    const isTarget = b.id < N_TARGETS;
    const isSelected = state.selected.has(b.id);
    const isProbe = phase === PH.PROBE;
    const isMemorising = phase === PH.MEMORISE;
    const { sx } = getDims();
    const r = Math.max(12, Math.round(BALL_R * sx)); // scale ball radius too

    div.style.left = `${sb.x - r}px`;
    div.style.top  = `${sb.y - r}px`;
    div.style.width  = `${r*2}px`;
    div.style.height = `${r*2}px`;
    div.style.background = isTarget && isMemorising ? '#001a12' : '#060e14';
    div.style.border = isTarget && isMemorising
      ? `2.5px solid ${C.accent}`
      : isProbe
        ? `2px solid ${isSelected ? C.accent : '#2a3a48'}`
        : '1.5px solid #1a2a38';
    div.style.boxShadow = (isTarget && isMemorising) || isSelected
      ? `0 0 10px 2px #00c9a750` : 'none';

    div._ballId = b.id;
    if (isProbe) {
      div.style.pointerEvents = 'auto';
      div.style.cursor = 'pointer';
      div.onclick = null;
      div.ontouchstart = (e) => { e.preventDefault(); e.stopPropagation(); toggleSelect(b.id); };
    } else {
      div.style.pointerEvents = 'none';
      div.style.cursor = 'default';
      div.ontouchstart = div.onclick = null;
    }
  });

  state.balls = balls;
}

function toggleSelect(id) {
  if (state.phase !== PH.PROBE) return;
  if (state.selected.has(id)) {
    state.selected.delete(id);
  } else if (state.selected.size < N_TARGETS) {
    state.selected.add(id);
  }
  // Re-render probe state
  renderBalls(state.balls, PH.PROBE);
  updateProbeLabel();
  // Show confirm if enough selected
  confirmBtn.style.display = state.selected.size === N_TARGETS ? 'block' : 'none';
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function getDims() {
  const w = canvas.clientWidth || REC_W;
  const h = canvas.clientHeight || REC_H;
  // Scale factors from recording space to actual canvas
  const sx = w / REC_W;
  const sy = h / REC_H;
  return { w, h, cx: w/2, cy: h/2, sx, sy };
}

// Scale a recording-space position to canvas space
function scalePos(b) {
  const { sx, sy } = getDims();
  return { ...b, x: b.x * sx, y: b.y * sy };
}

function el(tag, css, id='') {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (id) e.id = id;
  return e;
}

function currentTrial() { return state.trials[state.trialIdx]; }

function updateTrialLabel() {
  const t = currentTrial();
  if (!t) return;
  trialLabel.textContent = `${state.trialIdx+1}/${state.trials.length} · ${t.speedMult}× · ${t.nDistractors}d`;
}

function updateTimeLabel() {
  timeLabel.textContent = state.timeLeft.toFixed(1) + 's';
  timeLabel.style.color = state.timeLeft < 2 ? C.danger : C.accent;
}

function updateLoadBar(load) {
  state.liveLoad = load;
  const pct = (load * 100).toFixed(0);
  const col = load > 0.75 ? C.danger : load > 0.5 ? C.warn : load > 0.25 ? C.yellow : C.accent;
  loadBar.style.width = pct + '%';
  loadBar.style.background = col;
  loadLabel.textContent = 'L' + pct;
  loadLabel.style.color = col;
}

function updateProbeLabel() {
  const rem = N_TARGETS - state.selected.size;
  probeLabel.textContent = `SELECT ${rem} TARGET${rem !== 1 ? 'S' : ''}`;
}

function statCard(label, value) {
  return `<div style="background:${C.dim};border-radius:3px;padding:8px 5px;text-align:center;">
    <div style="font-size:16px;color:${C.accent};font-weight:bold;">${value}</div>
    <div style="font-size:7px;color:${C.muted};">${label}</div>
  </div>`;
}

function pct(v) { return (v * 100).toFixed(0) + '%'; }
function outcomeCol(o) { return o==='swap'?C.danger:o==='miss_event'?C.warn:o==='miss_none'?'#9060f0':C.accent; }

// ─── CSV Export ───────────────────────────────────────────────────────────────
function dlCSV(content, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/csv' }));
  a.download = name;
  a.click();
}

function exportAll() {
  const log = state.trialLog;

  // Trials
  const tH = 'trial_id,rec_name,speed_mult,speed_px,n_distractors,n_total,score,missed,mean_load,peak_load,mean_amb_bouma,pct_below_crit,play_duration\n';
  const tR = log.map(t => [
    t.trial_id, t.rec_name, t.speedMult, t.speedPx, t.nDistractors, t.nTotal,
    t.score.toFixed(3), t.missed, t.meanLoad.toFixed(3), t.peakLoad.toFixed(3),
    t.meanAmbBouma.toFixed(3), t.pctBelowCrit.toFixed(3), t.playDuration.toFixed(1),
  ].join(',')).join('\n');
  dlCSV(tH + tR, 'mot_trials.csv');

  // Events
  const eH = 'trial_id,rec_name,speed_mult,n_distractors,outcome,tgt_id,dst_id,min_bouma,min_t,t_start,t_end\n';
  const eR = log.flatMap(t => t.nearMisses.map(e => [
    t.trial_id, t.rec_name, t.speedMult, t.nDistractors,
    e.outcome, e.tgtId ?? '', e.dstId ?? '',
    e.minBouma?.toFixed(3) ?? '', e.minT?.toFixed(2) ?? '',
    e.tStart?.toFixed(2) ?? '', e.tEnd?.toFixed(2) ?? '',
  ].join(','))).join('\n');
  dlCSV(eH + eR, 'mot_events.csv');

  // Time series
  const tsH = 'trial_id,rec_name,speed_mult,n_distractors,t,ambient_bouma,load,speed_comp,crowd_press\n';
  const tsR = log.flatMap(t => (t.timeSeries || []).map(f => [
    t.trial_id, t.rec_name, t.speedMult, t.nDistractors,
    f.t.toFixed(2), f.ambientBouma.toFixed(3), f.load.toFixed(3),
    f.speedComp.toFixed(3), f.crowdPress.toFixed(3),
  ].join(','))).join('\n');
  dlCSV(tsH + tsR, 'mot_timeseries.csv');
}

// Expose globally for onclick handlers
window.nextTrial = nextTrial;
window.exportAll = exportAll;
window.resetSession = resetSession;

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  buildDOM();
  // Pre-load trials CSV silently
  try {
    state.trials = await loadTrials();
    document.getElementById('beginBtn').textContent =
      `BEGIN SESSION (${state.trials.length} TRIALS)`;
  } catch(e) {
    console.warn('Could not pre-load trials.csv', e);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', boot);
