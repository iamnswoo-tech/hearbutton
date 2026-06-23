/* ════════════════════════════════════════════════════
   HearCheck — AI 청력 보조 검사 앱
   audiometry-new + DNN-HA + Web Audio API
   ════════════════════════════════════════════════════ */

// ── Constants (from audiometry-new) ─────────────────
const FREQS   = [125, 250, 500, 1000, 2000, 3000, 4000, 6000, 8000];
// ISO 226:2003 dB SPL → dB HL correction (ref 1000Hz=0)
const CORRECTION = [19.7, 9.0, 2.0, 0, -3.7, -8.1, -7.8, 2.1, 10.2];
const EARS    = ['left', 'right'];
const FREQ_LABELS = ['125', '250', '500', '1k', '2k', '3k', '4k', '6k', '8k'];

// ── State ────────────────────────────────────────────
const state = {
  thresholds: { left: Array(9).fill(null), right: Array(9).fill(null) },
  calibDone: false,
  testRunning: false,
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

function stopOsc(node) {
  try { if (node) node.stop(); } catch (_) {}
}

function playTone(freq, dbLevel, ear, durMs = 500) {
  const ctx = getCtx();
  stopOsc(state.test.toneNode);

  const osc   = ctx.createOscillator();
  const gain  = ctx.createGain();
  const pan   = ctx.createStereoPanner();

  osc.type = 'sine';
  osc.frequency.value = freq;

  // Convert dB level to linear gain; calibrated so 40dB≈comfortable listen
  const lin = Math.pow(10, (dbLevel - 75) / 20) * 0.4;
  const now = ctx.currentTime;
  const dur = durMs / 1000;
  const fade = Math.min(0.04, dur * 0.1);

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(lin, now + fade);
  gain.gain.setValueAtTime(lin, now + dur - fade);
  gain.gain.linearRampToValueAtTime(0, now + dur);

  pan.pan.value = ear === 0 ? -1 : 1; // left=-1, right=+1

  osc.connect(gain);
  gain.connect(pan);
  pan.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + dur + 0.05);
  state.test.toneNode = osc;
}

function playCalibTone(vol) {
  const ctx = getCtx();
  stopOsc(calibOsc);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 1000;
  gain.gain.value = vol * 0.25;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  calibOsc = osc;
}

function stopCalibTone() {
  stopOsc(calibOsc);
  calibOsc = null;
}

// ── Waveform Canvas Animation ────────────────────────
function initWaveform(canvasEl, active = false) {
  const ctx = canvasEl.getContext('2d');
  let t = 0;
  let raf;

  function draw() {
    const W = canvasEl.offsetWidth;
    const H = canvasEl.offsetHeight;
    canvasEl.width = W;
    canvasEl.height = H;
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
        i === 0 && x === 0 ? ctx.moveTo(x, y) : x > 0 && ctx.lineTo(x, y);
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
const pages  = ['calib', 'test', 'result', 'ai'];
const navBtns = () => document.querySelectorAll('.nav-tab');

function goTo(id) {
  pages.forEach(p => {
    document.getElementById('page-' + p).classList.toggle('active', p === id);
  });
  navBtns().forEach((b, i) => {
    b.classList.toggle('active', pages[i] === id);
  });
  if (id === 'result') renderResult();
  if (id === 'ai') initAIPage();
}

// ── Calibration Page ──────────────────────────────────
function initCalibPage() {
  const volEl  = document.getElementById('cal-vol');
  const volOut = document.getElementById('cal-vol-out');
  const canvas = document.getElementById('calib-wave');

  volEl.addEventListener('input', () => {
    volOut.textContent = volEl.value + '%';
  });

  document.getElementById('btn-calib-play').addEventListener('click', () => {
    playCalibTone(parseInt(volEl.value) / 100);
  });
  document.getElementById('btn-calib-stop').addEventListener('click', stopCalibTone);
  document.getElementById('btn-start-test').addEventListener('click', () => {
    stopCalibTone();
    state.calibDone = true;
    goTo('test');
    showTestIdle();
  });

  initWaveform(canvas, false);
}

// ── Test Page ─────────────────────────────────────────
let waveAnim = null;

function showTestIdle() {
  document.getElementById('test-idle').style.display = 'flex';
  document.getElementById('test-active').style.display = 'none';
  document.getElementById('test-done').style.display = 'none';
}

function showTestActive() {
  document.getElementById('test-idle').style.display = 'none';
  document.getElementById('test-active').style.display = 'block';
  document.getElementById('test-done').style.display = 'none';
}

function showTestDone() {
  document.getElementById('test-idle').style.display = 'none';
  document.getElementById('test-active').style.display = 'none';
  document.getElementById('test-done').style.display = 'flex';
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
  const wCanvas = document.getElementById('test-wave');
  if (waveAnim) waveAnim.stop();
  waveAnim = initWaveform(wCanvas, false);
  scheduleTone();
}

function resetTest() {
  const t = state.test;
  clearTimeout(t.toneTimer);
  stopOsc(t.toneNode);
  t.toneNode = null;
  t.awaitingResp = false;
  setHearBtnPlaying(false);
}

function scheduleTone() {
  const t = state.test;
  // Check if we move to right ear or finish
  if (t.freqIdx >= FREQS.length) {
    if (t.earIdx === 0) {
      t.earIdx = 1; t.freqIdx = 0;
      t.currentDB = 40; t.step = 10; t.reversals = 0; t.lastDir = null;
      updateTestUI();
      t.toneTimer = setTimeout(playNextTone, 900);
    } else {
      finishTest();
    }
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
  clearTimeout(t.toneTimer);
  stopOsc(t.toneNode);
  setHearBtnPlaying(false);
  if (waveAnim) waveAnim.setActive(false);
  t.awaitingResp = false;
  handleResponse(true);
}

function markNotHeard() {
  const t = state.test;
  if (!t.awaitingResp) return;
  clearTimeout(t.toneTimer);
  stopOsc(t.toneNode);
  setHearBtnPlaying(false);
  if (waveAnim) waveAnim.setActive(false);
  t.awaitingResp = false;
  handleResponse(false);
}

function handleResponse(heard) {
  const t = state.test;
  if (heard) {
    const newDir = 'down';
    if (t.lastDir === 'up') t.reversals++;
    if (t.reversals >= 2 || t.step <= 5) {
      recordThreshold();
      return;
    }
    t.lastDir = newDir;
    t.currentDB = Math.max(-10, t.currentDB - t.step);
    if (t.reversals >= 1) t.step = 5;
  } else {
    const newDir = 'up';
    if (t.lastDir === 'down') t.reversals++;
    t.lastDir = newDir;
    t.currentDB = Math.min(110, t.currentDB + t.step);
  }
  scheduleTone();
}

function recordThreshold() {
  const t = state.test;
  const ear = t.earIdx === 0 ? 'left' : 'right';
  const dBHL = t.currentDB + CORRECTION[t.freqIdx];
  state.thresholds[ear][t.freqIdx] = Math.round(dBHL);
  t.freqIdx++;
  t.doneSteps++;
  t.currentDB = 40; t.step = 10; t.reversals = 0; t.lastDir = null;
  updateProgress();
  scheduleTone();
}

function finishTest() {
  clearTimeout(state.test.toneTimer);
  showTestDone();
  // unlock result + ai tabs
  document.querySelectorAll('.nav-tab.disabled').forEach(b => b.classList.remove('disabled'));
}

function setHearBtnPlaying(on) {
  const btn = document.getElementById('hear-btn');
  btn.classList.toggle('playing', on);
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
  const total = 18;
  const pct = Math.round(t.doneSteps / total * 100);
  document.getElementById('prog-fill').style.width = pct + '%';
  document.getElementById('prog-text').textContent = t.doneSteps + ' / ' + total + '  (' + pct + '%)';
  const earTxt = t.earIdx === 0 ? '왼쪽' : '오른쪽';
  document.getElementById('prog-ear').textContent = earTxt + ' 귀';
}

// ── Result Page ───────────────────────────────────────
function avgPTA(ear) {
  const v = state.thresholds[ear];
  // PTA: 500, 1000, 4000 Hz (index 2, 3, 6)
  const pts = [v[2], v[3], v[6]].filter(x => x !== null);
  if (pts.length) return Math.round(pts.reduce((a, b) => a + b, 0) / pts.length);
  const all = v.filter(x => x !== null);
  return all.length ? Math.round(all.reduce((a, b) => a + b, 0) / all.length) : null;
}

function classifyHL(db) {
  if (db === null) return { label: '—', cls: 'dx-normal', desc: '데이터 없음' };
  if (db <= 15)  return { label: '정상', cls: 'dx-normal',   desc: '–10 ~ 15 dB HL 범위 내 정상 청력' };
  if (db <= 25)  return { label: '경미', cls: 'dx-slight',   desc: '16 ~ 25 dB HL — 경미한 손실 (Slight)' };
  if (db <= 40)  return { label: '경도', cls: 'dx-mild',     desc: '26 ~ 40 dB HL — 경도 손실 (Mild)' };
  if (db <= 55)  return { label: '중등도', cls: 'dx-moderate', desc: '41 ~ 55 dB HL — 중등도 손실 (Moderate)' };
  if (db <= 70)  return { label: '중고도', cls: 'dx-moderate', desc: '56 ~ 70 dB HL — 중등고도 손실' };
  return           { label: '고도+', cls: 'dx-severe',   desc: '71 dB HL 이상 — 전문 의료기관 상담 필요' };
}

function renderResult() {
  const lPTA = avgPTA('left');
  const rPTA = avgPTA('right');
  const worst = Math.max(lPTA ?? 0, rPTA ?? 0);
  const dx = classifyHL(worst > 0 ? worst : null);

  document.getElementById('metric-l').textContent = lPTA !== null ? lPTA : '—';
  document.getElementById('metric-r').textContent = rPTA !== null ? rPTA : '—';

  const dxEl = document.getElementById('dx-card');
  dxEl.className = 'dx-card ' + dx.cls;
  document.getElementById('dx-title').textContent = '스크리닝 결과: ' + dx.label;
  document.getElementById('dx-sub').textContent   = dx.desc + '. 본 결과는 참고용이며 전문 검사로 확인하세요.';

  drawAudiogram();
}

function drawAudiogram() {
  const canvas = document.getElementById('audiogram');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.parentElement.clientWidth - 28;
  const H   = 200;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pad = { top: 16, right: 16, bottom: 28, left: 42 };
  const gw  = W - pad.left - pad.right;
  const gh  = H - pad.top  - pad.bottom;
  const DB_MIN = -10, DB_MAX = 120;

  function dbY(db) { return pad.top + (db - DB_MIN) / (DB_MAX - DB_MIN) * gh; }
  function freqX(i) { return pad.left + i / (FREQS.length - 1) * gw; }

  // Background
  ctx.fillStyle = '#0f1f3a';
  ctx.fillRect(0, 0, W, H);

  // Normal range shading
  ctx.fillStyle = 'rgba(13,158,117,0.07)';
  ctx.fillRect(pad.left, dbY(-10), gw, dbY(15) - dbY(-10));

  // Grid lines
  for (let db = -10; db <= 120; db += 10) {
    const y = dbY(db);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 0.5;
    ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + gw, y);
    ctx.stroke();
    if (db % 20 === 0 || db === -10) {
      ctx.fillStyle = 'rgba(90,122,158,0.7)';
      ctx.font = '9px Inter, system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(db, pad.left - 4, y + 3);
    }
  }
  FREQ_LABELS.forEach((lbl, i) => {
    const x = freqX(i);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 0.5;
    ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + gh);
    ctx.stroke();
    ctx.fillStyle = 'rgba(90,122,158,0.7)';
    ctx.font = '9px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(lbl, x, pad.top + gh + 16);
  });

  // Axis labels
  ctx.save();
  ctx.translate(10, pad.top + gh / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'rgba(90,122,158,0.6)';
  ctx.font = '9px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('dB HL', 0, 0);
  ctx.restore();

  // Plot ears
  const earDef = [
    { ear: 'left',  color: '#3882f6', sym: 'X' },
    { ear: 'right', color: '#f5a623', sym: 'O' },
  ];
  earDef.forEach(({ ear, color, sym }) => {
    const vals = state.thresholds[ear];
    const pts  = vals.map((v, i) => v !== null ? { x: freqX(i), y: dbY(v) } : null).filter(Boolean);
    if (pts.length < 1) return;

    // Line
    if (pts.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.setLineDash([]);
      pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.stroke();
    }

    // Symbols
    pts.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = '#0f1f3a';
      ctx.font = 'bold 7px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(sym, p.x, p.y);
      ctx.textBaseline = 'alphabetic';
    });
  });
}

// ── AI Page ───────────────────────────────────────────
function initAIPage() {
  // Populate sliders from test results or defaults
  FREQS.forEach((f, i) => {
    const el  = document.getElementById('fslider-' + i);
    const out = document.getElementById('fval-' + i);
    if (!el) return;
    const val = state.thresholds.left[i] ?? 20;
    el.value = val;
    out.textContent = val + ' dB';
    el.oninput = () => { out.textContent = el.value + ' dB'; };
  });
}

function getAudiogramFromSliders() {
  return FREQS.map((_, i) => parseInt(document.getElementById('fslider-' + i).value));
}

function applyTestToSliders() {
  FREQS.forEach((_, i) => {
    const el  = document.getElementById('fslider-' + i);
    const out = document.getElementById('fval-' + i);
    const val = state.thresholds.left[i];
    if (val !== null && el) {
      el.value = val;
      out.textContent = val + ' dB';
    }
  });
}

async function runAI() {
  const aud = getAudiogramFromSliders();
  const out = document.getElementById('ai-output');
  out.className = 'ai-output loading';
  out.innerHTML = '<span class="spinner"></span>Claude가 청각도를 분석하는 중...';

  const audStr = FREQS.map((f, i) => `${f}Hz: ${aud[i]}dB HL`).join(', ');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `다음은 순음 청력검사(PTA) 왼쪽 귀 결과입니다. 전문적이고 따뜻하게 한국어로 분석해주세요.

청각도: ${audStr}

아래 항목을 포함해 설명하세요:
1. 청력 손실 정도 및 유형 (정상/경미/경도/중등도/고도)
2. 어느 주파수 대역에서 손실이 두드러지는지
3. 일상생활에서 겪을 수 있는 어려움 (예: 조용한 대화, 전화통화 등)
4. DNN 기반 개인화 보청기(DNN-HA) 처리가 도움이 될 수 있는지
5. 권고사항 (전문의 상담 필요 여부)

간결하고 이해하기 쉬운 언어로, 200단어 내외로 작성하세요. 반드시 이 결과는 스크리닝 목적이며 의학적 진단을 대체하지 않는다고 언급하세요.`
        }]
      })
    });
    const data = await res.json();
    const text = data.content?.find(c => c.type === 'text')?.text || '분석 결과를 불러오지 못했습니다.';
    out.className = 'ai-output';
    out.textContent = text;
    renderDNN(aud);
  } catch (e) {
    out.className = 'ai-output';
    out.textContent = '오류 발생: ' + e.message;
  }
}

async function renderDNN(aud) {
  const out = document.getElementById('dnn-output');
  out.innerHTML = '<span class="spinner"></span>DNN-HA 보정 분석 중...';

  // DNN-HA gain estimation (from DNN-HA paper: audiogram → frequency gain)
  const gains = aud.map((db, i) => {
    const corrected = Math.max(0, db - CORRECTION[i]);
    return Math.round(corrected * 0.55); // NAL-R approximation
  });
  const gainStr = FREQS.map((f, i) => `${f}Hz: +${gains[i]}dB`).join(', ');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `DNN-HA(딥러닝 보청기) 모델 기준으로 아래 청각도에 대한 주파수별 추정 보정 이득을 해설해주세요.

추정 이득: ${gainStr}

ISO 226과 NAL-R 처방 공식을 참조해, 어느 주파수가 가장 많이 보정될지, 그리고 DNN 기반 개인화 처리가 기존 보청기 대비 어떤 이점이 있는지 3~4문장으로 요약하세요.`
        }]
      })
    });
    const data = await res.json();
    out.textContent = data.content?.find(c => c.type === 'text')?.text || '';
  } catch (e) {
    out.textContent = '오류: ' + e.message;
  }
}

// ── PWA Install ───────────────────────────────────────
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  const banner = document.getElementById('install-banner');
  banner.classList.add('show');
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
  // Register SW
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  initCalibPage();
  initTestPage();

  // Nav
  document.querySelectorAll('.nav-tab').forEach((btn, i) => {
    btn.addEventListener('click', () => goTo(pages[i]));
  });

  // AI page buttons
  document.getElementById('btn-run-ai').addEventListener('click', runAI);
  document.getElementById('btn-apply-test').addEventListener('click', applyTestToSliders);
  document.getElementById('btn-install').addEventListener('click', installPWA);
  document.getElementById('btn-install-dismiss').addEventListener('click', () => {
    document.getElementById('install-banner').classList.remove('show');
  });

  // Start on calibration
  goTo('calib');
});
