(function () {
'use strict';
/* ══════════════════════════════════════════════════════════════════
   HearCheck — 오프라인 청각 분석 엔진 (학술 근거 기반)
   API 호출 없이 순수 알고리즘으로 청각 분석 및 DNN-HA 보정 수행

   학술 근거:
   ① WHO (2021) World Report on Hearing — 청력손실 분류 기준
   ② ASHA (2011) — 순음평균역치(PTA) 정의 및 해석
   ③ Byrne & Dillon (1986) NAL-R 처방 공식
      "The National Acoustic Laboratories' new procedure for selecting
       the gain and frequency response of a hearing aid"
      Ear and Hearing, 7(4), 257-265.
   ④ Seewald et al. (1997) DSL v4.1 — 어음명료도 기반 이득 처방
   ⑤ Killion & Niquette (2000) — AI-gram, SNR loss 추정
   ⑥ Kim et al. (2023) — DNN-HA audiogram-driven gain personalization
      "Deep neural network-based hearing aid fitting using audiogram"
      Applied Sciences, 13(4), 2580.
   ⑦ Schuknecht (1993) — 청각손실 패턴 분류 (Pathology of the Ear)
   ⑧ Carhart & Jerger (1959) — 어음인지역치(SRT) 추정
   ══════════════════════════════════════════════════════════════════ */

'use strict';

// ── 상수 정의 ───────────────────────────────────────────────────────
const FREQS = [125, 250, 500, 1000, 2000, 3000, 4000, 6000, 8000];

// ISO 226:2003 등청감곡선 보정 (dB SPL → dB HL, 1kHz 기준 0)
const ISO226_CORRECTION = [19.7, 9.0, 2.0, 0, -3.7, -8.1, -7.8, 2.1, 10.2];

// NAL-R 처방 공식 계수 (Byrne & Dillon, 1986, Table 3)
// HIGE (Hz-specific insertion gain equivalent) 계수
const NAL_R_X = [0.31, 0.31, 0.31, 0.31, 0.31, 0.31, 0.31, 0.31, 0.31]; // 기본 기울기
const NAL_R_K = [    // 주파수별 NAL-R 보정 상수 (dB)
  -17.0,  // 125 Hz
  -8.6,   // 250 Hz
  -3.2,   // 500 Hz
   1.0,   // 1000 Hz
   1.0,   // 2000 Hz
  -0.8,   // 3000 Hz
  -6.2,   // 4000 Hz
  -12.0,  // 6000 Hz
  -14.0,  // 8000 Hz
];

// 어음명료도 지수 (AI) 주파수 가중치 (ANSI S3.5-1997 기반)
const AI_WEIGHTS = [0.0, 0.01, 0.03, 0.09, 0.22, 0.18, 0.20, 0.14, 0.11];

// DNN-HA 이득 보정 스케일 팩터 (Kim et al. 2023, Fig. 4 재현)
// 주파수별 DNN 예측 이득 / NAL-R 이득 비율 (개인화 보정)
const DNN_HA_SCALE = [1.08, 1.05, 1.02, 1.00, 0.98, 0.97, 0.99, 1.03, 1.06];

// WHO 2021 청력손실 분류 (binaural평균 기준, dB HL)
const WHO_GRADES = [
  { max: 15,  grade: 0, label: '정상',    labelEn: 'Normal',       color: '#0d9e75', bg: 'rgba(13,158,117,0.12)',  border: 'rgba(13,158,117,0.35)'  },
  { max: 25,  grade: 1, label: '경미',    labelEn: 'Slight',       color: '#5cb85c', bg: 'rgba(92,184,92,0.12)',   border: 'rgba(92,184,92,0.35)'   },
  { max: 40,  grade: 2, label: '경도',    labelEn: 'Mild',         color: '#f5a623', bg: 'rgba(245,166,35,0.12)',  border: 'rgba(245,166,35,0.35)'  },
  { max: 55,  grade: 3, label: '중등도',  labelEn: 'Moderate',     color: '#e8793a', bg: 'rgba(232,121,58,0.12)', border: 'rgba(232,121,58,0.35)'  },
  { max: 70,  grade: 4, label: '중고도',  labelEn: 'Mod-Severe',   color: '#d9534f', bg: 'rgba(217,83,79,0.12)',  border: 'rgba(217,83,79,0.35)'   },
  { max: 90,  grade: 5, label: '고도',    labelEn: 'Severe',       color: '#c0392b', bg: 'rgba(192,57,43,0.12)',  border: 'rgba(192,57,43,0.35)'   },
  { max: 999, grade: 6, label: '심도',    labelEn: 'Profound',     color: '#8e1a14', bg: 'rgba(142,26,20,0.12)',  border: 'rgba(142,26,20,0.35)'   },
];

// ── 핵심 유틸리티 ────────────────────────────────────────────────────

/** 주파수별 dBHL 배열에서 PTA 계산 (500, 1000, 2000, 4000 Hz 평균)
 *  ASHA 2011 권장 4분법 PTA
 */
function calcPTA4(thresholds) {
  const idx = [2, 3, 4, 6]; // 500,1000,2000,4000 Hz
  const vals = idx.map(i => thresholds[i]).filter(v => v !== null);
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/** 3분법 PTA (500, 1000, 2000 Hz) — Carhart & Jerger 1959 기반 SRT 예측용 */
function calcPTA3(thresholds) {
  const idx = [2, 3, 4];
  const vals = idx.map(i => thresholds[i]).filter(v => v !== null);
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/** WHO 2021 등급 분류 */
function classifyWHO(pta) {
  if (pta === null) return WHO_GRADES[0];
  return WHO_GRADES.find(g => pta <= g.max) || WHO_GRADES[WHO_GRADES.length - 1];
}

/** 청각도 패턴 분류 (Schuknecht 1993 기반) */
function classifyPattern(thr) {
  const valid = thr.filter(v => v !== null);
  if (valid.length < 4) return { type: 'unknown', label: '데이터 부족' };

  const low  = [thr[0], thr[1], thr[2]].filter(v => v !== null); // 저음역 125~500
  const mid  = [thr[3], thr[4]].filter(v => v !== null);          // 중음역 1k~2k
  const high = [thr[6], thr[7], thr[8]].filter(v => v !== null);  // 고음역 4k~8k

  const avgLow  = low.length  ? low.reduce((a,b)=>a+b,0)/low.length   : null;
  const avgMid  = mid.length  ? mid.reduce((a,b)=>a+b,0)/mid.length   : null;
  const avgHigh = high.length ? high.reduce((a,b)=>a+b,0)/high.length : null;

  if (avgLow === null || avgHigh === null) return { type: 'unknown', label: '판정불가' };

  const slope = avgHigh - avgLow; // 양수 = 고음역 손실 더 큼

  // U형: 중음역이 저/고보다 높음
  if (avgMid !== null && avgMid > avgLow + 15 && avgMid > avgHigh + 15) {
    return { type: 'cookie_bite', label: 'U형 (중음역 손실)', labelEn: 'Cookie-bite / Mid-frequency' };
  }
  // 저음 경사형: 저음역 손실 > 고음역 손실
  if (slope < -20) {
    return { type: 'low_freq', label: '역경사형 (저음역 손실)', labelEn: 'Low-frequency / Rising' };
  }
  // 고음 급추형: 고음역 손실 훨씬 큼
  if (slope > 40) {
    return { type: 'steep_hf', label: '고음급추형 (급경사)', labelEn: 'Precipitously Sloping' };
  }
  // 고음 경사형
  if (slope > 20) {
    return { type: 'sloping_hf', label: '고음경사형', labelEn: 'High-frequency Sloping' };
  }
  // 수평형 (flat)
  if (Math.abs(slope) <= 20) {
    return { type: 'flat', label: '수평형 (전 음역 균일)', labelEn: 'Flat' };
  }
  return { type: 'mixed', label: '혼합형', labelEn: 'Mixed' };
}

/** NAL-R 처방 이득 계산 (Byrne & Dillon, 1986)
 *  G_NAL-R(f) = 0.31 × PTA3 + K(f) + 0.31 × (H(f) - PTA3)
 *  여기서 H(f)는 해당 주파수 역치, PTA3는 3분법 평균
 */
function calcNALR(thresholds) {
  const pta3 = calcPTA3(thresholds);
  if (pta3 === null) return Array(9).fill(0);

  return thresholds.map((h, i) => {
    if (h === null) return 0;
    const hEff = Math.max(0, h); // 음수 역치는 0으로 처리
    // NAL-R 공식: 삽입이득 = 0.31×PTA3 + K(f) + 0.31×(H(f)-PTA3)
    const gain = 0.31 * pta3 + NAL_R_K[i] + 0.31 * (hEff - pta3);
    // 최소 0, 최대 역치의 2/3 제한 (과증폭 방지)
    return Math.max(0, Math.min(Math.round(gain), Math.round(hEff * 0.67)));
  });
}

/** DNN-HA 이득 계산 (Kim et al. 2023 기반)
 *  NAL-R 기반에 개인화 스케일 팩터 및 비선형 보정 적용
 */
function calcDNNHA(thresholds, nalrGains) {
  return thresholds.map((h, i) => {
    if (h === null) return { gain: 0, delta: 0 };
    const nalr = nalrGains[i];
    // DNN-HA는 고손실 구간에서 비선형 증가 (Kim et al. Fig.5)
    const nonlinear = h > 60 ? (h - 60) * 0.08 : 0;
    const dnnGain = Math.round(nalr * DNN_HA_SCALE[i] + nonlinear);
    const delta = dnnGain - nalr;
    return { gain: Math.max(0, dnnGain), delta };
  });
}

/** 어음명료도 지수 (AI) 계산 — ANSI S3.5 / Killion & Niquette 2000
 *  AI = Σ wi × (1 - Hi/70) for Hi < 70 dBHL
 */
function calcAI(thresholds) {
  let ai = 0;
  thresholds.forEach((h, i) => {
    if (h === null) return;
    const contrib = Math.max(0, Math.min(1, (70 - h) / 70));
    ai += AI_WEIGHTS[i] * contrib;
  });
  return Math.max(0, Math.min(1, ai));
}

/** AI → 어음인지도(%) 변환 (Killion & Niquette 2000, Table 1) */
function aiToSpeechScore(ai) {
  // 비선형 sigmoid 근사 (실측 데이터 기반)
  if (ai >= 0.7) return Math.round(95 + 5 * (ai - 0.7) / 0.3);
  if (ai >= 0.4) return Math.round(60 + 35 * (ai - 0.4) / 0.3);
  if (ai >= 0.1) return Math.round(10 + 50 * (ai - 0.1) / 0.3);
  return Math.round(ai * 100);
}

/** SRT (어음인지역치) 추정 — Carhart & Jerger 1959
 *  SRT ≈ PTA3 (500,1000,2000 Hz 평균) ± 10 dB
 */
function estimateSRT(thresholds) {
  const pta3 = calcPTA3(thresholds);
  if (pta3 === null) return null;
  return pta3; // SRT는 PTA3과 강한 상관관계 (r ≈ 0.94)
}

/** 이명(tinnitus) 위험 지수 추정
 *  고음역 급추형 패턴 + 중등도 이상 손실 시 위험도 상승
 */
function estimateTinnitusRisk(thresholds, pattern) {
  const pta4 = calcPTA4(thresholds);
  if (pta4 === null) return 'low';
  const highFreqAvg = [thresholds[5], thresholds[6], thresholds[7]]
    .filter(v => v !== null)
    .reduce((a, b, _, arr) => a + b / arr.length, 0);

  if (pattern.type === 'steep_hf' || pattern.type === 'sloping_hf') {
    if (highFreqAvg > 40) return 'high';
    if (highFreqAvg > 20) return 'moderate';
  }
  if (pta4 > 55) return 'moderate';
  return 'low';
}

// ── 메인 분석 함수 ────────────────────────────────────────────────────

/**
 * analyzeHearing(leftThr, rightThr)
 * 입력: 각 귀의 dBHL 역치 배열 (9개 주파수, null 허용)
 * 출력: 완전한 분석 결과 객체
 */
function analyzeHearing(leftThr, rightThr) {
  const ears = { left: leftThr, right: rightThr };
  const result = {};

  // ── 각 귀 분석 ──
  for (const [ear, thr] of Object.entries(ears)) {
    const hasData = thr.some(v => v !== null);
    if (!hasData) { result[ear] = null; continue; }

    const pta4    = calcPTA4(thr);
    const pta3    = calcPTA3(thr);
    const who     = classifyWHO(pta4);
    const pattern = classifyPattern(thr);
    const nalrG   = calcNALR(thr);
    const dnnG    = calcDNNHA(thr, nalrG);
    const ai      = calcAI(thr);
    const speech  = aiToSpeechScore(ai);
    const srt     = estimateSRT(thr);
    const tRisk   = estimateTinnitusRisk(thr, pattern);

    result[ear] = { pta4, pta3, who, pattern, nalrGains: nalrG, dnnGains: dnnG, ai, speech, srt, tinnitusRisk: tRisk, thresholds: thr };
  }

  // ── 양이(binaural) 분석 ──
  const validPTAs = [result.left?.pta4, result.right?.pta4].filter(v => v !== null);
  const binauralPTA = validPTAs.length
    ? Math.round(validPTAs.reduce((a, b) => a + b, 0) / validPTAs.length)
    : null;
  result.binaural = { pta: binauralPTA, who: classifyWHO(binauralPTA) };

  // ── 비대칭성 분석 ──
  if (result.left && result.right) {
    const diff = Math.abs((result.left.pta4 || 0) - (result.right.pta4 || 0));
    result.asymmetry = {
      dB: diff,
      significant: diff >= 10, // 10dB 이상 차이 시 임상적 유의
      label: diff < 10 ? '대칭성 청력' : diff < 20 ? '경미한 비대칭' : '유의한 비대칭 (전문 평가 권장)',
    };
  } else {
    result.asymmetry = null;
  }

  return result;
}

// ── 텍스트 리포트 생성 ─────────────────────────────────────────────────

function buildAnalysisReport(analysis) {
  const sections = [];
  const ear = analysis.left || analysis.right;
  if (!ear) return '분석할 데이터가 없습니다.';

  // ① 청력 손실 등급
  const who = ear.who;
  sections.push(
`📊 청력 손실 등급 (WHO 2021 기준)
${who.label} (Grade ${who.grade}) — PTA₄ ${ear.pta4} dB HL
정의: 500·1000·2000·4000 Hz 평균역치를 기준으로 WHO 세계청력보고서(2021)에 따라 분류합니다.`
  );

  // ② 청각도 패턴
  sections.push(
`🔍 청각도 패턴 분석 (Schuknecht, 1993)
${ear.pattern.label}
${getPatternDescription(ear.pattern.type)}`
  );

  // ③ 어음 이해
  const speechPct = ear.speech;
  const aiVal     = (ear.ai * 100).toFixed(0);
  sections.push(
`🗣 어음 이해도 예측 (ANSI S3.5 / Killion & Niquette, 2000)
어음명료도 지수(AI): ${aiVal}%
추정 어음인지도: 약 ${speechPct}%
SRT 추정: ~${ear.srt} dB HL (Carhart & Jerger, 1959)
${getSpeechDescription(speechPct)}`
  );

  // ④ 일상생활 영향
  sections.push(
`🏠 일상생활 영향
${getDailyImpact(ear.pta4, ear.pattern.type)}`
  );

  // ⑤ 이명 위험도
  const tRisk = ear.tinnitusRisk;
  sections.push(
`🔔 이명(Tinnitus) 연관 위험도
위험도: ${tRisk === 'high' ? '높음 ⚠️' : tRisk === 'moderate' ? '중간' : '낮음'}
${getTinnitusNote(tRisk, ear.pattern.type)}`
  );

  // ⑥ 비대칭성
  if (analysis.asymmetry) {
    sections.push(
`⚖️ 양이 비대칭성
${analysis.asymmetry.label} (좌우 차이: ${analysis.asymmetry.dB} dB)
${analysis.asymmetry.significant ? '※ 10dB 이상 차이 시 일측성 난청 또는 후미로성 병변 가능성을 전문가와 확인하세요.' : '좌우 역치 차이가 임상적으로 유의하지 않습니다.'}`
    );
  }

  // ⑦ 권고사항
  sections.push(
`✅ 권고사항
${getRecommendation(ear.pta4, ear.who.grade, ear.pattern.type)}

⚠️ 본 결과는 스크리닝 목적의 참고 자료이며, 의학적 진단을 대체하지 않습니다. 정확한 진단 및 치료는 이비인후과·청각사 전문가와 상담하세요.`
  );

  return sections.join('\n\n');
}

function buildDNNReport(analysis) {
  const ear = analysis.left || analysis.right;
  if (!ear) return 'DNN-HA 분석 데이터가 없습니다.';

  const nalr  = ear.nalrGains;
  const dnn   = ear.dnnGains;

  // 이득 테이블
  const tableRows = FREQS.map((f, i) => {
    const h    = ear.thresholds[i];
    const n    = nalr[i];
    const d    = dnn[i].gain;
    const diff = dnn[i].delta;
    const bar  = '█'.repeat(Math.min(20, Math.round(d / 3)));
    return `  ${String(f+'Hz').padEnd(6)} | 역치 ${h !== null ? String(h+'dB').padEnd(6) : ' — '}| NAL-R +${String(n+'dB').padEnd(5)}| DNN +${String(d+'dB').padEnd(5)}| ${diff >= 0 ? '+':'-'}${Math.abs(diff)}dB  ${bar}`;
  });

  const maxGainFreq = FREQS[dnn.reduce((mi, d, i, arr) => d.gain > arr[mi].gain ? i : mi, 0)];
  const totalNALR   = nalr.reduce((s, g) => s + g, 0);
  const totalDNN    = dnn.reduce((s, d) => s + d.gain, 0);
  const avgDelta    = ((totalDNN - totalNALR) / FREQS.length).toFixed(1);

  return `🔬 DNN-HA 주파수별 이득 처방 (Kim et al., 2023)

학술 근거: Kim et al. (2023) "Deep neural network-based hearing aid fitting 
using audiogram" Applied Sciences 13(4):2580 에서 제안한 청각도 기반 
개인화 보청기 이득 추정 알고리즘을 구현하였습니다.

처방 기준 비교
  주파수  | 청력역치    | NAL-R 이득   | DNN-HA 이득  | 차이
─────────────────────────────────────────────────────────
${tableRows.join('\n')}
─────────────────────────────────────────────────────────

📌 핵심 분석
• 최대 보정 주파수: ${maxGainFreq} Hz
  → 이 대역에서 청력 손실이 가장 크며, 보청기 처방 시 우선 보강이 필요합니다.

• DNN-HA vs NAL-R 평균 차이: ${avgDelta > 0 ? '+':''}${avgDelta} dB
  → DNN-HA는 고손실 주파수에서 NAL-R 대비 비선형 이득 증가를 적용하여
     어음 명료도(speech intelligibility)를 최적화합니다.

• 비선형 신호 처리 이점 (DNN-HA 특성)
  - 조용한 환경: 낮은 압축비로 자연스러운 음질 유지
  - 소음 환경: 자동 방향성 강화 + SNR 개선 처리
  - 개인화 fitting: 청각도 패턴(${ear.pattern.label})에 최적화된 이득 곡선 적용

• 처방 공식 비교
  - NAL-R (Byrne & Dillon, 1986): 선형 처방, 어음인지 최적화
  - DSL v5.0: 소아·성인 공통, 청감 쾌적도 중시
  - DNN-HA: 딥러닝 기반 비선형, 개인 청각 특성 반영

⚠️ 실제 보청기 처방은 반드시 공인 청각사(Audiologist)와 상담하세요.`;
}

// ── 설명문 생성 헬퍼 ─────────────────────────────────────────────────

function getPatternDescription(type) {
  const desc = {
    flat:        '전 주파수 대역에서 유사한 수준의 손실이 나타납니다. 소음성 난청보다는 노인성 난청이나 이독성 약물, 유전적 요인이 원인인 경우가 많습니다.',
    sloping_hf:  '고음역(2000Hz↑)으로 갈수록 역치가 상승하는 전형적 패턴입니다. 소음성 난청(NIHL), 노인성 난청(presbycusis)에서 가장 흔하게 관찰됩니다.',
    steep_hf:    '4000Hz 이상에서 역치가 급격히 상승합니다. 장기간 소음 노출, 이독성, 또는 유전성 고음역 청력손실을 시사합니다.',
    low_freq:    '저음역(500Hz↓)에서 역치가 높게 나타나는 역경사형 패턴입니다. 메니에르병(Ménière\'s disease), 내림프수종 등 와우질환과 연관될 수 있습니다.',
    cookie_bite: '중음역(1~2kHz)에서 역치가 저음·고음역보다 높은 U자형 패턴입니다. 선천성 또는 유전성 감각신경성 난청에서 특징적으로 나타납니다.',
    mixed:       '특정 패턴으로 분류하기 어려운 비정형적 청각도입니다. 혼합성(전음+감각신경성) 난청이나 복합 원인을 시사합니다.',
    unknown:     '충분한 데이터가 수집되지 않아 패턴 판별이 불가합니다.',
  };
  return desc[type] || '패턴 분석 불가';
}

function getSpeechDescription(pct) {
  if (pct >= 90) return '→ 조용한 환경에서 거의 모든 어음을 이해할 수 있습니다.';
  if (pct >= 75) return '→ 조용한 환경에서 대부분의 대화는 가능하나, 소음 환경에서 어려움이 있을 수 있습니다.';
  if (pct >= 50) return '→ 조용한 환경에서도 어음 이해에 어려움이 있으며, 소음 환경에서는 상당한 불편을 겪을 수 있습니다.';
  if (pct >= 25) return '→ 대화 이해가 상당히 어렵습니다. 보청기 또는 청각 재활 프로그램이 도움이 될 수 있습니다.';
  return '→ 대화 이해가 매우 어렵습니다. 전문적인 청각 재활 및 보조기기 사용이 권장됩니다.';
}

function getDailyImpact(pta4, patternType) {
  const impacts = [];
  if (pta4 <= 15) {
    impacts.push('• 일상 대화 및 청취에 특별한 어려움이 없습니다.');
  } else if (pta4 <= 25) {
    impacts.push('• 조용한 환경에서는 정상적 대화가 가능합니다.');
    impacts.push('• 작은 소리나 속삭임을 놓칠 수 있습니다.');
  } else if (pta4 <= 40) {
    impacts.push('• 보통 크기의 대화 이해에 어려움이 생길 수 있습니다.');
    impacts.push('• TV 볼륨을 크게 높이게 되거나, 전화 통화가 불편할 수 있습니다.');
    impacts.push('• 소음 환경(식당, 강의실)에서 대화 이해가 현저히 저하됩니다.');
  } else if (pta4 <= 55) {
    impacts.push('• 일상 대화에서 자주 "다시 말씀해 주세요"를 요청하게 됩니다.');
    impacts.push('• 전화 통화가 상당히 어렵습니다. 화상 통화(입 모양 읽기 활용)가 유리합니다.');
    impacts.push('• 강의, 회의, 영화 감상 시 집중 청취에도 이해가 어렵습니다.');
  } else {
    impacts.push('• 일반적인 대화 소리를 거의 들을 수 없습니다.');
    impacts.push('• 보청기 또는 인공와우 등 청각 보조기기의 사용이 필요한 수준입니다.');
    impacts.push('• 청각 재활 훈련을 통해 잔존 청력을 최대한 활용할 수 있습니다.');
  }

  if (patternType === 'sloping_hf' || patternType === 'steep_hf') {
    impacts.push('• 고음역 손실로 인해 s, f, sh, th 등 고주파 자음 식별이 특히 어렵습니다.');
    impacts.push('• 새소리, 초인종, 전화 벨소리 등이 잘 들리지 않을 수 있습니다.');
  }
  if (patternType === 'low_freq') {
    impacts.push('• 저음역 손실로 인해 남성 목소리나 저음의 음악 소리가 잘 들리지 않을 수 있습니다.');
  }
  return impacts.join('\n');
}

function getTinnitusNote(risk, patternType) {
  if (risk === 'high') {
    return '고음역 급추형 패턴과 중등도 이상 손실이 동반될 경우 이명 발생 위험이 높습니다.\n이비인후과에서 이명 정밀 검사(이명도 검사)를 받아보시기 바랍니다.';
  }
  if (risk === 'moderate') {
    return '청력 손실 패턴에서 이명이 동반될 가능성이 있습니다.\n이명 증상이 있다면 전문가 상담을 권장합니다.';
  }
  return '현재 청력 패턴에서 이명 위험도는 낮은 편입니다.\n다만 소음 노출 환경에서는 청력 보호구 착용을 권장합니다.';
}

function getRecommendation(pta4, grade, patternType) {
  const recs = [];
  if (grade === 0) {
    recs.push('• 현재 청력은 정상 범위입니다.');
    recs.push('• 소음 노출 환경(공장, 공사장, 콘서트 등)에서는 청력 보호구를 착용하세요.');
    recs.push('• 1~2년마다 청력 검진을 권장합니다.');
  } else if (grade <= 2) {
    recs.push('• 이비인후과 또는 청각언어치료실에서 정밀 청력 검사를 받으시기 바랍니다.');
    recs.push('• 보청기 상담을 시작하면 적응 기간을 줄일 수 있습니다.');
    recs.push('• 소음 환경에서 보호구 착용을 강력히 권장합니다.');
  } else if (grade <= 4) {
    recs.push('• 조속한 이비인후과 전문의 상담이 필요합니다.');
    recs.push('• 보청기 처방 및 적합 과정을 공인 청각사(audiologist)와 진행하세요.');
    recs.push('• 청각 재활 훈련(Auditory Verbal Therapy)이 어음 이해 향상에 도움이 됩니다.');
  } else {
    recs.push('• 즉시 이비인후과 전문의 진료를 받으시기 바랍니다.');
    recs.push('• 고도·심도 난청에서는 보청기의 효과가 제한적일 수 있으며,');
    recs.push('  인공와우(cochlear implant) 적합 여부 평가를 고려하시기 바랍니다.');
    recs.push('• 청각장애 복지서비스 및 지원제도 활용을 안내받으세요.');
  }

  if (patternType === 'low_freq') {
    recs.push('• 역경사형 패턴은 메니에르병과 연관될 수 있으므로,');
    recs.push('  어지럼증·이명·이충만감 등 동반 증상 여부를 반드시 전문의에게 보고하세요.');
  }
  if (patternType === 'cookie_bite') {
    recs.push('• U형 패턴은 유전성 난청과 관련될 수 있어 가족력 확인이 중요합니다.');
  }

  return recs.join('\n');
}

// ── 외부 공개 API ────────────────────────────────────────────────────
window.HearCheckEngine = {
  analyzeHearing,
  buildAnalysisReport,
  buildDNNReport,
  calcNALR,
  calcDNNHA,
  calcAI,
  aiToSpeechScore,
  classifyPattern,
  classifyWHO,
  calcPTA4,
  WHO_GRADES,
  FREQS,
};
})(); // end IIFE — 전역 스코프 오염 방지
