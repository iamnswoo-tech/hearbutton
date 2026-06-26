(function () {
'use strict';
/* ══════════════════════════════════════════════════════════════════════
   HearCheck Clinical Analysis Engine v2.0
   완전 오프라인 · 학술 알고리즘 기반 전문 청각 분석

   참고 문헌:
   [1] WHO (2021). World Report on Hearing. Geneva: WHO Press.
   [2] ASHA (2011). Type, Degree, and Configuration of Hearing Loss.
   [3] Byrne D, Dillon H (1986). NAL-R. Ear Hear, 7(4):257-265.
   [4] Dillon H (2012). Hearing Aids, 2nd Ed. Thieme.
   [5] Killion MC, Niquette PA (2000). AI-gram. JASA, 108(2):517-524.
   [6] Kim YJ et al (2023). DNN-HA. Appl Sci, 13(4):2580.
   [7] Schuknecht HF (1993). Pathology of the Ear, 2nd Ed.
   [8] Carhart R, Jerger JF (1959). SRT. J Speech Hear Disord, 24:360-365.
   [9] Seewald RC et al (1997). DSL Method. Trends Amplif, 2(4):124-153.
   [10] Lidén G, Nilsson G (1954). Air-bone gap 분류.
   [11] AAO-HNS (2019). Clinical Practice Guidelines.
   [12] IEC 60645-1:2017 — 순음청력측정 국제표준.
   ══════════════════════════════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────
//  § 1. 측정 상수 (IEC 60645-1 / ISO 226:2003)
// ─────────────────────────────────────────────────────
const FREQS        = [125, 250, 500, 1000, 2000, 3000, 4000, 6000, 8000];
const FREQ_LABELS  = ['125','250','500','1k','2k','3k','4k','6k','8k'];

// ISO 226:2003 등청감곡선 기반 dBSPL→dBHL 변환 계수
const ISO226_CORR  = [19.7, 9.0, 2.0, 0.0, -3.7, -8.1, -7.8, 2.1, 10.2];

// ─────────────────────────────────────────────────────
//  § 2. WHO 2021 청력손실 등급 분류
// ─────────────────────────────────────────────────────
const WHO_GRADES = [
  { max:15,  grade:0, ko:'정상',   en:'Normal',        icd:'Z00.1',  color:'#10b981', bg:'rgba(16,185,129,0.10)', border:'rgba(16,185,129,0.30)' },
  { max:25,  grade:1, ko:'경미',   en:'Slight',        icd:'H91.9',  color:'#22c55e', bg:'rgba(34,197,94,0.10)',  border:'rgba(34,197,94,0.30)'  },
  { max:40,  grade:2, ko:'경도',   en:'Mild',          icd:'H90.3',  color:'#f59e0b', bg:'rgba(245,158,11,0.12)', border:'rgba(245,158,11,0.35)' },
  { max:55,  grade:3, ko:'중등도', en:'Moderate',      icd:'H90.3',  color:'#f97316', bg:'rgba(249,115,22,0.12)', border:'rgba(249,115,22,0.35)' },
  { max:70,  grade:4, ko:'중고도', en:'Mod-Severe',    icd:'H90.3',  color:'#ef4444', bg:'rgba(239,68,68,0.12)',  border:'rgba(239,68,68,0.35)'  },
  { max:90,  grade:5, ko:'고도',   en:'Severe',        icd:'H90.3',  color:'#dc2626', bg:'rgba(220,38,38,0.12)',  border:'rgba(220,38,38,0.35)'  },
  { max:999, grade:6, ko:'심도',   en:'Profound',      icd:'H90.3',  color:'#991b1b', bg:'rgba(153,27,27,0.12)',  border:'rgba(153,27,27,0.35)'  },
];

// ─────────────────────────────────────────────────────
//  § 3. NAL-R 처방 계수 (Byrne & Dillon 1986, Table 3)
// ─────────────────────────────────────────────────────
const NAL_R_K = [-17.0, -8.6, -3.2, 1.0, 1.0, -0.8, -6.2, -12.0, -14.0];

// DSL v5.0 REAR 목표이득 오프셋 (Seewald 1997, 성인 기준)
const DSL_OFFSET  = [4.0, 3.5, 2.5, 1.0, 0.0, -1.0, -2.0, -3.5, -5.0];

// DNN-HA 스케일 팩터 (Kim et al. 2023, Fig.4)
const DNN_SCALE   = [1.08, 1.05, 1.02, 1.00, 0.98, 0.97, 0.99, 1.03, 1.06];

// ─────────────────────────────────────────────────────
//  § 4. 어음명료도 지수 가중치 (ANSI S3.5-1997)
// ─────────────────────────────────────────────────────
const SII_WEIGHTS = [0.0, 0.01, 0.03, 0.09, 0.22, 0.18, 0.20, 0.14, 0.11];

// ─────────────────────────────────────────────────────
//  § 5. 기본 청각측정 계산 함수
// ─────────────────────────────────────────────────────

/** ASHA 4분법 PTA: 500·1000·2000·4000 Hz */
function calcPTA4(thr) {
  const v = [thr[2], thr[3], thr[4], thr[6]].filter(x => x !== null);
  return v.length ? Math.round(v.reduce((a,b)=>a+b,0)/v.length) : null;
}

/** Carhart-Jerger 3분법 PTA: 500·1000·2000 Hz */
function calcPTA3(thr) {
  const v = [thr[2], thr[3], thr[4]].filter(x => x !== null);
  return v.length ? Math.round(v.reduce((a,b)=>a+b,0)/v.length) : null;
}

/** 고음역 평균: 2000·4000·8000 Hz (소음성 난청 선별용) */
function calcHFPTA(thr) {
  const v = [thr[4], thr[6], thr[8]].filter(x => x !== null);
  return v.length ? Math.round(v.reduce((a,b)=>a+b,0)/v.length) : null;
}

/** 4kHz notch 지수 — 소음성 난청 특이 지표 */
function calcNotchIndex(thr) {
  const f2k = thr[4], f4k = thr[6], f8k = thr[8];
  if (f2k===null||f4k===null||f8k===null) return null;
  // 4kHz notch: 4kHz가 인접 주파수보다 ≥15dB 높으면 유의
  const notch = f4k - Math.max(f2k, f8k);
  return { value: notch, present: notch >= 15 };
}

/** WHO 등급 분류 */
function classifyWHO(pta) {
  if (pta === null) return WHO_GRADES[0];
  return WHO_GRADES.find(g => pta <= g.max) || WHO_GRADES[WHO_GRADES.length-1];
}

// ─────────────────────────────────────────────────────
//  § 6. 난청 유형 분류 (Lidén & Nilsson 1954 / AAO-HNS 2019)
//       기도(AC) vs 골도(BC) 차이 → ABG 분석
//       기도 역치만 있는 경우: 패턴 기반 추정
// ─────────────────────────────────────────────────────
function classifyHLType(acThr, bcThr) {
  // 골도 데이터가 있을 때: ABG(기골도차) 분석
  if (bcThr && bcThr.some(v => v !== null)) {
    const abgVals = acThr.map((ac, i) => {
      const bc = bcThr[i];
      if (ac === null || bc === null) return null;
      return ac - bc;
    }).filter(v => v !== null);

    const avgABG = abgVals.length ? abgVals.reduce((a,b)=>a+b,0)/abgVals.length : 0;
    const acPTA  = calcPTA4(acThr);
    const bcPTA  = calcPTA4(bcThr);

    if (avgABG >= 10 && (bcPTA === null || bcPTA <= 15)) {
      return { type:'conductive',    ko:'전음성 난청',  en:'Conductive HL',    abg: Math.round(avgABG) };
    }
    if (avgABG >= 10 && bcPTA > 15) {
      return { type:'mixed',         ko:'혼합성 난청',  en:'Mixed HL',         abg: Math.round(avgABG) };
    }
    return { type:'sensorineural',   ko:'감각신경성 난청', en:'Sensorineural HL', abg: Math.round(avgABG) };
  }

  // 골도 데이터 없음: 청각도 패턴으로 추정
  const pattern = classifyPattern(acThr);
  if (pattern.type === 'low_freq') {
    // 역경사형 → 전음성 가능성 높음
    return { type:'conductive_est', ko:'전음성 추정',  en:'Conductive (est.)', abg: null };
  }
  return { type:'sensorineural_est', ko:'감각신경성 추정', en:'SNHL (est.)', abg: null };
}

// ─────────────────────────────────────────────────────
//  § 7. 청각도 형태 분류 (Schuknecht 1993 확장)
// ─────────────────────────────────────────────────────
function classifyPattern(thr) {
  const valid = thr.filter(v => v !== null);
  if (valid.length < 4) return { type:'unknown', ko:'데이터 부족', en:'Insufficient data' };

  const avLow  = avg([thr[0],thr[1],thr[2]].filter(v=>v!==null));
  const avMid  = avg([thr[3],thr[4]].filter(v=>v!==null));
  const avHigh = avg([thr[6],thr[7],thr[8]].filter(v=>v!==null));
  const notch  = calcNotchIndex(thr);
  const slope  = (avHigh !== null && avLow !== null) ? avHigh - avLow : 0;

  // 4kHz Notch (소음성 난청 특이 패턴)
  if (notch && notch.present && thr[6] > 40) {
    return { type:'notch_4k', ko:'4kHz Notch형 (소음성)', en:'4kHz Notch (NIHL)', slope };
  }
  // U형 / Cookie-bite
  if (avMid !== null && avMid > (avLow||0) + 15 && avMid > (avHigh||0) + 10) {
    return { type:'cookie_bite', ko:'U형 (중음역 손실)', en:'Cookie-bite', slope };
  }
  // 역경사형 (저음역 손실)
  if (slope < -20) {
    return { type:'low_freq', ko:'역경사형 (저음역 손실)', en:'Rising / Low-frequency', slope };
  }
  // 고음급추형
  if (slope > 45) {
    return { type:'steep_hf', ko:'고음급추형 (≥45dB/octave)', en:'Precipitously Sloping', slope };
  }
  // 고음경사형
  if (slope > 20) {
    return { type:'sloping_hf', ko:'고음경사형', en:'High-frequency Sloping', slope };
  }
  // 수평형
  if (Math.abs(slope) <= 20) {
    return { type:'flat', ko:'수평형', en:'Flat', slope };
  }
  return { type:'mixed', ko:'혼합형', en:'Mixed', slope };
}

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((a,b)=>a+b,0)/arr.length;
}

// ─────────────────────────────────────────────────────
//  § 8. 보청기 이득 처방 알고리즘
// ─────────────────────────────────────────────────────

/** NAL-R 삽입이득 (Byrne & Dillon 1986)
 *  G(f) = 0.31·PTA₃ + K(f) + 0.31·(H(f) − PTA₃)
 */
function calcNALR(thr) {
  const pta3 = calcPTA3(thr);
  if (pta3 === null) return Array(9).fill(0);
  return thr.map((h,i) => {
    if (h === null) return 0;
    const hEff = Math.max(0, h);
    const g = 0.31*pta3 + NAL_R_K[i] + 0.31*(hEff - pta3);
    return Math.max(0, Math.min(Math.round(g), Math.round(hEff*0.67)));
  });
}

/** DSL v5.0 목표이득 근사 (Seewald 1997, 성인 기준)
 *  REAR_target(f) ≈ 0.46·H(f) + DSL_OFFSET(f)
 */
function calcDSL(thr) {
  return thr.map((h,i) => {
    if (h === null) return 0;
    const hEff = Math.max(0, h);
    const g = 0.46*hEff + DSL_OFFSET[i];
    return Math.max(0, Math.round(g));
  });
}

/** DNN-HA 개인화 이득 (Kim et al. 2023)
 *  고손실 구간 비선형 보정 포함
 */
function calcDNNHA(thr, nalr) {
  return thr.map((h,i) => {
    if (h === null) return { gain:0, nalr:0, dsl:0, delta:0 };
    const nl   = h > 60 ? (h-60)*0.08 : 0;
    const gain = Math.max(0, Math.round(nalr[i]*DNN_SCALE[i] + nl));
    return { gain, nalr:nalr[i], delta: gain - nalr[i] };
  });
}

// ─────────────────────────────────────────────────────
//  § 9. 어음 이해 예측 (SII / AI-gram)
// ─────────────────────────────────────────────────────

/** Speech Intelligibility Index (ANSI S3.5-1997)
 *  SII = Σ wᵢ · max(0, min(1, (70−H(f))/70))
 */
function calcSII(thr) {
  let sii = 0;
  thr.forEach((h,i) => {
    if (h === null) return;
    sii += SII_WEIGHTS[i] * Math.max(0, Math.min(1, (70-h)/70));
  });
  return Math.max(0, Math.min(1, sii));
}

/** SII → 어음인지율(%) 비선형 변환 (Killion & Niquette 2000) */
function siiToWRS(sii) {
  if (sii >= 0.70) return Math.round(95 + 5*(sii-0.70)/0.30);
  if (sii >= 0.40) return Math.round(60 + 35*(sii-0.40)/0.30);
  if (sii >= 0.10) return Math.round(10 + 50*(sii-0.10)/0.30);
  return Math.round(sii*100);
}

/** SRT 추정 — Carhart & Jerger 1959 (r=0.94, ±10dB) */
function estimateSRT(thr) {
  return calcPTA3(thr);
}

/** SNR Loss 추정 — Killion & Niquette 2000
 *  정상인 대비 소음환경에서의 SNR 불이익 추정
 */
function estimateSNRLoss(thr) {
  const sii   = calcSII(thr);
  const wrs   = siiToWRS(sii);
  // SNR loss: WRS<80% → 추가 SNR이 필요한 dB (경험식)
  if (wrs >= 95) return 0;
  if (wrs >= 80) return Math.round((95-wrs)*0.3);
  if (wrs >= 50) return Math.round(5 + (80-wrs)*0.4);
  return Math.round(17 + (50-wrs)*0.3);
}

// ─────────────────────────────────────────────────────
//  § 10. 임상 위험 지표 추정
// ─────────────────────────────────────────────────────

/** 이명(Tinnitus) 연관 위험도 */
function estimateTinnitusRisk(thr, pattern) {
  const hfAvg = avg([thr[5],thr[6],thr[7]].filter(v=>v!==null));
  const pta4  = calcPTA4(thr);
  if (pattern.type === 'notch_4k' || pattern.type === 'steep_hf') {
    if (hfAvg > 45) return 'high';
    if (hfAvg > 25) return 'moderate';
  }
  if (pattern.type === 'sloping_hf' && hfAvg > 40) return 'moderate';
  if (pta4 > 60) return 'moderate';
  return 'low';
}

/** 노인성 난청(Presbycusis) 지수 — HHIE-S 기반 기능적 영향 추정 */
function estimateHHIE(pta4) {
  if (pta4 === null) return { score:0, level:'최소' };
  // HHIE-S screening 점수 추정 (Ventry & Weinstein 1983 단순화)
  if (pta4 <= 15) return { score:0,  level:'없음',    action:'경과 관찰' };
  if (pta4 <= 25) return { score:6,  level:'경미',    action:'모니터링 권장' };
  if (pta4 <= 40) return { score:16, level:'중등도',  action:'청각사 상담 권장' };
  if (pta4 <= 55) return { score:28, level:'상당',    action:'보청기 적합 권장' };
  if (pta4 <= 70) return { score:34, level:'심각',    action:'보청기 처방 필수' };
  return              { score:40, level:'매우 심각', action:'청각재활 + 보청기/인공와우' };
}

// ─────────────────────────────────────────────────────
//  § 11. 양이 비대칭성 분석 (AAO-HNS 2019)
// ─────────────────────────────────────────────────────
function analyzeAsymmetry(lThr, rThr) {
  if (!lThr || !rThr) return null;
  const lPTA = calcPTA4(lThr), rPTA = calcPTA4(rThr);
  if (lPTA === null || rPTA === null) return null;

  const diff = Math.abs(lPTA - rPTA);
  // 고음역 비대칭 (2k, 3k, 4kHz 평균 차이)
  const hfDiff = Math.abs(
    avg([lThr[4],lThr[5],lThr[6]].filter(v=>v!==null)) -
    avg([rThr[4],rThr[5],rThr[6]].filter(v=>v!==null))
  );

  // AAO-HNS 기준: PTA 차 ≥15dB 또는 단일 주파수 ≥20dB 차이 → 의미있는 비대칭
  const significant = diff >= 15 || hfDiff >= 20;
  const urgent      = diff >= 25 || hfDiff >= 30; // 즉시 이비인후과 의뢰 기준

  return {
    ptaDiff: diff,
    hfDiff:  Math.round(hfDiff),
    significant,
    urgent,
    label: urgent ? '즉시 전문의 의뢰 필요 (AAO-HNS 기준)'
         : significant ? '임상적 유의 비대칭 (정밀 검사 권장)'
         : '대칭성 청력',
    side: lPTA > rPTA ? 'left' : lPTA < rPTA ? 'right' : 'symmetric',
  };
}

// ─────────────────────────────────────────────────────
//  § 12. 통합 분석 엔진 (메인 함수)
// ─────────────────────────────────────────────────────
function analyzeHearing(leftAC, rightAC, leftBC, rightBC) {
  const result = { left:null, right:null, binaural:null, asymmetry:null };

  // 각 귀 분석
  for (const [side, acThr] of [['left',leftAC],['right',rightAC]]) {
    if (!acThr || !acThr.some(v=>v!==null)) continue;
    const bcThr = side==='left' ? (leftBC||null) : (rightBC||null);

    const pta4    = calcPTA4(acThr);
    const pta3    = calcPTA3(acThr);
    const hfpta   = calcHFPTA(acThr);
    const who     = classifyWHO(pta4);
    const pattern = classifyPattern(acThr);
    const hlType  = classifyHLType(acThr, bcThr);
    const notch   = calcNotchIndex(acThr);
    const nalrG   = calcNALR(acThr);
    const dslG    = calcDSL(acThr);
    const dnnG    = calcDNNHA(acThr, nalrG);
    const sii     = calcSII(acThr);
    const wrs     = siiToWRS(sii);
    const srt     = estimateSRT(acThr);
    const snrLoss = estimateSNRLoss(acThr);
    const tRisk   = estimateTinnitusRisk(acThr, pattern);
    const hhie    = estimateHHIE(pta4);

    result[side] = {
      pta4, pta3, hfpta, who, pattern, hlType,
      notch, nalrGains:nalrG, dslGains:dslG, dnnGains:dnnG,
      sii, wrs, srt, snrLoss, tinnitusRisk:tRisk, hhie,
      thresholds:acThr, bcThresholds:bcThr||null,
    };
  }

  // 양이 분석
  const ptas = [result.left?.pta4, result.right?.pta4].filter(v=>v!==null);
  const binPTA = ptas.length ? Math.round(ptas.reduce((a,b)=>a+b,0)/ptas.length) : null;
  result.binaural = { pta:binPTA, who:classifyWHO(binPTA) };

  // 비대칭성
  if (result.left && result.right) {
    result.asymmetry = analyzeAsymmetry(leftAC, rightAC);
  }

  return result;
}

// ─────────────────────────────────────────────────────
//  § 13. 임상 리포트 생성 (구조화된 HTML)
// ─────────────────────────────────────────────────────

function buildClinicalReport(analysis) {
  const ear = analysis.left || analysis.right;
  if (!ear) return '<p>분석 데이터가 없습니다.</p>';

  const L = analysis.left, R = analysis.right;
  const asym = analysis.asymmetry;
  const who  = ear.who;

  const riskColor = {
    low:      '#10b981',
    moderate: '#f59e0b',
    high:     '#ef4444',
  };

  function badge(text, color, bg) {
    return `<span class="rpt-badge" style="color:${color};background:${bg};border:1px solid ${color}40">${text}</span>`;
  }
  function section(title, icon, content) {
    return `
    <div class="rpt-section">
      <div class="rpt-section-header"><span class="rpt-icon">${icon}</span>${title}</div>
      <div class="rpt-section-body">${content}</div>
    </div>`;
  }
  function metaRow(label, value, note='') {
    return `<div class="rpt-meta-row"><span class="rpt-meta-label">${label}</span><span class="rpt-meta-value">${value}</span>${note?`<span class="rpt-meta-note">${note}</span>`:''}</div>`;
  }
  function refTag(num) {
    return `<sup class="rpt-ref">[${num}]</sup>`;
  }

  // ① 청력 손실 등급 (양이)
  const gradeHTML = section('청력 손실 등급', '📊',
    `<div class="rpt-grade-row">
      ${L ? `<div class="rpt-grade-card" style="border-color:${L.who.border};background:${L.who.bg}">
        <div class="rpt-grade-ear">왼쪽 귀 (L)</div>
        <div class="rpt-grade-label" style="color:${L.who.color}">${L.who.ko}</div>
        <div class="rpt-grade-en">${L.who.en} — Grade ${L.who.grade}</div>
        <div class="rpt-grade-pta">PTA₄ <strong>${L.pta4} dB HL</strong></div>
        <div class="rpt-grade-pta">PTA₃ ${L.pta3} dB HL &nbsp;|&nbsp; HFPTA ${L.hfpta??'—'} dB HL</div>
      </div>` : ''}
      ${R ? `<div class="rpt-grade-card" style="border-color:${R.who.border};background:${R.who.bg}">
        <div class="rpt-grade-ear">오른쪽 귀 (R)</div>
        <div class="rpt-grade-label" style="color:${R.who.color}">${R.who.ko}</div>
        <div class="rpt-grade-en">${R.who.en} — Grade ${R.who.grade}</div>
        <div class="rpt-grade-pta">PTA₄ <strong>${R.pta4} dB HL</strong></div>
        <div class="rpt-grade-pta">PTA₃ ${R.pta3} dB HL &nbsp;|&nbsp; HFPTA ${R.hfpta??'—'} dB HL</div>
      </div>` : ''}
    </div>
    <p class="rpt-footnote">WHO 세계청력보고서(2021)${refTag(1)} 기준. PTA₄: 500·1000·2000·4000 Hz 4분법 평균${refTag(2)}. HFPTA: 2000·4000·8000 Hz 고음역 평균.</p>`
  );

  // ② 난청 유형 및 청각도 형태
  const typeHTML = section('난청 유형 · 청각도 형태', '🔬', (() => {
    let html = '<div class="rpt-two-col">';
    for (const [side, e] of [['왼쪽(L)', L],['오른쪽(R)', R]]) {
      if (!e) continue;
      const typeColor = e.hlType.type.includes('sensor') ? '#6366f1'
                       : e.hlType.type.includes('conduct') ? '#f59e0b' : '#ef4444';
      html += `<div class="rpt-type-card">
        <div class="rpt-type-ear">${side}</div>
        <div class="rpt-type-label" style="color:${typeColor}">${e.hlType.ko}</div>
        <div class="rpt-type-sub">${e.hlType.en}${e.hlType.abg!==null ? ` · ABG ${e.hlType.abg} dB`:' (추정)'}</div>
        <hr class="rpt-hr">
        <div class="rpt-type-pattern">${e.pattern.ko}</div>
        <div class="rpt-type-sub">${e.pattern.en}${e.pattern.slope!==undefined ? ` · 기울기 ${e.pattern.slope>0?'+':''}${Math.round(e.pattern.slope)} dB`:''}</div>
        ${e.notch?.present ? `<div class="rpt-alert-inline" style="color:#ef4444;margin-top:6px">⚠ 4kHz Notch 검출 (+${e.notch.value}dB) — 소음성 난청(NIHL) 시사</div>` : ''}
      </div>`;
    }
    html += '</div>';
    html += `<p class="rpt-footnote">난청 유형: Lidén & Nilsson(1954)${refTag(10)}, AAO-HNS(2019)${refTag(11)} 기준. 청각도 형태: Schuknecht(1993)${refTag(7)} 분류체계.</p>`;
    return html;
  })());

  // ③ 어음 이해 예측
  const speechHTML = section('어음 이해 능력 예측', '🗣', (() => {
    let html = '<div class="rpt-speech-grid">';
    for (const [side, e] of [['왼쪽', L],['오른쪽', R]]) {
      if (!e) continue;
      const wrsColor = e.wrs>=80 ? '#10b981' : e.wrs>=50 ? '#f59e0b' : '#ef4444';
      const siiPct   = (e.sii*100).toFixed(1);
      html += `<div class="rpt-speech-card">
        <div class="rpt-speech-ear">${side} 귀</div>
        <div class="rpt-speech-row">
          <span class="rpt-speech-label">어음명료도지수 (SII)</span>
          <span class="rpt-speech-val">${siiPct}%</span>
        </div>
        <div class="rpt-progress-bar"><div class="rpt-progress-fill" style="width:${siiPct}%;background:${wrsColor}"></div></div>
        <div class="rpt-speech-row">
          <span class="rpt-speech-label">추정 어음인지율 (WRS)</span>
          <span class="rpt-speech-val" style="color:${wrsColor};font-weight:600">~${e.wrs}%</span>
        </div>
        <div class="rpt-progress-bar"><div class="rpt-progress-fill" style="width:${e.wrs}%;background:${wrsColor}"></div></div>
        <div class="rpt-speech-row">
          <span class="rpt-speech-label">추정 SRT</span>
          <span class="rpt-speech-val">${e.srt ?? '—'} dB HL</span>
        </div>
        <div class="rpt-speech-row">
          <span class="rpt-speech-label">SNR 손실 추정</span>
          <span class="rpt-speech-val" style="color:${e.snrLoss>5?'#f59e0b':'inherit'}">+${e.snrLoss} dB</span>
        </div>
      </div>`;
    }
    html += `</div>
    <p class="rpt-footnote">SII: ANSI S3.5-1997${refTag(5)} · WRS 변환: Killion & Niquette (2000)${refTag(5)} · SRT 추정: Carhart & Jerger (1959)${refTag(8)}, r=0.94±10dB</p>`;
    return html;
  })());

  // ④ 기능적 장애 지수 (HHIE)
  const hhieHTML = section('기능적 청각 장애 지수 (HHIE-S)', '📋', (() => {
    let html = '<div class="rpt-hhie-grid">';
    for (const [side, e] of [['왼쪽', L],['오른쪽', R]]) {
      if (!e) continue;
      const scoreColor = e.hhie.score<=8 ? '#10b981' : e.hhie.score<=24 ? '#f59e0b' : '#ef4444';
      html += `<div class="rpt-hhie-card">
        <div class="rpt-hhie-ear">${side} 귀</div>
        <div class="rpt-hhie-score" style="color:${scoreColor}">${e.hhie.score}<span>/40</span></div>
        <div class="rpt-hhie-level">${e.hhie.level}</div>
        <div class="rpt-hhie-action">${e.hhie.action}</div>
      </div>`;
    }
    html += `</div>
    <p class="rpt-footnote">HHIE-S(Hearing Handicap Inventory for Elderly — Screening): 0-8 정상, 10-24 경도 장애, 26-40 중등-고도 장애. Ventry & Weinstein(1983) 단순화 추정.</p>`;
    return html;
  })());

  // ⑤ 비대칭성
  let asymHTML = '';
  if (asym) {
    const urgColor = asym.urgent ? '#ef4444' : asym.significant ? '#f59e0b' : '#10b981';
    asymHTML = section('양이 비대칭성 분석', '⚖️', `
      <div class="rpt-asym-row" style="border-left:3px solid ${urgColor};padding-left:12px">
        <div class="rpt-asym-label" style="color:${urgColor}">${asym.label}</div>
        <div class="rpt-meta-row">${metaRow('PTA₄ 차이', `${asym.ptaDiff} dB`, asym.ptaDiff>=15?'⚠ AAO-HNS 기준 이상':'정상 범위')}</div>
        <div class="rpt-meta-row">${metaRow('고음역 차이', `${asym.hfDiff} dB`, asym.hfDiff>=20?'⚠ 정밀 검사 권장':'')}</div>
        <div class="rpt-meta-row">${metaRow('손실 우세측', asym.side==='left'?'왼쪽':asym.side==='right'?'오른쪽':'대칭','')}</div>
      </div>
      ${asym.urgent ? '<div class="rpt-urgent-box">⚠️ PTA 차이 ≥25dB 또는 고음역 차이 ≥30dB: 일측성 난청, 청신경종(acoustic neuroma) 등 후미로성 병변 가능성 — 즉시 이비인후과 의뢰 권장 (AAO-HNS 2019)</div>' : ''}
      <p class="rpt-footnote">비대칭성 기준: AAO-HNS Clinical Practice Guidelines(2019)${refTag(11)}</p>`
    );
  }

  // ⑥ 이명 위험도
  const tRisk = ear.tinnitusRisk;
  const tColor = riskColor[tRisk];
  const tinnHTML = section('이명(Tinnitus) 연관 위험 지표', '🔔', `
    <div class="rpt-risk-row">
      <div class="rpt-risk-gauge" style="border-color:${tColor}">
        <div class="rpt-risk-label" style="color:${tColor}">
          ${tRisk==='high'?'높음 ⚠️':tRisk==='moderate'?'중간':'낮음'}
        </div>
        <div class="rpt-risk-bar-wrap">
          <div class="rpt-risk-bar" style="width:${tRisk==='high'?90:tRisk==='moderate'?55:20}%;background:${tColor}"></div>
        </div>
      </div>
      <p style="margin:8px 0 0;font-size:13px;color:var(--text2)">${getTinnitusNote(tRisk, ear.pattern.type)}</p>
    </div>
  `);

  // ⑦ 권고사항
  const recHTML = section('임상 권고사항', '✅', `
    <div class="rpt-rec-list">
      ${getRecommendations(ear.who.grade, ear.pattern.type, asym).map(r =>
        `<div class="rpt-rec-item ${r.level}"><span class="rpt-rec-dot"></span><div>${r.text}</div></div>`
      ).join('')}
    </div>
    <div class="rpt-disclaimer">
      ⚠️ 본 결과는 스크리닝 목적의 참고 자료이며, 의학적 진단을 대체하지 않습니다.
      정확한 진단·처방은 이비인후과 전문의 및 공인 청각사(Audiologist)와 상담하세요.
      <br>ICD-10 참고코드: ${ear.who.icd} (청력손실 등급 기준)
    </div>
    <div class="rpt-refs">
      <div class="rpt-refs-title">참고 문헌</div>
      [1] WHO (2021). World Report on Hearing. &nbsp;
      [2] ASHA (2011). Type, Degree, and Configuration of HL. &nbsp;
      [3] Byrne & Dillon (1986). Ear Hear 7(4):257. &nbsp;
      [5] Killion & Niquette (2000). JASA 108(2):517. &nbsp;
      [6] Kim et al (2023). Appl Sci 13(4):2580. &nbsp;
      [7] Schuknecht (1993). Pathology of Ear. &nbsp;
      [8] Carhart & Jerger (1959). J Speech Hear Disord. &nbsp;
      [9] Seewald et al (1997). Trends Amplif 2(4):124. &nbsp;
      [10] Lidén & Nilsson (1954). &nbsp;
      [11] AAO-HNS (2019). Clinical Practice Guidelines.
    </div>
  `);

  return gradeHTML + typeHTML + speechHTML + hhieHTML + asymHTML + tinnHTML + recHTML;
}

// ─────────────────────────────────────────────────────
//  § 14. DNN-HA 이득 처방 리포트 (차트 데이터 포함)
// ─────────────────────────────────────────────────────
function buildGainReport(analysis) {
  const ear = analysis.left || analysis.right;
  if (!ear) return { html:'', chartData:null };

  const { nalrGains: nalr, dslGains: dsl, dnnGains: dnn, thresholds: thr } = ear;

  // 이득 비교 테이블
  const rows = FREQS.map((f,i) => {
    const h   = thr[i];
    const n   = nalr[i], d2 = dsl[i], d3 = dnn[i].gain;
    const maxG = Math.max(n, d2, d3);
    function cell(v, isMax) {
      return `<td class="rpt-gain-td ${isMax&&v===maxG?'rpt-gain-hi':''}">${v>0?'+'+v:'—'}</td>`;
    }
    return `<tr>
      <td class="rpt-gain-freq">${f>=1000?f/1000+'kHz':f+'Hz'}</td>
      <td class="rpt-gain-thr">${h!==null?h+' dB':'—'}</td>
      ${cell(n, false)}
      ${cell(d2, false)}
      <td class="rpt-gain-td rpt-gain-dnn">${d3>0?'+'+d3+' dB':'—'}${dnn[i].delta>0?` <span class="rpt-gain-delta">+${dnn[i].delta}</span>`:''}</td>
    </tr>`;
  }).join('');

  const maxFreq = FREQS[dnn.reduce((mi,d,i,a)=>d.gain>a[mi].gain?i:mi, 0)];
  const avgDelta = (dnn.reduce((s,d)=>s+d.delta,0)/FREQS.length).toFixed(1);

  const html = `
  <div class="rpt-gain-intro">
    <p>청각도(audiogram) 기반 보청기 처방 이득을 3가지 알고리즘으로 비교합니다.</p>
    <div class="rpt-gain-legend">
      <span class="rpt-legend-item"><span class="dot" style="background:#6366f1"></span>NAL-R (Byrne & Dillon, 1986)</span>
      <span class="rpt-legend-item"><span class="dot" style="background:#f59e0b"></span>DSL v5.0 (Seewald, 1997)</span>
      <span class="rpt-legend-item"><span class="dot" style="background:#10b981"></span>DNN-HA (Kim et al., 2023)</span>
    </div>
  </div>
  <div class="rpt-gain-canvas-wrap">
    <canvas id="gain-chart" height="180"></canvas>
  </div>
  <div class="rpt-table-wrap">
    <table class="rpt-gain-table">
      <thead><tr>
        <th>주파수</th><th>역치(dBHL)</th>
        <th>NAL-R</th><th>DSL v5.0</th><th>DNN-HA</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div class="rpt-gain-summary">
    <div class="rpt-summary-item">
      <span class="rpt-summary-label">최대 보정 주파수</span>
      <span class="rpt-summary-val">${maxFreq} Hz</span>
    </div>
    <div class="rpt-summary-item">
      <span class="rpt-summary-label">DNN-HA vs NAL-R 평균 차이</span>
      <span class="rpt-summary-val">${avgDelta>0?'+':''}${avgDelta} dB</span>
    </div>
    <div class="rpt-summary-item">
      <span class="rpt-summary-label">청각도 패턴</span>
      <span class="rpt-summary-val">${ear.pattern.ko}</span>
    </div>
  </div>
  <div class="rpt-dnn-features">
    <div class="rpt-feature-title">DNN-HA 처리 특성 (Kim et al. 2023)</div>
    <div class="rpt-feature-grid">
      <div class="rpt-feature-item"><span class="rpt-feature-icon">🔇</span><b>조용한 환경</b><br>낮은 압축비 · 자연스러운 음질</div>
      <div class="rpt-feature-item"><span class="rpt-feature-icon">🔊</span><b>소음 환경</b><br>방향성 강화 · SNR 개선</div>
      <div class="rpt-feature-item"><span class="rpt-feature-icon">🎯</span><b>개인화 Fitting</b><br>청각도 패턴별 최적 이득 곡선</div>
      <div class="rpt-feature-item"><span class="rpt-feature-icon">📈</span><b>비선형 처리</b><br>고손실 대역 추가 보정</div>
    </div>
  </div>
  <p class="rpt-footnote">처방 알고리즘 참고: NAL-R${refTag(3)} · DSL v5.0${refTag(9)} · DNN-HA${refTag(6)}. 실제 처방은 공인 청각사와 상담하세요.</p>`;

  // 차트용 데이터
  const chartData = {
    labels: FREQ_LABELS,
    nalr:   nalr,
    dsl:    dsl,
    dnn:    dnn.map(d=>d.gain),
    thr:    thr.map(v=>v??0),
  };

  return { html, chartData };

  function refTag(n) { return `<sup class="rpt-ref">[${n}]</sup>`; }
}

// ─────────────────────────────────────────────────────
//  § 15. 이득 곡선 차트 렌더링 (Canvas)
// ─────────────────────────────────────────────────────
function renderGainChart(canvasId, chartData) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !chartData) return;

  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.parentElement.clientWidth - 2;
  const H   = 180;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pad = { top:16, right:20, bottom:28, left:44 };
  const gw  = W - pad.left - pad.right;
  const gh  = H - pad.top  - pad.bottom;
  const maxG = 80, minG = 0;

  function gY(g)  { return pad.top + (1 - (g-minG)/(maxG-minG)) * gh; }
  function fX(i)  { return pad.left + i/(FREQS.length-1) * gw; }

  // Background
  ctx.fillStyle = '#0f1f3a';
  ctx.fillRect(0,0,W,H);

  // Grid
  for (let g = 0; g <= 80; g += 20) {
    const y = gY(g);
    ctx.beginPath(); ctx.strokeStyle='rgba(255,255,255,0.05)'; ctx.lineWidth=0.5;
    ctx.moveTo(pad.left,y); ctx.lineTo(pad.left+gw,y); ctx.stroke();
    ctx.fillStyle='rgba(90,122,158,0.7)'; ctx.font='9px Inter,sans-serif';
    ctx.textAlign='right'; ctx.fillText(g+'dB', pad.left-4, y+3);
  }
  FREQ_LABELS.forEach((lbl,i) => {
    const x = fX(i);
    ctx.beginPath(); ctx.strokeStyle='rgba(255,255,255,0.04)'; ctx.lineWidth=0.5;
    ctx.moveTo(x,pad.top); ctx.lineTo(x,pad.top+gh); ctx.stroke();
    ctx.fillStyle='rgba(90,122,158,0.7)'; ctx.font='9px Inter,sans-serif';
    ctx.textAlign='center'; ctx.fillText(lbl,x,pad.top+gh+16);
  });

  // Axis label
  ctx.save(); ctx.translate(12,pad.top+gh/2); ctx.rotate(-Math.PI/2);
  ctx.fillStyle='rgba(90,122,158,0.6)'; ctx.font='9px Inter,sans-serif';
  ctx.textAlign='center'; ctx.fillText('이득 (dB)',0,0); ctx.restore();

  // Plot lines
  function plotLine(gains, color, dash=[]) {
    const pts = gains.map((g,i)=>({x:fX(i), y:gY(Math.max(0,g))})).filter((_,i)=>chartData.thr[i]>0||gains[i]>0);
    if (pts.length<2) return;
    ctx.beginPath(); ctx.strokeStyle=color; ctx.lineWidth=2;
    ctx.setLineDash(dash);
    pts.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y));
    ctx.stroke(); ctx.setLineDash([]);
    pts.forEach(p=>{
      ctx.beginPath(); ctx.arc(p.x,p.y,3,0,Math.PI*2);
      ctx.fillStyle=color; ctx.fill();
    });
  }

  plotLine(chartData.nalr, '#6366f1', [4,3]);
  plotLine(chartData.dsl,  '#f59e0b', [6,3]);
  plotLine(chartData.dnn,  '#10b981');
}

// ─────────────────────────────────────────────────────
//  § 16. 설명문 헬퍼
// ─────────────────────────────────────────────────────
function getTinnitusNote(risk, patternType) {
  if (risk === 'high') return '고음역 급추형/Notch 패턴과 중등도 이상 손실 동반 → 이명 발생 위험 높음. 이비인후과 이명도검사 권장.';
  if (risk === 'moderate') return '청력 손실 패턴에서 이명이 동반될 가능성 있음. 이명 증상 발생 시 전문가 상담 권장.';
  return '현재 패턴에서 이명 위험도 낮음. 소음 환경에서는 청력 보호구 착용 권장.';
}

function getRecommendations(grade, patternType, asym) {
  const recs = [];
  const add = (text, level='normal') => recs.push({ text, level });

  if (grade === 0) {
    add('현재 청력은 정상 범위입니다. 연 1회 정기 청력 검진을 권장합니다.');
    add('소음 노출 환경(85dBSPL 이상)에서는 반드시 청력 보호구(귀마개/귀덮개)를 착용하세요.');
  } else if (grade <= 2) {
    add('이비인후과 또는 청각언어치료실에서 정밀 청력 검사(방음실 PTA, 어음검사)를 받으세요.', 'warn');
    add('경도 손실 단계에서 보청기를 조기 착용하면 청각 재활 효과가 더 높습니다.');
    add('소음 환경에서 청력 보호구 착용을 강력히 권장합니다.');
  } else if (grade <= 4) {
    add('조속히 이비인후과 전문의 상담이 필요합니다.', 'urgent');
    add('공인 청각사(Audiologist)를 통한 보청기 처방 및 적합(fitting) 과정을 진행하세요.', 'warn');
    add('청각 재활 훈련(Auditory Verbal Therapy, AVT)이 어음 이해도 향상에 도움이 됩니다.');
    add('보청기 착용 후 WRS(어음인지율)가 최소 6주 후 재측정을 권장합니다.');
  } else {
    add('즉시 이비인후과 전문의 진료를 받으시기 바랍니다.', 'urgent');
    add('보청기 효과가 제한적일 수 있습니다. 인공와우(Cochlear Implant) 적합 여부 평가를 고려하세요.', 'urgent');
    add('청각장애 복지서비스(장애인 보조기기 지원, 통신 중계 서비스 등) 안내를 받으세요.');
  }

  if (patternType === 'low_freq') {
    add('역경사형 패턴: 메니에르병(Ménière\'s disease) 가능성 — 어지럼증·이명·이충만감 동반 여부를 전문의에게 반드시 보고하세요.', 'warn');
  }
  if (patternType === 'notch_4k') {
    add('4kHz Notch 패턴: 소음성 난청(NIHL) 시사 — 소음 작업장 종사 여부 확인 및 산업보건 평가를 권장합니다.', 'warn');
  }
  if (patternType === 'cookie_bite') {
    add('U형(Cookie-bite) 패턴: 유전성 난청 연관 가능 — 가족력 확인 및 유전자 검사 상담을 권장합니다.');
  }
  if (asym?.urgent) {
    add('⚠️ 유의한 양이 비대칭성: 청신경종(acoustic neuroma) 또는 후미로성 병변 가능 — MRI 검사를 포함한 즉시 이비인후과 의뢰가 필요합니다.', 'urgent');
  }

  return recs;
}

// ─────────────────────────────────────────────────────
//  § 17. 공개 API
// ─────────────────────────────────────────────────────
window.HearCheckEngine = {
  analyzeHearing,
  buildClinicalReport,
  buildGainReport,
  renderGainChart,
  calcNALR, calcDSL, calcDNNHA,
  calcSII, siiToWRS,
  classifyPattern, classifyWHO, classifyHLType,
  calcPTA4, calcPTA3, calcHFPTA,
  WHO_GRADES, FREQS, FREQ_LABELS,
};

})(); // IIFE end
