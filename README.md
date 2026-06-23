# HearCheck — AI 청력 보조 검사 PWA

## 폴더 구조
```
public/
├── index.html      # 메인 앱 쉘
├── style.css       # 디자인 시스템
├── app.js          # 청력 검사 엔진 + AI 분석
├── sw.js           # Service Worker (오프라인 캐시)
├── manifest.json   # PWA 매니페스트
└── icons/
    ├── icon-192.png
    └── icon-512.png
```

## 배포 방법

### 방법 1: Netlify (권장, 무료)
1. https://netlify.com 가입
2. 대시보드 → "Add new site" → "Deploy manually"
3. `public/` 폴더 전체를 드래그&드롭
4. 배포 완료! HTTPS URL 자동 발급

### 방법 2: Vercel
1. https://vercel.com 가입
2. `vercel.json` 루트에 추가:
   ```json
   { "public": "public" }
   ```
3. `vercel` CLI 또는 Git 연동으로 배포

### 방법 3: GitHub Pages
1. `public/` 내용을 GitHub 리포지토리 루트에 업로드
2. Settings → Pages → Branch: main / (root)
3. HTTPS URL 자동 발급

### 방법 4: 로컬 테스트
```bash
# Python
cd public && python3 -m http.server 8080

# Node.js
npx serve public
```
브라우저에서 http://localhost:8080 접속

## Anthropic API 키 설정

현재 앱은 Claude.ai 환경(API 키 자동 처리)을 위해 설계되었습니다.
독립 배포 시 API 키를 직접 사용하려면 `app.js`의 fetch 헤더에 추가:

```js
headers: {
  'Content-Type': 'application/json',
  'x-api-key': 'YOUR_ANTHROPIC_API_KEY',    // 추가
  'anthropic-version': '2023-06-01',          // 추가
}
```

⚠️ 프로덕션에서는 API 키를 클라이언트에 노출하지 말고,
   서버사이드 프록시(Netlify Functions, Vercel Edge Functions)를 사용하세요.

## PWA 기능
- ✅ 오프라인 작동 (Service Worker 캐시)
- ✅ 홈 화면 설치 (Android Chrome, iOS Safari)
- ✅ 전체화면 모드 (standalone)
- ✅ 스플래시 스크린 자동 생성
- ✅ Safe area 지원 (노치 디바이스)
- ✅ 모션 감소 모드 지원 (prefers-reduced-motion)

## 기술 스택
- **audiometry-new**: 순음 청력검사 역치 측정 알고리즘
- **DNN-HA**: ISO 226 + NAL-R 기반 보정 이득 추정
- **Web Audio API**: 크로스 플랫폼 오디오 재생 (MediaPipe 대체)
- **Claude API**: AI 청각 분석 및 DNN-HA 보정 해설
