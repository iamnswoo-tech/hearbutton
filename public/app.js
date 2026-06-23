/* ════════════════════════════════════════════════════
   HearCheck — AI 청력 보조 검사 앱 (오프라인 분석 버전)
   audiometry-new + DNN-HA + Web Audio API
   API 연동 없이 analysis-engine.js로 분석 수행
   ════════════════════════════════════════════════════ */

// ── Constants ────────────────────────────────────────
const FREQS       = [125, 250, 500, 1000, 2000, 3000, 4000, 6000, 8000];
const CORRECTION  = [19.7, 9.0, 2.0, 0, -3.7, -8.1, -7.8, 2.1, 10.2];
const FREQ_LABELS = ['125', '250', '500', '1k', '2k', '3k', '4k', '6k', '8k'];

// ── State ────────────────────────────────────────────
const state = {
  thresholds: { left: Array(9).fill(null), right: Array(9).fill(null) },
  calibDone: false,
  test: {
    earIdx: 0, freqIdx: 0,
    currentDB: 40, step: 10,
    reversals: 0, lastDir: null,
    doneSteps: 0, toneNode: null,
    toneTimer: null, awaitingResp: false,
  }
};

// ── Audio Engine ─────────────────────────────────────
let audioCtx = null;
let calibOsc = null;

function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function stopOsc(node) { try { if (node) node.stop(); } catch (_) {} }

function playTone(freq, dbLevel, ear, durMs = 500) {
  const ctx = getCtx();
  stopOsc(state.test.toneNode);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const pan = ctx.createStereoPanner();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const lin = Math.pow(10, (dbLevel - 75) / 20) * 0.4;
  const now = ctx.currentTime;
  const dur = durMs / 1000;
  const fade = Math.min(0.04, dur * 0.1);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(lin, now + fade);
  gain.gain.setValueAtTime(lin, now + dur - fade);
  gain.gain.linearRampToValueAtTime(0, now + dur);
  pan.pan.value = ear === 0 ? -1 : 1;
  osc.connect(gain); gain.connect(pan); pan.connect(ctx.destination);
  osc.start(now); osc.stop(now + dur + 0.05);
  state.test.toneNode = osc;
}

function playCalibTone(vol) {
  const ctx = getCtx();
  stopOsc(calibOsc);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine'; osc.frequency.value = 1000;
  gain.gain.value = vol * 0.25;
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start();
  calibOsc = osc;
}
function stopCalibTone() { stopOsc(calibOsc); calibOsc = null; }

// ── Waveform Animation ───────────────────────────────
function initWaveform(canvasEl, active = false) {
  const ctx = canvasEl.getContext('2d');
  let t = 0, raf;
  function draw() {
    const W = canvasEl.offsetWidth, H = canvasEl.offsetHeight;
    canvasEl.width = W; canvasEl.height = H;
    ctx.clearRect(0, 0, W, H);
    const freqs = [0.8, 1.6, 3.2];
    const amps  = active ? [18, 10, 6] : [8, 4, 2];
    const colors = active
      ? ['rgba(13,198,143,0.7)', 'rgba(13,198,143,0.35)', 'rgba(13,198,143,0.15)']
      : ['rgba(90,122,158,0.4)', 'rgba(90,122,158,0.2)', 'rgba(90,122,158,0.08)'];
    freqs.forEach((f, i) => {
      ctx.beginPath();
      ctx.strokeStyle = colors[i];
      ctx.lineWidth = i === 0 ? 1.5 : 1;
      for (let x = 0; x <= W; x++) {
        const y = H / 2 + amps[i] * Math.sin((x / W) * Math.PI * 2 * f * 3 + t + i * 1.2);
        (i === 0 && x === 0) ? ctx.moveTo(x, y) : (x > 0 && ctx.lineTo(x, y));
        if (i > 0 && x === 0) ctx.moveTo(x, y);
      }
      ctx.stroke();
    });
    t += active ? 0.06 : 0.015;
    raf = requestAnimationFrame(draw);
  }
  draw();
  return { stop: () => cancelAnimationFrame(raf), setActive: (v) => { active = v; } };
}

// ── Navigation ───────────────────────────────────────
const pages = ['calib', 'test', 'result', 'ai'];

function goTo(id) {
  pages.forEach(p => document.getElementById('page-' + p).classList.toggle('active', p === id));
  document.querySelectorAll('.nav-tab').forEach((b, i) => b.classList.toggle('active', pages[i] === id));
  if (id === 'result') renderResult();
  if (id === 'ai') initAIPage();
}

// ── Calibration ──────────────────────────────────────
function initCalibPage() {
  const volEl = document.getElementById('cal-vol');
  const volOut = document.getElementById('cal-vol-out');
  const canvas = document.getElementById('calib-wave');
  volEl.addEventListener('input', () => { volOut.textContent = volEl.value + '%'; });
  document.getElementById('btn-calib-play').addEventListener('click', () => playCalibTone(parseInt(volEl.value) / 100));
  document.getElementById('btn-calib-stop').addEventListener('click', stopCalibTone);
  document.getElementById('btn-start-test').addEventListener('click', () => {
    stopCalibTone(); state.calibDone = true; goTo('test'); showTestIdle();
  });
  initWaveform(canvas, false);
}

// ── Test ─────────────────────────────────────────────
let waveAnim = null;

function showTestIdle()   { set3('flex', 'none', 'none'); }
function showTestActive() { set3('none', 'block', 'none'); }
function showTestDone()   { set3('none', 'none', 'flex'); }
function set3(a, b, c) {
  document.getElementById('test-idle').style.display   = a;
  document.getElementById('test-active').style.display = b;
  document.getElementById('test-done').style.display   = c;
}

function initTestPage() {
  document.getElementById('btn-begin-test').addEventListener('click', startTest);
  document.getElementById('hear-btn').addEventListener('click', markHeard);
  document.getElementById('not-heard-btn').addEventListener('click', markNotHeard);
  document.getElementById('btn-retry').addEventListener('click', () => { resetTest(); showTestIdle(); });
  document.getElementById('btn-see-result').addEventListener('click', () => goTo('result'));
}

function startTest() {
  const t = state.test;
  t.earIdx = 0; t.freqIdx = 0; t.currentDB = 40; t.step = 10;
  t.reversals = 0; t.lastDir = null; t.doneSteps = 0;
  state.thresholds = { left: Array(9).fill(null), right: Array(9).fill(null) };
  showTestActive();
  if (waveAnim) waveAnim.stop();
  waveAnim = initWaveform(document.getElementById('test-wave'), false);
  scheduleTone();
}

function resetTest() {
  const t = state.test;
  clearTimeout(t.toneTimer); stopOsc(t.toneNode);
  t.toneNode = null; t.awaitingResp = false;
  setHearBtnPlaying(false);
}

function scheduleTone() {
  const t = state.test;
  if (t.freqIdx >= FREQS.length) {
    if (t.earIdx === 0) {
      t.earIdx = 1; t.freqIdx = 0;
      t.currentDB = 40; t.step = 10; t.reversals = 0; t.lastDir = null;
      updateTestUI();
      t.toneTimer = setTimeout(playNextTone, 900);
    } else { finishTest(); }
    return;
  }
  updateTestUI();
  t.toneTimer = setTimeout(playNextTone, 600);
}

function playNextTone() {
  const t = state.test;
  if (t.freqIdx >= FREQS.length) return;
  setHearBtnPlaying(true);
  if (waveAnim) waveAnim.setActive(true);
  t.awaitingResp = true;
  playTone(FREQS[t.freqIdx], t.currentDB, t.earIdx, 500);
  t.toneTimer = setTimeout(() => {
    setHearBtnPlaying(false);
    if (waveAnim) waveAnim.setActive(false);
    if (t.awaitingResp) handleResponse(false);
  }, 1800);
}

function markHeard() {
  const t = state.test;
  if (!t.awaitingResp) return;
  clearTimeout(t.toneTimer); stopOsc(t.toneNode);
  setHearBtnPlaying(false); if (waveAnim) waveAnim.setActive(false);
  t.awaitingResp = false; handleResponse(true);
}

function markNotHeard() {
  const t = state.test;
  if (!t.awaitingResp) return;
  clearTimeout(t.toneTimer); stopOsc(t.toneNode);
  setHearBtnPlaying(false); if (waveAnim) waveAnim.setActive(false);
  t.awaitingResp = false; handleResponse(false);
}

function handleResponse(heard) {
  const t = state.test;
  if (heard) {
    if (t.lastDir === 'up') t.reversals++;
    if (t.reversals >= 2 || t.step <= 5) { recordThreshold(); return; }
    t.lastDir = 'down';
    t.currentDB = Math.max(-10, t.currentDB - t.step);
    if (t.reversals >= 1) t.step = 5;
  } else {
    if (t.lastDir === 'down') t.reversals++;
    t.lastDir = 'up';
    t.currentDB = Math.min(110, t.currentDB + t.step);
  }
  scheduleTone();
}

function recordThreshold() {
  const t = state.test;
  const ear = t.earIdx === 0 ? 'left' : 'right';
  state.thresholds[ear][t.freqIdx] = Math.round(t.currentDB + CORRECTION[t.freqIdx]);
  t.freqIdx++; t.doneSteps++;
  t.currentDB = 40; t.step = 10; t.reversals = 0; t.lastDir = null;
  updateProgress(); scheduleTone();
}

function finishTest() {
  clearTimeout(state.test.toneTimer);
  showTestDone();
  document.querySelectorAll('.nav-tab.disabled').forEach(b => b.classList.remove('disabled'));
}

function setHearBtnPlaying(on) {
  document.getElementById('hear-btn').classList.toggle('playing', on);
}

function updateTestUI() {
  const t = state.test;
  const freq = FREQS[t.freqIdx] || FREQS[FREQS.length - 1];
  document.getElementById('freq-num').textContent = freq >= 1000 ? freq / 1000 : freq;
  document.getElementById('freq-unit').textContent = freq >= 1000 ? 'kHz' : 'Hz';
  const badge = document.getElementById('ear-badge');
  badge.className = 'ear-pill ' + (t.earIdx === 0 ? 'ear-left' : 'ear-right');
  badge.textContent = t.earIdx === 0 ? '← 왼쪽 귀' : '오른쪽 귀 →';
  updateProgress();
}

function updateProgress() {
  const t = state.test;
  const pct = Math.round(t.doneSteps / 18 * 100);
  document.getElementById('prog-fill').style.width = pct + '%';
  document.getElementById('prog-text').textContent = `${t.doneSteps} / 18  (${pct}%)`;
  document.getElementById('prog-ear').textContent = (t.earIdx === 0 ? '왼쪽' : '오른쪽') + ' 귀';
}

// ── Result Page ───────────────────────────────────────
function renderResult() {
  const E = window.HearCheckEngine;
  const lPTA = E.calcPTA4(state.thresholds.left);
  const rPTA = E.calcPTA4(state.thresholds.right);
  const who  = E.classifyWHO(Math.max(lPTA ?? 0, rPTA ?? 0));

  document.getElementById('metric-l').textContent = lPTA !== null ? lPTA : '—';
  document.getElementById('metric-r').textContent = rPTA !== null ? rPTA : '—';

  const dxEl = document.getElementById('dx-card');
  dxEl.style.cssText = `background:${who.bg};border-color:${who.border};color:${who.color};border-radius:var(--radius);padding:14px 16px;margin-bottom:12px;border:0.5px solid`;
  document.getElementById('dx-title').textContent = `스크리닝 결과: ${who.label} (Grade ${who.grade})`;
  document.getElementById('dx-sub').textContent   = `WHO 2021 기준 — 본 결과는 참고용이며 전문 검사로 확인하세요.`;

  drawAudiogram();
}

function drawAudiogram() {
  const canvas = document.getElementById('audiogram');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.parentElement.clientWidth - 28;
  const H   = 200;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const pad = { top: 16, right: 16, bottom: 28, left: 42 };
  const gw = W - pad.left - pad.right, gh = H - pad.top - pad.bottom;
  const DB_MIN = -10, DB_MAX = 120;
  function dbY(db) { return pad.top + (db - DB_MIN) / (DB_MAX - DB_MIN) * gh; }
  function freqX(i) { return pad.left + i / (FREQS.length - 1) * gw; }
  ctx.fillStyle = '#0f1f3a'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(13,158,117,0.07)';
  ctx.fillRect(pad.left, dbY(-10), gw, dbY(15) - dbY(-10));
  for (let db = -10; db <= 120; db += 10) {
    const y = dbY(db);
    ctx.beginPath(); ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 0.5;
    ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + gw, y); ctx.stroke();
    if (db % 20 === 0 || db === -10) {
      ctx.fillStyle = 'rgba(90,122,158,0.7)';
      ctx.font = '9px Inter,system-ui,sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(db, pad.left - 4, y + 3);
    }
  }
  FREQ_LABELS.forEach((lbl, i) => {
    const x = freqX(i);
    ctx.beginPath(); ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 0.5;
    ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + gh); ctx.stroke();
    ctx.fillStyle = 'rgba(90,122,158,0.7)';
    ctx.font = '9px Inter,system-ui,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(lbl, x, pad.top + gh + 16);
  });
  ctx.save(); ctx.translate(10, pad.top + gh / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'rgba(90,122,158,0.6)'; ctx.font = '9px Inter,system-ui,sans-serif';
  ctx.textAlign = 'center'; ctx.fillText('dB HL', 0, 0); ctx.restore();
  [{ ear: 'left', color: '#3882f6', sym: 'X' }, { ear: 'right', color: '#f5a623', sym: 'O' }].forEach(({ ear, color, sym }) => {
    const vals = state.thresholds[ear];
    const pts  = vals.map((v, i) => v !== null ? { x: freqX(i), y: dbY(v) } : null).filter(Boolean);
    if (!pts.length) return;
    if (pts.length > 1) {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.setLineDash([]);
      pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.stroke();
    }
    pts.forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      ctx.fillStyle = '#0f1f3a'; ctx.font = 'bold 7px Inter,system-ui,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(sym, p.x, p.y); ctx.textBaseline = 'alphabetic';
    });
  });
}

// ── AI Page (오프라인 엔진) ───────────────────────────
function initAIPage() {
  FREQS.forEach((_, i) => {
    const el = document.getElementById('fslider-' + i);
    const out = document.getElementById('fval-' + i);
    if (!el) return;
    const val = state.thresholds.left[i] ?? 20;
    el.value = val; out.textContent = val + ' dB';
    el.oninput = () => { out.textContent = el.value + ' dB'; };
  });
}

function getAudiogramFromSliders() {
  return FREQS.map((_, i) => parseInt(document.getElementById('fslider-' + i).value));
}

function applyTestToSliders() {
  FREQS.forEach((_, i) => {
    const el = document.getElementById('fslider-' + i);
    const out = document.getElementById('fval-' + i);
    const val = state.thresholds.left[i];
    if (val !== null && el) { el.value = val; out.textContent = val + ' dB'; }
  });
}

// ── 오프라인 분석 실행 (API 불필요) ─────────────────────
function runAnalysis() {
  const E = window.HearCheckEngine;
  if (!E) { alert('분석 엔진 로드 실패. 페이지를 새로고침 해주세요.'); return; }

  const leftThr  = getAudiogramFromSliders();
  const rightThr = state.thresholds.right.some(v => v !== null)
    ? state.thresholds.right
    : Array(9).fill(null);

  // 로딩 표시
  const aiOut  = document.getElementById('ai-output');
  const dnnOut = document.getElementById('dnn-output');
  aiOut.className  = 'ai-output loading';
  aiOut.innerHTML  = '<span class="spinner"></span>청각 분석 중... (학술 알고리즘 처리)';
  dnnOut.innerHTML = '<span class="spinner"></span>DNN-HA 보정 계산 중...';

  // 약간의 딜레이 후 결과 렌더 (UX)
  setTimeout(() => {
    try {
      const analysis = E.analyzeHearing(leftThr, rightThr);
      const report   = E.buildAnalysisReport(analysis);
      const dnnRep   = E.buildDNNReport(analysis);

      aiOut.className = 'ai-output';
      aiOut.textContent = report;
      dnnOut.textContent = dnnRep;

      // 결과 탭의 진단 카드도 업데이트
      const ear = analysis.left || analysis.right;
      if (ear) {
        const dxEl = document.getElementById('dx-card');
        dxEl.style.cssText = `background:${ear.who.bg};border-color:${ear.who.border};color:${ear.who.color};border-radius:var(--radius);padding:14px 16px;margin-bottom:12px;border:0.5px solid`;
        document.getElementById('dx-title').textContent = `스크리닝 결과: ${ear.who.label} (WHO Grade ${ear.who.grade})`;
        document.getElementById('dx-sub').textContent = `PTA₄ ${ear.pta4} dB HL · AI지수 ${(ear.ai * 100).toFixed(0)}% · 어음인지도 ~${ear.speech}%`;
      }
    } catch (e) {
      aiOut.className = 'ai-output';
      aiOut.textContent = '분석 중 오류 발생: ' + e.message;
    }
  }, 400);
}

// ── PWA Install ───────────────────────────────────────
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredPrompt = e;
  document.getElementById('install-banner').classList.add('show');
});
function installPWA() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(() => {
    deferredPrompt = null;
    document.getElementById('install-banner').classList.remove('show');
  });
}

// ── Init ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  initCalibPage();
  initTestPage();

  document.querySelectorAll('.nav-tab').forEach((btn, i) => {
    btn.addEventListener('click', () => goTo(pages[i]));
  });

  document.getElementById('btn-run-ai').addEventListener('click', runAnalysis);
  document.getElementById('btn-apply-test').addEventListener('click', applyTestToSliders);
  document.getElementById('btn-install').addEventListener('click', installPWA);
  document.getElementById('btn-install-dismiss').addEventListener('click', () => {
    document.getElementById('install-banner').classList.remove('show');
  });

  const btnGoAI = document.getElementById('btn-go-ai');
  if (btnGoAI) btnGoAI.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab.disabled').forEach(b => b.classList.remove('disabled'));
    goTo('ai');
  });

  goTo('calib');
});
