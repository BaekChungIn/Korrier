# Korrier — Korea in your Carrier

실시간 한국 트렌드(핫플·뷰티·패션·콘서트·유행어)와 여행 일정 앱.
**GitHub Pages(앱 화면) + Supabase(로그인·DB·Edge Function)** 구조이며, 홈 화면에 추가하면 앱처럼 실행됩니다(PWA).

짬타이거와 **같은 Supabase 프로젝트**를 써도 섞이지 않도록 모든 테이블·함수 이름이 `korrier_` 로 시작합니다.
로그인 계정은 공용이라 짬타이거 계정으로도 바로 로그인됩니다. Korrier의 "데이터 삭제"는 Korrier 데이터만 지우고 계정 자체는 지우지 않습니다.

```
GitHub Pages (공개)                    Supabase (같은 프로젝트)
├ index.html / app.js / ...   ──→      ├ Auth (회원가입·로그인·비밀번호 찾기)
├ config.js (공개 키만)                ├ korrier_profiles / korrier_trips (RLS로 본인만)
├ manifest + sw.js (앱 설치)           ├ korrier_cache / korrier_usage (서버 전용)
                                       └ Edge Function: korrier-api
                                           └ 비밀 키 보관: Gemini · 네이버 · 카카오
```

---

## 설정 순서 (처음 한 번)

### 1. 테이블 만들기
Supabase 대시보드 → **SQL Editor** → `supabase/migrations/20261119000000_korrier.sql` 내용을 통째로 붙여넣고 **Run**.
(여러 번 실행해도 안전하고, 짬타이거 테이블은 건드리지 않습니다.)

### 2. Edge Function 올리기
**방법 A — 대시보드에서**
1. **Edge Functions → Deploy a new function → Via Editor**
2. 이름: `korrier-api`
3. `supabase/functions/korrier-api/index.ts` 내용을 붙여넣고 Deploy
4. 함수 설정에서 **Verify JWT 옵션을 끄기** (함수 안에서 직접 로그인 확인을 합니다)

**방법 B — CLI**
```bash
supabase login
supabase link --project-ref <프로젝트-ref>
supabase functions deploy korrier-api --no-verify-jwt
```

### 3. 비밀 키 넣기
**Edge Functions → Secrets** 에 추가:

| 이름 | 필수 | 발급처 |
|---|---|---|
| `GEMINI_API_KEY` | 필수 | https://aistudio.google.com/apikey |
| `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` | 필수 | https://developers.naver.com/apps → 사용 API에 **검색**, **데이터랩(검색어트렌드)** 추가. 웹 서비스 URL에 GitHub Pages 주소 입력 |
| `KAKAO_REST_API_KEY` | 필수 | https://developers.kakao.com → 내 애플리케이션 → 앱 키의 REST API 키 (새 앱은 카카오맵 사용 설정을 켜야 할 수 있어요) |
| `ALLOWED_ORIGIN` | 권장 | `https://<깃허브아이디>.github.io` (다른 사이트에서 함수 호출 차단) |
| `TREND_CACHE_MINUTES` | 선택 | 트렌드 재검색 간격(분), 기본 10 |
| `X_BEARER_TOKEN` | 선택 | X API 유료 플랜 (X 언급량을 순위에 반영) |
| `GOOGLE_TRANSLATE_API_KEY` | 선택 | 없으면 Gemini가 번역 |
| `GEMINI_MODEL` | 선택 | 기본 `gemini-2.5-flash` |

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` 는 Supabase가 자동으로 넣어줍니다.
(새 API 키 체계만 쓰는 프로젝트라 서비스 키가 자동으로 안 들어오면 `KORRIER_SERVICE_KEY` 에 secret 키를 넣어주세요.)

### 4. 로그인 메일 링크 주소 허용
**Authentication → URL Configuration → Redirect URLs** 에 `https://<깃허브아이디>.github.io/<저장소이름>/` 추가.
짬타이거가 쓰는 **Site URL은 바꾸지 말고** Redirect URLs에만 추가하세요. (회원가입 확인 메일, 비밀번호 찾기 메일이 Korrier로 돌아오게 됩니다.)

### 5. `config.js` 채우기
```js
SUPABASE_URL: 'https://xxxx.supabase.co',          // Project Settings → API
SUPABASE_ANON_KEY: 'eyJ... 또는 sb_publishable_...', // anon / publishable 키 (공개 OK)
GOOGLE_MAPS_API_KEY: 'AIza...',                     // 아래 6번
```
비밀 키(Gemini·네이버·카카오)는 **절대 config.js에 넣지 마세요.** 이 파일은 GitHub에 공개됩니다.

### 6. 구글 지도 키
Google Cloud Console → **Maps JavaScript API** 사용 설정 → API 키 생성 →
키 제한: **HTTP 리퍼러** = `https://<깃허브아이디>.github.io/*`
(키가 없거나 잘못되면 앱이 자동으로 OpenStreetMap 지도로 바뀝니다.)

### 7. GitHub Pages 배포
1. GitHub에 새 저장소 생성 (예: `korrier`)
2. 이 폴더의 파일 전체를 올리기 (웹에서 드래그&드롭 가능, `.nojekyll` 포함)
3. **Settings → Pages → Deploy from a branch → main / (root)**
4. 몇 분 뒤 `https://<깃허브아이디>.github.io/korrier/` 에서 열림

### 8. 휴대폰에 앱으로 설치
- **안드로이드(Chrome):** 앱 상단의 "설치" 배너 또는 메뉴 → 앱 설치
- **아이폰(Safari):** 공유 버튼 → 홈 화면에 추가

---

## 업데이트할 때
파일을 고쳐서 GitHub에 다시 올리면 됩니다. 설치된 앱에 바로 반영되게 하려면 `sw.js` 맨 위 `VERSION` 숫자를 올려주세요 (예: `korrier-v2.0.1`).
Edge Function을 고쳤다면 2번처럼 다시 Deploy.

## 실제로 동작하는 방식
- **트렌드 후보:** Gemini가 구글 검색을 실제로 실행해 최근 7일 X·인스타그램·네이버·유튜브의 공개 글에서 15개를 찾고, 구글 트렌드 한국 급상승 검색어도 참고
- **순위:** 후보마다 네이버 데이터랩 검색량, 네이버 블로그·뉴스 최근 7일 수(+선택 X 언급량)를 조회해 점수로 정렬 → 상위 10개. 화면에 순위 근거 표시
- **캐시:** 결과는 `korrier_cache`에 저장돼 모든 사용자가 공유, `TREND_CACHE_MINUTES` 마다 재검색 (동시 요청이 와도 한 번만 검색)
- **AI 여론 요약:** 로그인 사용자만, 1인 시간당 30회 제한 (비용 보호)
- **일정 공유:** 링크(id)를 아는 사람만 볼 수 있고, 목록 조회는 불가

## 한계
- 인스타그램·X는 약관상 직접 크롤링하지 않고, 구글에 노출된 공개 게시물을 검색합니다. X 언급량 수치는 X API 유료 키가 있을 때만 반영됩니다.
- 무신사·에이블리는 공개 랭킹 API가 없어 웹 검색 + 네이버 쇼핑 데이터로 보완합니다.
- 구글 지도는 한국에서 도보·자동차 길찾기를 지원하지 않아 카카오 길찾기 버튼을 함께 제공합니다.
- Gemini 구글 검색 기능은 무료 한도를 넘으면 과금됩니다.

## 파일 구조
```
index.html, app.js, i18n.js(7개 언어), icons.js(픽토그램)   앱 화면
config.js                                                  공개 설정값
manifest.webmanifest, sw.js, icons/, logo.svg              앱 설치(PWA)
supabase/migrations/20261119000000_korrier.sql             테이블·보안 정책
supabase/functions/korrier-api/index.ts                    서버 기능 (Edge Function)
```
