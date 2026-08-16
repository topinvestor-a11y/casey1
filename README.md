# 우리 근무표 — Cloudflare 배포용

Cloudflare Worker(정적 파일 + API 통합) + D1(데이터베이스)로 이루어진 실제
배포용 프로젝트입니다. 예전에는 Pages + Pages Functions로 나뉘어 있었지만,
Cloudflare가 2026년부터 새 프로젝트에 권장하는 방식대로 **하나의 Worker가
화면과 API를 모두 처리**하는 구조로 정리했어요. (Pages와 별도 Functions로
나뉘어 있으면 최근 대시보드에서 "Workers-specific command in a Pages
project" 같은 충돌이 종종 발생해서, 아예 그 문제가 생기지 않는 구조로
바꿨습니다.)

## 준비물
- Node.js 18 이상
- Cloudflare 계정 (무료 플랜으로 충분)
- 터미널 사용 가능 환경 (또는 GitHub 연동 — 아래 "터미널 없이" 참고)

## 1. 설치

```bash
npm install
npm install -g wrangler   # 이미 있다면 생략
wrangler login            # 브라우저가 열리고 Cloudflare 계정 로그인
```

## 2. D1 데이터베이스 생성

```bash
wrangler d1 create wt-app-db
```

출력된 `database_id` 값을 `wrangler.jsonc`의 `REPLACE_WITH_YOUR_DATABASE_ID`
자리에 붙여넣으세요.

## 3. 초기 데이터 넣기

```bash
npm run db:migrate:remote
```

`migrations/0001_init.sql`에 스키마 + 초기 데이터(직원 34명, 근무 코드표,
좌석별 근무 패턴, 8/24~9/6 근무표)가 모두 들어 있어요.

## 4. 로컬에서 확인 (선택)

```bash
npm run dev:full
```

`http://localhost:5173`에서 확인할 수 있어요.

## 5. 배포

```bash
npm run deploy
```

완료되면 `https://wt-app.<계정이름>.workers.dev` 같은 주소가 나옵니다.
이후 배포는 `npm run deploy` 한 줄이면 됩니다.

## 6. 회사 도메인 연결 (선택)

Cloudflare 대시보드 → **Workers & Pages** → `wt-app` → **Custom domains**
에서 원하는 도메인을 추가하면 끝이에요.

---

## 터미널 없이 배포하기 (GitHub 연동)

1. 이 프로젝트 전체를 GitHub 저장소에 올리기 (웹 화면 드래그 앤 드롭으로
   가능 — git 명령어 불필요)
2. Cloudflare 대시보드 → **Workers & Pages** → **Create application** →
   **Import a repository** (또는 **Workers** 탭에서 Git 연동 선택)
3. 방금 만든 저장소 선택
4. Build command: `npm run build` / Deploy command은 비워두거나
   `npx wrangler deploy`로 자동 인식되도록 둡니다
5. D1 데이터는 대시보드의 **Storage & Databases → D1 → Console** 탭에서
   `migrations/0001_init.sql` 내용을 붙여넣고 **Execute**로 넣을 수 있어요

> **주의**: 대시보드에서 프로젝트를 만들 때 "Pages"가 아니라 "Workers"
> 계열로 만들어야 이 프로젝트 구조(`wrangler.jsonc` + `src/worker.js`)와
> 맞아요. 예전에 "Pages" 프로젝트로 이미 만들어두셨다면, 그 프로젝트는
> 삭제하고 새로 "Workers" 쪽에서 Git 연동을 다시 잡아주세요.

---

## 구조 설명

```
src/
  worker.js         진입점 — /api/* 는 직접 처리, 나머지는 정적 파일(dist) 서빙
  api/
    bootstrap.js         최초 로딩 시 필요한 데이터 전체 조회
    requests.js          교환 요청 생성/목록
    requestActions.js    교환 요청 수락·거절·취소 (수락 시 실제로 근무를 맞바꿈)
    generateNextWeek.js  다음 주 근무표 자동 생성 (좌석 순환 규칙)
  App.jsx / api.js / index.css / main.jsx   화면 (React + Vite)

migrations/0001_init.sql   D1 스키마 + 초기 데이터
wrangler.jsonc              Cloudflare 설정 (Worker 진입점, 정적 파일, D1 바인딩)
```

## 자동 생성(좌석 순환) 로직 요약
- A조(좌석 1~7, 9~19)와 B조(좌석 20~35)가 각자 그룹 안에서 매주 한 칸씩
  순환합니다. (8번 좌석은 원래도 근무가 배정된 적 없는 빈 자리라 제외)
- 좌석별 요일 근무 패턴(`seat_template` 테이블)은 고정이고, 사람만 자리를
  옮겨 다니는 구조예요.
- "전체 근무표" 탭에서 마지막 주차를 보고 있을 때 다음 주 데이터가 없으면
  자동 생성 버튼이 나타납니다.
- 직원이 퇴사하고 그 자리를 신규 입사자가 그대로 물려받는 경우엔, 앱 안의
  **"관리"** 탭에서 처리할 수 있어요 (비밀번호 필요 — 아래 "관리자 비밀번호
  설정" 참고). 자리 개수 자체가 늘거나 줄어드는 경우는 이 기능 범위 밖이라,
  근무표 엑셀을 다시 받아서 좌석 패턴을 새로 계산해야 해요.

## 관리자 비밀번호 설정 (필수)

"관리" 탭의 자리 교체 기능을 쓰려면 비밀번호를 하나 설정해야 해요.

```bash
wrangler secret put ADMIN_PIN
```

실행하면 값을 입력하라고 나와요 — 원하는 비밀번호를 입력하세요. 이 값은
Cloudflare에만 저장되고 코드에는 남지 않아요. 터미널 없이 대시보드에서
하려면: Workers & Pages → 프로젝트 → **Settings → Variables and Secrets**
→ **Add** → 이름 `ADMIN_PIN`, 값에 원하는 비밀번호, **Encrypt** 체크 →
저장.

설정 안 하면 "관리" 탭에서 비밀번호를 넣어도 "관리자 기능이 아직 설정되지
않았어요" 에러가 나요.

## 참고
- 로그인 없이 이름을 선택하는 방식이라, 외부에 그대로 공개하면 아무나
  접근할 수 있어요. 사내용으로만 쓰실 거면 Cloudflare Access(무료, Zero
  Trust → Access → Applications)로 감싸는 걸 권장해요.
- 여러 사람이 동시에 써도 데이터는 D1에 저장되어 항상 공유되고, 화면은
  30초마다 자동으로 최신 상태를 다시 불러와요.
