// =====================================================================
// Korrier Edge Function (Supabase / Deno) — 파일 하나로 동작
//   - 실시간 트렌드: 네이버 뉴스·블로그 최근 7일 실제 글 + 구글 트렌드 RSS → AI(Groq 무료, OpenAI 호환)로 정리
//   - 순위: 네이버 데이터랩 검색량 + 네이버 블로그/뉴스 최근 언급량 + (선택) X 언급량
//   - 이미지/최저가: 네이버 이미지·쇼핑 / 위치: 카카오 로컬
//   - 번역: Google Cloud Translation(선택) 또는 AI
//   - AI 여론 요약 (로그인 사용자, 시간당 30회 제한)
// 배포: supabase functions deploy korrier-api --no-verify-jwt
// =====================================================================

const env = (k: string) => Deno.env.get(k) ?? "";
const SB_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("KORRIER_SERVICE_KEY") || env("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = env("SUPABASE_ANON_KEY") || SERVICE_KEY;

const CFG = {
  // AI: OpenAI 호환 API (기본 Groq 무료 플랜). 다른 곳을 쓰려면 LLM_BASE_URL만 바꾸면 됨
  llmBase: (env("LLM_BASE_URL") || "https://api.groq.com/openai/v1").replace(/\/$/, ""),
  llmKey: env("LLM_API_KEY") || env("GROQ_API_KEY"),
  // 무료 한도는 모델마다 따로 → 한 모델이 한도에 걸리면 다음 모델로 자동 전환
  llmModels: (env("LLM_MODELS") || "openai/gpt-oss-120b,meta-llama/llama-4-scout-17b-16e-instruct,llama-3.3-70b-versatile,openai/gpt-oss-20b").split(",").map((x: string) => x.trim()).filter(Boolean),
  llmFastModels: (env("LLM_FAST_MODELS") || "openai/gpt-oss-20b,meta-llama/llama-4-scout-17b-16e-instruct,llama-3.1-8b-instant,llama-3.3-70b-versatile").split(",").map((x: string) => x.trim()).filter(Boolean),
  llmSearchModel: env("LLM_SEARCH_MODEL") || "groq/compound",    // 네이버 키가 없을 때 웹 검색용
  naverId: env("NAVER_CLIENT_ID"),
  naverSecret: env("NAVER_CLIENT_SECRET"),
  // 2026-07-31부터 신규 키는 네이버 클라우드 NAVER API HUB에서만 발급 → 기본값 hub. 예전 개발자센터 키면 legacy
  naverProvider: (env("NAVER_PROVIDER") || "hub").toLowerCase(),
  kakaoRest: env("KAKAO_REST_API_KEY"),
  googleTranslateKey: env("GOOGLE_TRANSLATE_API_KEY"),
  xBearer: env("X_BEARER_TOKEN"),
  trendTtlMin: Number(env("TREND_CACHE_MINUTES")) || 180,
  maxItems: 50,
  allowedOrigin: env("ALLOWED_ORIGIN") || "*",
};
const HAS_NAVER = !!(CFG.naverId && CFG.naverSecret);

/* ---------------- 공통 유틸 ---------------- */
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripTags = (s = "") => String(s).replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").trim();
const isHttpUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\/[^\s]+$/i.test(u);
const seoulDate = (offsetDays = 0) => new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const hashId = (s: string) => {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822519); }
  return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)).slice(0, 12);
};

async function fetchJson(url: string, opts: RequestInit = {}, timeoutMs = 20000): Promise<any> {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && (data.error?.message || data.errorMessage || data.message || data.msg)) || `HTTP ${res.status}`;
    throw new HttpError(res.status >= 500 ? 502 : res.status, `${new URL(url).host}: ${msg}`);
  }
  return data;
}

async function mapLimit<T, R>(arr: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(arr.length).fill(null);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) {
      const k = i++;
      try { out[k] = await fn(arr[k], k); } catch { out[k] = null; }
    }
  }));
  return out;
}

function parseJsonLoose(text: string): any {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const first = t.search(/[\[{]/);
  if (first < 0) return null;
  const close = t[first] === "[" ? "]" : "}";
  const last = t.lastIndexOf(close);
  if (last <= first) return null;
  t = t.slice(first, last + 1);
  try { return JSON.parse(t); } catch { /* */ }
  try { return JSON.parse(t.replace(/,\s*([\]}])/g, "$1")); } catch { /* */ }
  return null;
}

/* ---------------- Supabase DB (서비스 키, REST 직접 호출) ---------------- */
function sbHeaders(extra: Record<string, string> = {}) {
  const h: Record<string, string> = { apikey: SERVICE_KEY, "content-type": "application/json", ...extra };
  if (SERVICE_KEY.startsWith("eyJ")) h.Authorization = `Bearer ${SERVICE_KEY}`;
  return h;
}
async function rest(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<any> {
  if (!SB_URL || !SERVICE_KEY) throw new HttpError(500, "SUPABASE_URL / SERVICE KEY 없음");
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: sbHeaders(init.headers || {}) });
  const txt = await r.text();
  if (!r.ok) throw new HttpError(502, `db ${r.status}: ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : null;
}
const enc = encodeURIComponent;
async function cacheGet(key: string): Promise<any | null> {
  const rows = await rest(`korrier_cache?key=eq.${enc(key)}&select=*`);
  return rows && rows[0] ? rows[0] : null;
}
async function cacheSet(key: string, data: unknown) {
  await rest(`korrier_cache?on_conflict=key`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString(), building_at: null }),
  });
}
/** 여러 인스턴스가 동시에 같은 트렌드를 다시 검색하지 않도록 ver 비교로 잠금 */
async function tryLock(key: string): Promise<boolean> {
  await rest(`korrier_cache?on_conflict=key`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ key, data: null }),
  });
  const row = await cacheGet(key);
  if (!row) return false;
  if (row.building_at && Date.now() - Date.parse(row.building_at) < 3 * 60e3) return false;
  const upd = await rest(`korrier_cache?key=eq.${enc(key)}&ver=eq.${row.ver}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ ver: row.ver + 1, building_at: new Date().toISOString() }),
  });
  return Array.isArray(upd) && upd.length === 1;
}
async function unlock(key: string) {
  await rest(`korrier_cache?key=eq.${enc(key)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ building_at: null }) }).catch(() => {});
}

/* ---------------- 사용자 / 사용량 제한 ---------------- */
async function getUser(req: Request): Promise<{ id: string } | null> {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!tok.startsWith("eyJ")) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${tok}` } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? u : null;
}
async function checkUsage(userId: string, kind: string, max: number) {
  const since = new Date(Date.now() - 3600e3).toISOString();
  const rows = await rest(`korrier_usage?user_id=eq.${userId}&kind=eq.${kind}&created_at=gte.${enc(since)}&select=id&limit=${max + 1}`);
  if ((rows || []).length >= max) throw new HttpError(429, "too_many_requests");
  await rest("korrier_usage", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: userId, kind }) });
}

/* ---------------- AI (OpenAI 호환 Chat Completions, 모델 자동 전환) ---------------- */
const deadModels = new Map<string, number>(); // 하루 한도 소진 / 사용 불가 모델 → 다시 시도할 시각
async function llmOnce(model: string, prompt: string, json: boolean, temperature: number, maxTokens: number) {
  const body: any = { model, messages: [{ role: "user", content: prompt }], temperature, max_tokens: maxTokens };
  if (json && !model.startsWith("groq/compound")) body.response_format = { type: "json_object" };
  if (model.startsWith("openai/gpt-oss")) body.reasoning_effort = "low";
  const res = await fetch(`${CFG.llmBase}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${CFG.llmKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { /* */ }
  return { res, data };
}
async function llm(prompt: string, { models = CFG.llmModels, json = true, temperature = 0.3, maxTokens = 4096 } = {}): Promise<string> {
  if (!CFG.llmKey) throw new HttpError(503, "LLM_API_KEY 미설정");
  let lastErr = "no_model";
  for (let round = 0; round < 2; round++) {
    let minWait = 60;
    for (const model of models) {
      if ((deadModels.get(model) || 0) > Date.now()) continue;
      let r;
      try { r = await llmOnce(model, prompt, json, temperature, maxTokens); } catch (e) { lastErr = (e as Error).message; continue; }
      const { res, data } = r;
      if (res.ok) {
        const out = data?.choices?.[0]?.message?.content || "";
        if (out) return out;
        lastErr = "empty"; continue;
      }
      const msg = String(data?.error?.message || `HTTP ${res.status}`);
      lastErr = `${model}: ${msg}`;
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after")) || 0;
        // 하루 한도(TPD/RPD)면 1시간 쉬게, 분당 한도면 다음 모델로
        if (/per day|TPD|RPD/i.test(msg) || ra > 120) deadModels.set(model, Date.now() + 3600e3);
        else minWait = Math.min(minWait, ra || 10);
        continue;
      }
      if (res.status === 404 || res.status === 400 && /model|decommission/i.test(msg)) { deadModels.set(model, Date.now() + 6 * 3600e3); continue; }
      if (res.status === 413 || res.status >= 500) continue; // 요청이 이 모델 분당 한도보다 큼 / 일시 장애 → 다음 모델
      throw new HttpError(502, `AI: ${msg}`);
    }
    if (round === 0) await sleep(Math.min(20, minWait) * 1000);
  }
  throw new HttpError(429, `AI 한도 초과: ${lastErr}`);
}

/* ---------------- 네이버 (NAVER API HUB / 구 개발자센터) ---------------- */
const NAVER_HUB = CFG.naverProvider !== "legacy";
const naverHeaders = (): Record<string, string> => NAVER_HUB
  ? { "X-NCP-APIGW-API-KEY-ID": CFG.naverId, "X-NCP-APIGW-API-KEY": CFG.naverSecret }
  : { "X-Naver-Client-Id": CFG.naverId, "X-Naver-Client-Secret": CFG.naverSecret };
const naverSearch = (kind: string, query: string, params: Record<string, string | number> = {}) => {
  const qs = new URLSearchParams({ query, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const url = NAVER_HUB
    ? `https://naverapihub.apigw.ntruss.com/search/v1/${kind}?${qs}`
    : `https://openapi.naver.com/v1/search/${kind}.json?${qs}`;
  return fetchJson(url, { headers: naverHeaders() });
};
const NAVER_TREND_URL = NAVER_HUB ? "https://naverapihub.apigw.ntruss.com/search-trend/v1/search" : "https://openapi.naver.com/v1/datalab/search";
async function naverBlogRecent(kw: string) {
  const r = await naverSearch("blog", kw, { display: 100, sort: "date" });
  const since = seoulDate(-7).replace(/-/g, "");
  return (r.items || []).filter((it: any) => (it.postdate || "") >= since).length;
}
async function naverNewsRecent(kw: string) {
  const r = await naverSearch("news", kw, { display: 100, sort: "date" });
  const since = Date.now() - 7 * 86400e3;
  return (r.items || []).filter((it: any) => Date.parse(it.pubDate) >= since).length;
}
/** 데이터랩: 공통 기준 키워드(anchor)로 묶음 간 비교 가능하게 정규화 */
async function naverDatalab(keywords: string[]) {
  const out: (number | null)[] = new Array(keywords.length).fill(null);
  if (!keywords.length) return out;
  const anchor = keywords[0];
  const batches: { k: string; idx: number }[][] = [];
  for (let i = 1; i < keywords.length; i += 4) batches.push(keywords.slice(i, i + 4).map((k, j) => ({ k, idx: i + j })));
  if (!batches.length) batches.push([]);
  const avg = (res: any) => { const d = res?.data || []; return d.length ? d.reduce((s: number, x: any) => s + x.ratio, 0) / d.length : 0; };
  for (const batch of batches) {
    const groups = [{ groupName: "ANCHOR", keywords: [anchor] }, ...batch.map((b, j) => ({ groupName: `G${j}`, keywords: [b.k] }))];
    const r = await fetchJson(NAVER_TREND_URL, {
      method: "POST",
      headers: { ...naverHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ startDate: seoulDate(-8), endDate: seoulDate(-1), timeUnit: "date", keywordGroups: groups }),
    });
    const results = r.results || [];
    const anchorAvg = avg(results.find((x: any) => x.title === "ANCHOR"));
    out[0] = 1;
    batch.forEach((b, j) => {
      const g = avg(results.find((x: any) => x.title === `G${j}`));
      out[b.idx] = anchorAvg > 0 ? g / anchorAvg : (g > 0 ? 10 : 0);
    });
  }
  return out;
}
async function naverImage(query: string) {
  const r = await naverSearch("image", query, { display: 3, sort: "sim", filter: "medium" });
  const it = (r.items || [])[0];
  return it ? { url: it.link, thumb: it.thumbnail } : null;
}
/** 네이버 쇼핑 검색 API는 2026-07-31 종료 → 가격 비교는 네이버쇼핑 검색 링크로 안내 */
const shopCompareUrl = (query: string) => `https://search.shopping.naver.com/search/all?query=${enc(query)}`;

/* ---------------- X (선택) ---------------- */
async function xRecentCount(kw: string) {
  const qs = new URLSearchParams({ query: `"${kw}" -is:retweet`, granularity: "day" });
  const r = await fetchJson(`https://api.x.com/2/tweets/counts/recent?${qs}`, { headers: { Authorization: `Bearer ${CFG.xBearer}` } });
  return r.meta?.total_tweet_count || 0;
}

/* ---------------- 구글 트렌드 RSS ---------------- */
async function googleTrendsKR(): Promise<string[]> {
  const res = await fetch("https://trends.google.com/trending/rss?geo=KR", { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return [];
  const xml = await res.text();
  const items: string[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < 25) {
    const title = (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const traffic = (m[1].match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/) || [])[1];
    if (title) items.push(`${stripTags(title)} (${traffic || "?"})`);
  }
  return items;
}

/* ---------------- 카카오 ---------------- */
async function kakao(pathname: string, params: Record<string, string | number>) {
  if (!CFG.kakaoRest) throw new HttpError(503, "KAKAO_REST_API_KEY 미설정");
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])));
  return fetchJson(`https://dapi.kakao.com${pathname}?${qs}`, { headers: { Authorization: `KakaoAK ${CFG.kakaoRest}` } });
}
const placeType = (code: string) => (code === "FD6" || code === "CE7") ? "food" : code === "AD5" ? "hotel" : (code === "SW8" || code === "PK6" || code === "OL7") ? "transport" : "spot";
const normPlace = (d: any) => ({
  id: d.id, name: d.place_name, category: d.category_name || "", group: d.category_group_code || "",
  type: placeType(d.category_group_code), address: d.road_address_name || d.address_name || "", phone: d.phone || "",
  lat: Number(d.y), lng: Number(d.x), url: d.place_url || "", distance: d.distance ? Number(d.distance) : null,
});
async function kakaoFirstPlace(query: string) {
  if (!CFG.kakaoRest) return null;
  const r = await kakao("/v2/local/search/keyword.json", { query, size: 1 });
  const d = (r.documents || [])[0];
  return d ? normPlace(d) : null;
}

/* ---------------- 번역 ---------------- */
const LANG_NAMES: Record<string, string> = { ko: "Korean", en: "English", ja: "Japanese", zh: "Simplified Chinese", es: "Spanish", fr: "French", th: "Thai" };
const PRON_RULE: Record<string, string> = {
  en: "Latin letters (English-friendly reading)", ja: "Katakana",
  zh: "Chinese characters that approximate the sound, followed by pinyin in parentheses",
  es: "Latin letters (Spanish-friendly reading)", fr: "Latin letters (French-friendly reading)", th: "Thai script",
};
async function googleTranslate(texts: string[], target: string): Promise<string[]> {
  const r = await fetchJson(`https://translation.googleapis.com/language/translate/v2?key=${enc(CFG.googleTranslateKey)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ q: texts, target: target === "zh" ? "zh-CN" : target, source: "ko", format: "text" }),
  });
  return (r.data?.translations || []).map((t: any) => t.translatedText);
}
async function translateStrings(texts: string[], lang: string): Promise<string[]> {
  if (lang === "ko" && !texts.some((x) => !/[가-힣]/.test(x) && /[A-Za-z\u3040-\u30ff\u4e00-\u9fff\u0e00-\u0e7f]/.test(x))) return texts;
  if (texts.length > 20) {
    const parts: string[][] = [];
    for (let i = 0; i < texts.length; i += 20) parts.push(texts.slice(i, i + 20));
    return (await mapLimit(parts, 3, (p) => translateStrings(p, lang))).flatMap((x, i) => x || parts[i]);
  }
  const key = `str:${lang}:${hashId(JSON.stringify(texts))}`;
  const hit = await cacheGet(key);
  if (hit?.data) return hit.data;
  let out: any;
  if (CFG.googleTranslateKey) out = await googleTranslate(texts, lang);
  else {
    const text = await llm(`Translate each string in "texts" (usually Korean, may be another language) into ${LANG_NAMES[lang]}. If a string is already in ${LANG_NAMES[lang]}, keep it. Keep proper nouns natural for travelers (localized name if widely used, otherwise romanize). Keep line breaks. Return JSON {"texts":[...]} with the same number of strings in the same order.\n${JSON.stringify({ texts })}`, { models: CFG.llmFastModels, temperature: 0.1, maxTokens: Math.min(8000, 800 + texts.join("").length * 3) });
    const o = parseJsonLoose(text);
    out = Array.isArray(o) ? o : o?.texts;
  }
  if (!Array.isArray(out) || out.length !== texts.length) throw new HttpError(502, "translate_parse_failed");
  out = out.map(String);
  await cacheSet(key, out);
  return out;
}

/* ---------------- 트렌드 정의 ---------------- */
const COMMON_RULES = (today: string) => `
오늘은 ${today} (한국 시간)입니다.
웹 검색으로 최근 7일 이내 X, 인스타그램, 틱톡, 유튜브, 네이버 블로그·뉴스에서 실제로 언급이 많은 것만 고르세요.
- 확인되지 않은 정보는 만들지 마세요. 모르는 필드는 빈 문자열.
- 최대 30개, 화제성 높은 순서.`;

/** 규칙이 바뀌면 숫자를 올려서, 예전 서버가 만든 순위(매장·비K팝 공연 섞인 것)를 바로 버린다 */
const TREND_VER = "trend:v6:";

const PRODUCT_RULE = `
- 반드시 "구매할 수 있는 개별 제품"만. 브랜드명과 제품명이 둘 다 있어야 합니다.
- 매장, 쇼핑몰·플랫폼 자체, 할인/쿠폰/세일/기획전/프로모션/이벤트/행사, 브랜드 소식, 랭킹 기사 제목은 절대 넣지 마세요.`;

const SPECS: Record<string, { ask: string; rule?: string; fields: string }> = {
  hotplace: {
    ask: "지금 대한민국에서 가장 핫한 장소(팝업스토어, 카페, 맛집, 전시, 거리, 명소)",
    rule: "\n- 실제로 찾아갈 수 있는 구체적인 장소만. 지역 전체·행사명만 있는 것은 제외.",
    fields: '{"name":"장소 공식명","nameEn":"영문","kind":"popup|cafe|food|exhibition|street|spot 중 하나","area":"시/도 구/군","address":"도로명 주소(모르면 빈 문자열)","summary":"왜 화제인지 1~2문장"}',
  },
  beauty: {
    ask: "지금 한국에서 가장 많이 팔리고 SNS에서 화제인 화장품·뷰티 제품",
    rule: PRODUCT_RULE,
    fields: '{"brand":"브랜드","name":"제품명(브랜드 제외)","nameEn":"영문 제품명","productType":"제품 종류","summary":"특징과 인기 이유 1~2문장"}',
  },
  "fashion-artist": {
    ask: "최근 2주 이내 K-POP 아이돌·한국 배우·한국 가수가 실제로 착용해 화제가 된 패션 제품",
    rule: PRODUCT_RULE + "\n- 브랜드를 알 수 없는 착장(예: 그냥 '블랙 드레스')은 제외.",
    fields: '{"artist":"착용한 한국 연예인(그룹)","brand":"브랜드","item":"제품명","wornDate":"YYYY-MM-DD","wornWhere":"착용 장소/상황","price":"판매가(모르면 빈 문자열)","summary":"착용 상황과 반응 1~2문장"}',
  },
  "fashion-musinsa": {
    ask: "무신사(MUSINSA)에서 지금 랭킹 상위·판매 급상승 중인 패션 상품",
    rule: PRODUCT_RULE,
    fields: '{"brand":"브랜드","item":"상품명","price":"판매가(원)","summary":"인기 이유 1문장"}',
  },
  "fashion-ably": {
    ask: "에이블리(ABLY)에서 지금 랭킹 상위·판매 급상승 중인 패션 상품",
    rule: PRODUCT_RULE,
    fields: '{"brand":"마켓/브랜드","item":"상품명","price":"판매가(원)","summary":"인기 이유 1문장"}',
  },
  concert: {
    ask: "오늘 이후(또는 진행 중) 한국에서 열리는 K-POP 아이돌·한국 가수·한국 배우/방송인의 콘서트·팬미팅",
    rule: `
- 공연하는 주인공이 반드시 한국 연예인(K-POP 그룹/솔로, 유명 한국 가수, 한국 배우·방송인)이어야 합니다.
- 클래식, 오케스트라, 송년음악회, 뮤지컬, 오페라, 합창, 해외 아티스트 내한, 출연진 없는 페스티벌, 대중에게 잘 알려지지 않은 인디 밴드·언더 공연은 제외.
- artistType: K-POP 아이돌/그룹=kpop, 대중적으로 유명한 한국 가수=singer, 한국 배우=actor, 한국 방송인·예능인=entertainer, 그 밖(인디·클래식·해외·무명)=other.`,
    fields: '{"artist":"아티스트(그룹/가수/배우) 이름","artistType":"kpop|singer|actor|entertainer|other","title":"공연명","startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","venue":"공연장","city":"도시","ticketVendor":"예매처","summary":"공연 소개 1~2문장"}',
  },
  slang: {
    ask: "지금 한국 SNS(X·인스타·틱톡·쇼츠)와 커뮤니티에서 실제로 쓰이는 유행어·신조어·밈 표현",
    rule: `
- 사람들이 대화·댓글에서 실제로 따라 쓰는 '말(표현)'만 고르세요. 예: 야르, 럭키비키, 추구미, 중꺾마 같은 것.
- 다음은 절대 넣지 마세요: 사람·그룹·선수 이름, 시험·자격증 이름(LEET, 세무사 등), 기관·대회·상품·브랜드 이름, 영어 약어(LPGA 등), 뉴스 키워드·사건명, 원래 있던 표준어.
- type: 유행어·신조어=slang, 밈·짤 대사=meme, 챌린지·숏폼 사운드 대사=challenge, 고유명사·시험·기관·뉴스 키워드=other.
- origin: 어디서(커뮤니티/X/쇼츠/방송 등) 어떻게 생겼는지 1문장.`,
    fields: '{"word":"유행어","type":"slang|meme|challenge|other","romanization":"로마자 표기, 음절을 하이픈으로(예: Jung-ji-jeong)","meaning":"짧은 뜻(15자 이내)","example":"실제로 쓰는 한국어 예문 1개","nuance":"의미·뉘앙스 1문장","origin":"유래 1문장"}',
  },
};

/** 제품 탭에 섞여 들어오는 행사·매장·프로모션 제거 */
const NOT_PRODUCT = /할인|쿠폰|세일|기획전|프로모션|이벤트|행사|매장|스토어|지점|플래그십|특화|체험|공간|오픈|팝업|블랙프라이데이|광군제|페스타|랭킹|콘텐츠|무료배송|적립|특가|위크|브랜드데이/;
const PLATFORM = /^(에이블리|ABLY|무신사|MUSINSA|올리브영|OLIVE ?YOUNG|지그재그|29CM|W컨셉)$/i;
const NOT_KCONCERT = /오케스트라|클래식|교향|필하모닉|송년음악회|신년음악회|뮤지컬|오페라|합창|발레|국악관현악/;
function validCandidate(cat: string, c: any): boolean {
  const s = (v: unknown) => String(v || "").trim();
  if (cat === "beauty") {
    return !!(s(c.brand) && s(c.name)) && !PLATFORM.test(s(c.brand)) && !NOT_PRODUCT.test(`${c.brand} ${c.name}`);
  }
  if (cat.startsWith("fashion")) {
    if (!s(c.brand) || !s(c.item) || PLATFORM.test(s(c.brand)) || NOT_PRODUCT.test(`${c.brand} ${c.item}`)) return false;
    if (cat === "fashion-artist" && !s(c.artist)) return false;
    return true;
  }
  if (cat === "concert") return !!(s(c.artist) && s(c.title)) && ["kpop", "singer", "actor", "entertainer"].includes(s(c.artistType).toLowerCase()) && !NOT_KCONCERT.test(`${c.artist} ${c.title}`);
  if (cat === "hotplace") return !!s(c.name);
  if (cat === "slang") return !!s(c.word) && s(c.word).length <= 15 && ["slang", "meme", "challenge"].includes(s(c.type).toLowerCase()) && !/^[A-Z0-9 ]+$/.test(s(c.word));
  return true;
}

function keyOf(cat: string, c: any): string {
  if (cat === "slang") return c.word;
  if (cat === "concert") return `${c.artist || ""} ${c.title || ""}`.trim();
  if (cat === "beauty") return `${c.brand || ""} ${c.name || ""}`.trim();
  if (cat.startsWith("fashion")) return `${c.artist || ""} ${c.brand || ""} ${c.item || ""}`.trim();
  return c.name;
}

function baseItem(cat: string, c: any): any {
  const keyword = String(c.searchKeyword || (cat.startsWith("fashion") ? `${c.brand || ""} ${c.item || ""}` : cat === "slang" ? c.word : keyOf(cat, c)) || "").trim();
  const item: any = {
    id: hashId(cat + "|" + keyOf(cat, c)), cat, keyword,
    title: "", subtitle: "", desc: c.summary || "", tag: "", link: "", linkKind: "web",
    sourceUrl: isHttpUrl(c.sourceUrl) ? c.sourceUrl : "",
    image: null, location: null, shop: null, dates: null, price: "", slang: null,
  };
  switch (cat) {
    case "hotplace":
      Object.assign(item, { title: c.name, subtitle: c.nameEn || "", tag: c.area || "", linkKind: "map", kind: ["popup", "cafe", "food", "exhibition", "street", "spot"].includes(c.kind) ? c.kind : "spot", location: { name: c.name, address: c.address || "", area: c.area || "" } });
      break;
    case "beauty":
      Object.assign(item, { title: `${c.brand} ${c.name}`.trim(), subtitle: c.nameEn || "", tag: c.productType || "", brand: c.brand || "", linkKind: "store" });
      break;
    case "fashion-artist":
      Object.assign(item, {
        title: `${c.brand || ""} ${c.item || ""}`.trim(), subtitle: [c.wornDate, c.wornWhere].filter(Boolean).join(" · "),
        tag: c.artist || "", price: c.price || "", link: isHttpUrl(c.storeUrl) ? c.storeUrl : "", linkKind: "store",
      });
      break;
    case "fashion-musinsa":
    case "fashion-ably":
      Object.assign(item, {
        title: `${c.brand || ""} ${c.item || ""}`.trim(), subtitle: c.price || "", tag: c.brand || "", price: c.price || "", linkKind: "store",
        link: cat === "fashion-musinsa"
          ? `https://www.musinsa.com/search/goods?keyword=${enc(keyOf(cat, c))}`
          : `https://m.a-bly.com/search?keyword=${enc(c.item || keyOf(cat, c))}`,
      });
      break;
    case "concert":
      Object.assign(item, {
        title: c.artist, subtitle: c.title, tag: [c.venue, c.city].filter(Boolean).join(" · "),
        dates: { start: c.startDate || "", end: c.endDate || c.startDate || "" },
        location: { name: c.venue || "", address: c.city || "" },
        link: isHttpUrl(c.ticketUrl) ? c.ticketUrl : "", linkKind: "ticket", ticketVendor: c.ticketVendor || "",
      });
      break;
    case "slang":
      Object.assign(item, {
        title: c.word, subtitle: c.romanization || "", desc: [c.nuance, c.origin ? `유래: ${c.origin}` : ""].filter(Boolean).join(" "),
        slang: { meaning: c.meaning || "", example: c.example || "", exampleTr: "", pron: "" },
        link: `https://x.com/search?q=${enc(c.word)}&f=live`, linkKind: "x",
      });
      break;
  }
  return item;
}

async function scoreItems(items: any[]) {
  const kws = items.map((it) => it.keyword);
  const signals: Record<string, number>[] = items.map(() => ({}));
  const basis: string[] = [];
  if (HAS_NAVER) {
    const [dl, blog, news] = await Promise.all([
      naverDatalab(kws).catch((e) => { console.warn("[datalab]", e.message); return null; }),
      mapLimit(kws, 5, naverBlogRecent),
      mapLimit(kws, 5, naverNewsRecent),
    ]);
    if (dl) { dl.forEach((v, i) => { if (v != null) signals[i].search = v; }); basis.push("naverSearch"); }
    blog.forEach((v, i) => { if (v != null) signals[i].blog = v; });
    news.forEach((v, i) => { if (v != null) signals[i].news = v; });
    basis.push("naverBlog", "naverNews");
  }
  if (CFG.xBearer) {
    const xs = await mapLimit(kws, 3, xRecentCount);
    xs.forEach((v, i) => { if (v != null) signals[i].x = v; });
    if (xs.some((v) => v != null)) basis.push("x");
  }
  const weights: Record<string, number> = { search: 0.45, blog: 0.3, news: 0.15, x: 0.1 };
  const active = Object.keys(weights).filter((k) => signals.some((s) => s[k] != null));
  if (!active.length) {
    items.forEach((it, i) => { it.score = Math.round(100 - i * (100 / items.length)); it.signals = {}; });
    return { items, basis: ["ai"] };
  }
  const maxes: Record<string, number> = {};
  active.forEach((k) => { maxes[k] = Math.max(1e-9, ...signals.map((s) => s[k] || 0)); });
  const wsum = active.reduce((s, k) => s + weights[k], 0);
  items.forEach((it, i) => {
    let score = 0;
    active.forEach((k) => { score += (weights[k] / wsum) * ((signals[i][k] || 0) / maxes[k]); });
    it.score = Math.round(score * 100);
    it.signals = {
      search: signals[i].search != null ? Math.round((signals[i].search / (maxes.search || 1)) * 100) : undefined,
      blog: signals[i].blog, news: signals[i].news, x: signals[i].x,
    };
  });
  items.sort((a, b) => b.score - a.score);
  return { items, basis };
}

async function enrichItem(it: any) {
  const tasks: Promise<unknown>[] = [];
  if (HAS_NAVER) {
    tasks.push(naverImage(it.cat === "slang" ? `${it.title} 짤` : it.keyword).then((img) => { if (img) it.image = img; }).catch(() => {}));
  }
  if (it.cat === "beauty" || it.cat.startsWith("fashion")) {
    it.shop = { compareUrl: shopCompareUrl(it.keyword) };
    if (it.cat === "beauty") it.link = shopCompareUrl(it.keyword);
  }
  if (it.location?.name) tasks.push(locate(it.location).catch(() => {}));
  await Promise.all(tasks);
  if (it.cat === "hotplace") {
    const q = it.location?.lat ? `${it.location.lat},${it.location.lng}` : it.title;
    it.link = `https://www.google.com/maps/search/?api=1&query=${enc(q)}`;
  }
  if (!it.link) it.link = it.sourceUrl || `https://search.naver.com/search.naver?query=${enc(it.keyword)}`;
  return it;
}

/** 장소 좌표 찾기: 이름 → (지역+이름) → 주소 순서 */
async function locate(loc: any) {
  if (!CFG.kakaoRest) return;
  const tries = [loc.area ? `${loc.area} ${loc.name}` : "", loc.name].filter(Boolean);
  for (const q of tries) {
    const p = await kakaoFirstPlace(q).catch(() => null);
    if (p) { Object.assign(loc, { address: p.address || loc.address, lat: p.lat, lng: p.lng, kakaoUrl: p.url, category: p.category }); return; }
  }
  if (loc.address) {
    const r = await kakao("/v2/local/search/address.json", { query: loc.address, size: 1 }).catch(() => null);
    const d = r?.documents?.[0];
    if (d) Object.assign(loc, { lat: Number(d.y), lng: Number(d.x) });
  }
}

/* ---------- 실제 최신 글 수집 (네이버 뉴스·블로그 최근 7일) ---------- */
const SEEDS: Record<string, string[]> = {
  hotplace: ["팝업스토어 오픈", "핫플 웨이팅", "요즘 핫플", "성수 팝업", "신상 카페 웨이팅", "전시 오픈 화제"],
  beauty: ["올리브영 랭킹 1위", "품절 대란 화장품", "올리브영 추천템", "선크림 인기", "쿠션 인기 제품", "립 신상 인기"],
  "fashion-artist": ["공항패션 착용 브랜드", "아이돌 착용 제품", "착용해 화제 브랜드", "사복 패션 정보", "배우 착용 가방"],
  "fashion-musinsa": ["무신사 랭킹 1위", "무신사 인기 상품", "무신사 품절", "무신사 추천템"],
  "fashion-ably": ["에이블리 랭킹 1위", "에이블리 인기 상품", "에이블리 추천템", "에이블리 구매 후기"],
  concert: ["단독 콘서트 개최", "팬미팅 개최 확정", "아이돌 콘서트 티켓 오픈", "월드투어 서울 공연", "전국투어 콘서트", "배우 팬미팅"],
  slang: ["캐릿 요즘 뜨는 밈", "트렌드어워드 신조어", "요즘 유행하는 밈 뜻", "신조어 뜻 유래", "MZ 신조어 정리", "유행어 뜻 밈 유래", "트위터 유행어", "더쿠 유행어", "쇼츠 유행 밈", "챌린지 유행어"],
};
type Snip = { t: string; d: string; link: string; kind: string; date: string };
async function collectSnippets(queries: string[], perQuery = 40, max = 70, days = 7): Promise<Snip[]> {
  const since = Date.now() - days * 86400e3;
  const sinceBlog = seoulDate(-days).replace(/-/g, "");
  const lists = await mapLimit(queries, 3, async (q) => {
    const [news, blog] = await Promise.all([
      naverSearch("news", q, { display: perQuery, sort: "date" }).catch(() => ({ items: [] })),
      naverSearch("blog", q, { display: perQuery, sort: "date" }).catch(() => ({ items: [] })),
    ]);
    const a: Snip[] = (news.items || []).filter((x: any) => Date.parse(x.pubDate) >= since)
      .map((x: any) => ({ t: stripTags(x.title), d: stripTags(x.description), link: x.originallink || x.link, kind: "뉴스", date: new Date(Date.parse(x.pubDate) + 9 * 3600e3).toISOString().slice(5, 10) }));
    const b: Snip[] = (blog.items || []).filter((x: any) => (x.postdate || "") >= sinceBlog)
      .map((x: any) => ({ t: stripTags(x.title), d: stripTags(x.description), link: x.link, kind: "블로그", date: `${x.postdate.slice(4, 6)}-${x.postdate.slice(6, 8)}` }));
    return [a, b];
  });
  // 뉴스·블로그를 번갈아 섞고 제목 중복 제거
  const pools = lists.flatMap((x) => x || [[], []]);
  const out: Snip[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < max && pools.some((p) => p.length > i); i++) {
    for (const p of pools) {
      const x = p[i];
      if (!x || out.length >= max) continue;
      const key = x.t.replace(/\s+/g, "").slice(0, 30);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(x);
    }
  }
  return out;
}
const snipText = (snips: Snip[]) => snips.map((x, i) => `[${i}] (${x.kind} ${x.date}) ${x.t} — ${x.d.slice(0, 55)}`).join("\n");

/** 유행어 검증: 네이버 블로그에서 '단어 + 뜻'으로 찾았을 때 신조어·유행어·밈으로 설명하는 글이 실제로 있어야 통과 */
const SLANG_EVIDENCE = /신조어|유행어|밈|줄임말|급식체|챌린지|인터넷 용어|유행하는|무슨 뜻|뜻과 유래|짤/;
async function verifySlang(cands: any[]) {
  const checked = await mapLimit(cands.slice(0, 60), 5, async (c: any) => {
    const w = String(c.word).trim();
    const r = await naverSearch("blog", `${w} 뜻`, { display: 30, sort: "sim" }).catch(() => ({ items: [] }));
    const hits = (r.items || []).filter((x: any) => {
      const txt = stripTags(`${x.title} ${x.description}`);
      return txt.includes(w) && SLANG_EVIDENCE.test(txt);
    }).length;
    c._evidence = hits;
    return hits >= 3 ? c : null;
  });
  return checked.filter(Boolean).sort((a: any, b: any) => b._evidence - a._evidence);
}

async function buildTrends(cat: string) {
  const spec = SPECS[cat];
  const today = seoulDate();
  let hint = "";
  if (cat === "hotplace" || cat === "concert") {
    const gt = await googleTrendsKR().catch(() => []);
    if (gt.length) hint = `\n참고: 지금 구글 트렌드 한국 급상승 검색어(검색량): ${gt.join(", ")}\n관련 있는 것이 있으면 우선 반영하세요.`;
  }
  let text: string;
  let sources: { title: string; uri: string }[] = [];
  let snips: Snip[] = [];
  if (HAS_NAVER) {
    snips = cat === "slang" ? await collectSnippets(SEEDS[cat], 30, 90, 30) : await collectSnippets(SEEDS[cat]);
    if (snips.length < 5) throw new HttpError(502, "not_enough_data");
    text = await llm(`오늘은 ${today}(한국 시간)입니다. 아래는 최근 7일 동안 실제로 올라온 네이버 뉴스·블로그 글 목록입니다.${hint}
이 자료에 나온 내용만 근거로 ${spec.ask}을(를) 최대 50개, 화제성 높은 순서로 골라주세요.${spec.rule || ""}
- 자료에 없는 것은 절대 만들지 마세요. 모르는 필드는 빈 문자열. 같은 대상은 한 번만.
- 여러 글에 반복해서 나온 것을 우선하세요. 문장은 짧게.
- 각 항목에 근거 글 번호를 "refs":[번호] 로 넣으세요.
- 결과는 {"items":[...]} 형태의 JSON 하나만 출력하세요.
각 항목 형식: ${spec.fields} + "refs"

자료:
${snipText(snips)}`, { maxTokens: 6000 });
  } else {
    text = await llm(`${spec.ask}을(를) 웹 검색으로 찾아주세요.${COMMON_RULES(today)}${spec.rule || ""}${hint}\n결과는 {"items":[...]} 형태 JSON 하나만. 각 항목 형식: ${spec.fields}`, { models: [CFG.llmSearchModel], maxTokens: 4000 });
  }
  const parsed = parseJsonLoose(text);
  let cands = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(cands) || !cands.length) throw new HttpError(502, "ai_parse_failed");
  // 근거 글 링크를 출처로 연결
  const used = new Set<number>();
  cands.forEach((c: any) => {
    const refs = (Array.isArray(c?.refs) ? c.refs : []).map(Number).filter((n: number) => snips[n]);
    refs.forEach((n: number) => used.add(n));
    if (!c.sourceUrl && refs.length) c.sourceUrl = snips[refs[0]].link;
  });
  sources = [...used].slice(0, 12).map((n) => ({ title: snips[n].t, uri: snips[n].link }));
  cands = cands.filter((c: any) => c && typeof c === "object" && keyOf(cat, c) && validCandidate(cat, c));
  if (!cands.length) throw new HttpError(502, "no_valid_items");
  if (cat === "concert") cands = cands.filter((c: any) => !c.endDate || c.endDate >= today);
  if (cat === "slang") cands = await verifySlang(cands);
  if (!cands.length) throw new HttpError(502, "no_valid_items");
  const seen = new Set<string>();
  let items = cands.map((c: any) => baseItem(cat, c)).filter((it: any) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
  const scored = await scoreItems(items);
  items = scored.items.slice(0, CFG.maxItems);
  await mapLimit(items, 6, enrichItem);
  items.forEach((it: any, i: number) => { it.rank = i + 1; });
  return { cat, items, sources: sources.slice(0, 12), basis: scored.basis, updatedAt: new Date().toISOString() };
}

async function translateTrend(result: any, lang: string) {
  if (lang === "ko") return result;
  const ck = `tr:${result.cat}:${lang}`;
  const hit = await cacheGet(ck);
  if (hit?.data && hit.data.updatedAt === result.updatedAt) return hit.data;

  const payloadAll = result.items.map((it: any) => {
    const p: any = { id: it.id, desc: it.desc, tag: it.tag };
    if (it.cat === "slang") { p.meaning = it.slang.meaning; p.example = it.slang.example; p.pron = it.title; }
    else { p.title = it.title; if (it.cat === "concert" || it.cat === "fashion-artist") p.subtitle = it.subtitle; }
    return p;
  });
  const prompt = `You are a professional localizer for a Korea travel & trend app. Translate the Korean values of this JSON into ${LANG_NAMES[lang]}.
Rules:
- Keep "id" unchanged. Return JSON {"items":[...]} with the same objects and keys, ONLY JSON.
- "title": localized name a foreign traveler would recognize (use the official foreign name if one exists, otherwise a natural translation/romanization).
- "tag", "subtitle", "desc", "meaning": natural, fluent ${LANG_NAMES[lang]}.
- "example": translate the Korean example sentence naturally.
- "pron": write how the Korean word sounds using ${PRON_RULE[lang]}.
- Dates and prices stay as they are.
`;
  // 무료 플랜 분당 토큰 한도 때문에 10개씩 나눠 번역
  const arr: any[] = [];
  for (let i = 0; i < payloadAll.length; i += 10) {
    const chunk = payloadAll.slice(i, i + 10);
    try {
      const text = await llm(prompt + JSON.stringify({ items: chunk }), { models: CFG.llmFastModels, temperature: 0.2, maxTokens: 3000 });
      const parsedTr = parseJsonLoose(text);
      const part = Array.isArray(parsedTr) ? parsedTr : parsedTr?.items;
      if (Array.isArray(part)) arr.push(...part);
    } catch (e) { if (!arr.length && i === 0) throw e; }
  }
  if (!arr.length) throw new HttpError(502, "translate_parse_failed");
  const byId = new Map(arr.map((x: any) => [x.id, x]));
  const items = result.items.map((it: any) => {
    const t: any = byId.get(it.id) || {};
    const copy = structuredClone(it);
    copy.original = it.title;
    if (it.cat === "slang") {
      copy.slang.meaning = t.meaning || it.slang.meaning;
      copy.slang.exampleTr = t.example || "";
      copy.slang.pron = t.pron || "";
    } else {
      copy.title = t.title || it.title;
      if (t.subtitle) copy.subtitle = t.subtitle;
      else if (it.cat !== "fashion-musinsa" && it.cat !== "fashion-ably") copy.subtitle = it.title;
    }
    copy.desc = t.desc || it.desc;
    copy.tag = t.tag || it.tag;
    return copy;
  });
  const out = { ...result, items, lang };
  await cacheSet(ck, out);
  return out;
}

/** 응답을 먼저 보내고 뒤에서 계속 작업 (Supabase Edge Runtime) */
function background(p: Promise<unknown>) {
  const rt = (globalThis as any).EdgeRuntime;
  const safe = p.catch((e) => console.warn("[bg]", (e as Error).message));
  if (rt?.waitUntil) rt.waitUntil(safe);
}
async function rebuild(cat: string) {
  const key = `${TREND_VER}${cat}`;
  if (!(await tryLock(key))) return false;
  try {
    const base = await buildTrends(cat);
    await cacheSet(key, base);
    return true;
  } catch (e) {
    await unlock(key);
    throw e;
  }
}

async function getTrends(cat: string, lang: string, force: boolean) {
  if (!SPECS[cat]) throw new HttpError(404, "unknown_category");
  const key = `${TREND_VER}${cat}`;
  const ttl = CFG.trendTtlMin * 60e3;
  let row = await cacheGet(key);
  let base = row?.data || null;
  const age = base ? Date.now() - Date.parse(base.updatedAt) : Infinity;
  let refreshing = false;
  if (!base) {
    // 첫 검색: 직접 만들거나, 다른 요청이 만드는 중이면 기다림
    if (!(await rebuild(cat))) {
      for (let i = 0; i < 60 && !base; i++) { await sleep(2000); row = await cacheGet(key); base = row?.data || null; }
      if (!base) throw new HttpError(504, "trend_timeout");
    }
    base = base || (await cacheGet(key))?.data;
  } else if (age > ttl || (force && age > 10 * 60e3)) {
    // 오래된 결과는 바로 보여주고, 뒤에서 새로 검색
    refreshing = true;
    background(rebuild(cat));
  }
  const out = await translateTrend(base, lang);
  return { ...out, refreshing, nextRefreshAt: new Date(Date.parse(base.updatedAt) + ttl).toISOString() };
}

/** 예약 작업(pg_cron)이 호출: 가장 오래된 카테고리 하나를 새로 검색 */
async function warmOne() {
  const cats = Object.keys(SPECS);
  const ages = await Promise.all(cats.map(async (c) => {
    const r = await cacheGet(`${TREND_VER}${c}`).catch(() => null);
    return { c, at: r?.data?.updatedAt ? Date.parse(r.data.updatedAt) : 0 };
  }));
  ages.sort((a, b) => a.at - b.at);
  const target = ages[0];
  if (target.at && Date.now() - target.at < 15 * 60e3) return { skipped: true };
  background(rebuild(target.c));
  return { warming: target.c };
}

/* ---------------- AI 여론 요약 ---------------- */
async function aiOpinion(keyword: string, title: string, lang: string) {
  const ck = `op:${lang}:${hashId(keyword)}`;
  const hit = await cacheGet(ck);
  if (hit?.data && Date.now() - Date.parse(hit.data.updatedAt) < 30 * 60e3) return hit.data;
  let snips: Snip[] = [];
  let basisText: string;
  if (HAS_NAVER) {
    snips = await collectSnippets([keyword, `${keyword} 후기`], 30, 22);
    basisText = `아래는 최근 7일 동안 실제로 올라온 네이버 뉴스·블로그 글입니다. 이 글들에 나타난 반응만 근거로`;
  } else {
    basisText = `웹 검색으로 최근 2주간 사람들의 실제 반응을 조사하고, 그 결과만 근거로`;
  }
  const prompt = `오늘은 ${seoulDate()}입니다. "${keyword}"(${title})에 대한 여론을 정리하세요.
${basisText} ${LANG_NAMES[lang]}로 작성하고, 다음 JSON 객체 하나만 출력하세요:
{"summary":"전체 여론 요약 4~5문장(구체적 근거 포함)","rating":1.0~5.0 사이 숫자(실제 반응의 긍정 비율 기반, 소수점 1자리),"positives":["긍정 포인트 최대 3개"],"negatives":["부정/주의 포인트 최대 3개"],"tip":"방문·구매·참여 전 실용 팁 1문장"}
근거를 찾지 못하면 summary에 그렇다고 쓰고 rating은 null로 두세요.${snips.length ? "\n\n자료:\n" + snipText(snips) : ""}`;
  const text = await llm(prompt, { models: snips.length ? CFG.llmModels : [CFG.llmSearchModel], maxTokens: 1500 });
  const sources = snips.slice(0, 8).map((x) => ({ title: x.t, uri: x.link }));
  const obj = parseJsonLoose(text);
  if (!obj || typeof obj !== "object") throw new HttpError(502, "ai_parse_failed");
  const r = obj.rating == null ? null : Math.max(1, Math.min(5, Number(obj.rating) || 0));
  const out = {
    summary: String(obj.summary || ""),
    rating: r && !Number.isNaN(r) ? Math.round(r * 10) / 10 : null,
    positives: Array.isArray(obj.positives) ? obj.positives.slice(0, 3).map(String) : [],
    negatives: Array.isArray(obj.negatives) ? obj.negatives.slice(0, 3).map(String) : [],
    tip: String(obj.tip || ""),
    sources: sources.slice(0, 8),
    updatedAt: new Date().toISOString(),
  };
  await cacheSet(ck, out);
  return out;
}


/* ---------------- MY스타: 검색 · 사진 · 소식/일정 ---------------- */
const httpsOnly = (u: string) => (u || "").replace(/^http:\/\//, "https://");
const STAR_WORD = /선수|축구|야구|골프|배구|농구|피겨|수영|e스포츠|프로게이머|유튜버|크리에이터|가수|아이돌|그룹|보이그룹|걸그룹|배우|래퍼|싱어송라이터|멤버|연예인|방송인|뮤지션|보컬|댄서|솔로|밴드|탤런트|MC|모델|프로듀서|작곡가|singer|idol|actor|actress|rapper|band/i;
async function starSearch(q: string) {
  const ck = `starq:${hashId(q.toLowerCase())}`;
  const hit = await cacheGet(ck);
  if (hit?.data && Date.now() - Date.parse(hit.data.updatedAt) < 24 * 3600e3) return hit.data;
  let list: any[] = [];
  let encycOk = true;
  try {
    const r = await naverSearch("encyc", q, { display: 20 });
    const all = (r.items || []).map((x: any) => {
      const full = stripTags(x.title);
      const m = full.match(/^(.+?)\s*\(([^)]*)\)\s*$/);
      return { name: (m ? m[1] : full).trim().slice(0, 40), sub: m ? m[2].trim() : "", desc: stripTags(x.description).slice(0, 160), photo: httpsOnly(x.thumbnail || ""), link: x.link || "" };
    }).filter((x: any) => x.name);
    const people = all.filter((x: any) => STAR_WORD.test(x.sub + " " + x.desc));
    list = (people.length ? people : all).slice(0, 10);
  } catch (e) {
    encycOk = false;
    console.warn("[star encyc]", (e as Error).message);
  }
  // 백과사전 결과가 없거나 API를 아직 추가하지 않았으면: 입력한 이름 그대로 후보로
  if (!list.some((x) => x.name.replace(/\s/g, "").toLowerCase() === q.replace(/\s/g, "").toLowerCase())) {
    const news = await naverSearch("news", q, { display: 5, sort: "sim" }).catch(() => ({ items: [] }));
    if ((news.items || []).length || !list.length) {
      list.unshift({ name: q.slice(0, 40), sub: "", desc: stripTags(news.items?.[0]?.title || "").slice(0, 120), photo: "", link: "" });
    }
  }
  // 사진이 없는 후보는 네이버 이미지로 채움
  await mapLimit(list, 4, async (x) => {
    if (x.photo) return;
    const img = await naverSearch("image", `${x.name} ${x.sub || "프로필"}`.trim(), { display: 1, sort: "sim" }).catch(() => null);
    const it = img?.items?.[0];
    if (it) x.photo = httpsOnly(it.thumbnail || it.link);
  });
  const seen = new Set<string>();
  list = list.filter((x) => { const k = x.name + "|" + x.sub; if (seen.has(k)) return false; seen.add(k); return true; });
  const out = { results: list.slice(0, 10), encyc: encycOk, updatedAt: new Date().toISOString() };
  await cacheSet(ck, out);
  return out;
}
async function starPhotos(name: string) {
  const qs = [`${name}`, `${name} 프로필 사진`];
  const lists = await Promise.all(qs.map((q) => naverSearch("image", q, { display: 15, sort: "sim" }).catch(() => ({ items: [] }))));
  const seen = new Set<string>();
  const photos: { thumb: string; full: string }[] = [];
  for (const it of lists.flatMap((l: any) => l.items || [])) {
    const thumb = httpsOnly(it.thumbnail || "");
    if (!thumb || seen.has(thumb)) continue;
    seen.add(thumb);
    photos.push({ thumb, full: httpsOnly(it.link || thumb) });
  }
  return { photos: photos.slice(0, 24) };
}

const FEED_TTL = 3 * 3600e3;
const ATHLETE = /선수|축구|야구|골프|배구|농구|피겨|수영|테니스|e스포츠|프로게이머|감독/;
const ACTOR = /배우|탤런트|연기자|actor|actress/i;
function starQueries(name: string, sub: string) {
  const common = ["일정", "출연 예정", "방송 출연", "유튜브 출연", "예능 출연", "행사 참석"];
  if (ATHLETE.test(sub)) return [...common, "경기", "다음 경기", "경기 일정", "선발 출전", "출전", "중계", "A매치", "광고 촬영"];
  if (ACTOR.test(sub)) return [...common, "드라마 방영", "영화 개봉", "제작발표회", "팬미팅", "시상식", "패션쇼", "화보", "무대인사"];
  return [...common, "콘서트", "컴백", "발매", "팬미팅", "팬사인회", "음악방송", "대학 축제", "축제 라인업", "페스티벌", "패션쇼", "시상식", "월드투어"];
}
const SCH_TYPES = ["concert", "fanmeeting", "comeback", "broadcast", "youtube", "match", "festival", "fashion", "stage", "release", "event", "ticket"];

async function buildStarFeed(name: string, sub = "") {
  const since = Date.now() - 60 * 86400e3;
  const queries = starQueries(name, sub);
  const [newsR, photoR, ...schedR] = await Promise.all([
    naverSearch("news", name, { display: 40, sort: "date" }).catch(() => ({ items: [] })),
    naverSearch("image", name, { display: 18, sort: "date" }).catch(() => ({ items: [] })),
    ...queries.map((w) => naverSearch("news", `${name} ${w}`, { display: 15, sort: "date" }).catch(() => ({ items: [] }))),
  ]);
  const toNews = (x: any) => ({ title: stripTags(x.title), desc: stripTags(x.description).slice(0, 140), link: x.originallink || x.link, date: new Date(Date.parse(x.pubDate) + 9 * 3600e3).toISOString().slice(0, 10) });
  const seen = new Set<string>();
  const uniq = (arr: any[]) => arr.filter((x) => { const k = x.title.replace(/\s+/g, "").slice(0, 28); if (seen.has(k)) return false; seen.add(k); return true; });
  const news = uniq((newsR.items || []).map(toNews)).slice(0, 20);
  const schedSnips = uniq(schedR.flatMap((r: any) => r.items || []).filter((x: any) => Date.parse(x.pubDate) >= since).map(toNews))
    .filter((x: any) => (x.title + x.desc).includes(name.slice(0, 2))).slice(0, 110);
  const photos = (photoR.items || []).map((x: any) => ({ thumb: httpsOnly(x.thumbnail || ""), full: httpsOnly(x.link || "") })).filter((x: any) => x.thumb).slice(0, 12);

  let schedule: any[] = [];
  const pool = [...schedSnips, ...news.filter((n) => !schedSnips.some((s) => s.link === n.link))].slice(0, 120);
  if (pool.length && CFG.llmKey) {
    const today = seoulDate();
    const prompt = `오늘은 ${today}입니다. 아래는 "${name}"${sub ? `(${sub})` : ""} 관련 최근 네이버 뉴스입니다.
"${name}" 본인(또는 소속 그룹·팀)이 참여하는, 오늘(${today}) 이후에 있거나 오늘 진행 중인 일정을 빠짐없이 모두 뽑으세요.
종류(type):
- match: 스포츠 경기·출전 예정 경기(상대팀 포함해 제목 작성, 예: "토트넘 vs 첼시")
- concert: 콘서트·투어 / fanmeeting: 팬미팅·팬사인회·팬콘
- comeback: 컴백·앨범·음원 발매 / release: 드라마 방영·영화 개봉·제작발표회
- broadcast: TV·라디오·예능 출연·방영 / youtube: 유튜브 채널·웹예능 출연·공개
- stage: 음악방송·무대·공연 출연 / festival: 대학 축제·페스티벌·지역 축제
- fashion: 패션쇼·브랜드 행사·화보 공개 / event: 시상식·광고·행사·기타 / ticket: 티켓 오픈·예매
규칙: 자료에 날짜가 나온 것만(요일·"다음 주 ○요일"처럼 날짜를 정확히 계산할 수 있으면 계산해서). 이미 지난 일정, 추측, 다른 사람의 일정은 제외. 같은 일정은 하나로.
JSON 하나만 출력: {"schedule":[{"date":"YYYY-MM-DD","endDate":"YYYY-MM-DD 또는 빈 문자열","time":"HH:MM 또는 빈 문자열","type":"위 종류 중 하나","title":"짧은 일정 이름(한국어)","place":"장소·채널·방송사 또는 빈 문자열","ref":자료 번호}]}
자료:
${pool.map((x, i) => `[${i}] (${x.date}) ${x.title} — ${x.desc.slice(0, 80)}`).join("\n")}`;
    try {
      const obj = parseJsonLoose(await llm(prompt, { maxTokens: 4000, temperature: 0.1 }));
      const arr = Array.isArray(obj?.schedule) ? obj.schedule : [];
      const keys = new Set<string>();
      const isD = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
      schedule = arr.filter((x: any) => isD(x?.date) && (isD(x.endDate) ? x.endDate : x.date) >= today && x.title)
        .map((x: any) => ({
          date: x.date, endDate: isD(x.endDate) ? x.endDate : "", time: /^\d{1,2}:\d{2}$/.test(x.time || "") ? x.time : "",
          type: SCH_TYPES.includes(x.type) ? x.type : "event",
          title: String(x.title).slice(0, 80), place: String(x.place || "").slice(0, 60),
          link: pool[Number(x.ref)]?.link || "",
        }))
        .filter((x: any) => { const k = x.date + x.title.replace(/\s/g, "").slice(0, 10); if (keys.has(k)) return false; keys.add(k); return true; })
        .sort((a: any, b: any) => a.date.localeCompare(b.date)).slice(0, 40);
    } catch (e) { console.warn("[star schedule]", (e as Error).message); }
  }
  return { name, news, photos, schedule, updatedAt: new Date().toISOString() };
}
async function getStarFeed(name: string, lang: string, force: boolean, sub = "") {
  const key = `star:v2:${hashId(name)}`;
  let base = (await cacheGet(key))?.data || null;
  const age = base ? Date.now() - Date.parse(base.updatedAt) : Infinity;
  let refreshing = false;
  const build = async () => {
    if (!(await tryLock(key))) return false;
    try { await cacheSet(key, await buildStarFeed(name, sub)); return true; } catch (e) { await unlock(key); throw e; }
  };
  if (!base) {
    if (!(await build())) { for (let i = 0; i < 30 && !base; i++) { await sleep(2000); base = (await cacheGet(key))?.data || null; } }
    base = base || (await cacheGet(key))?.data;
    if (!base) throw new HttpError(504, "trend_timeout");
  } else if (age > FEED_TTL || (force && age > 15 * 60e3)) {
    refreshing = true;
    background(build());
  }
  let out = base;
  if (lang !== "ko") {
    const texts = [...base.news.map((x: any) => x.title), ...base.schedule.map((x: any) => x.title), ...base.schedule.map((x: any) => x.place || "-")];
    try {
      const tr = await translateStrings(texts, lang);
      const n = base.news.length, m = base.schedule.length;
      out = {
        ...base,
        news: base.news.map((x: any, i: number) => ({ ...x, title: tr[i] || x.title, desc: "" })),
        schedule: base.schedule.map((x: any, i: number) => ({ ...x, title: tr[n + i] || x.title, place: x.place ? (tr[n + m + i] || x.place) : "" })),
      };
    } catch { /* 원문 */ }
  }
  return { ...out, refreshing };
}

/* ---------------- 요청 처리 ---------------- */
const CORS = {
  "Access-Control-Allow-Origin": CFG.allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8" } });
const langOf = (l: unknown) => (typeof l === "string" && LANG_NAMES[l] ? l : "ko");

async function handle(req: Request) {
  const body = await req.json().catch(() => ({}));
  switch (body.action) {
    case "config":
      return {
        features: {
          trends: !!CFG.llmKey, ranking: HAS_NAVER, places: !!CFG.kakaoRest, x: !!CFG.xBearer,
          translate: !!(CFG.llmKey || CFG.googleTranslateKey),
        },
        trendTtlMin: CFG.trendTtlMin,
      };
    case "trends":
      return getTrends(String(body.cat || ""), langOf(body.lang), body.force === true);
    case "warm":
      return warmOne();
    case "opinion": {
      const user = await getUser(req);
      if (!user) throw new HttpError(401, "login_required");
      if (!body.keyword) throw new HttpError(400, "keyword_required");
      await checkUsage(user.id, "ai", 30);
      return aiOpinion(String(body.keyword).slice(0, 80), String(body.title || body.keyword).slice(0, 120), langOf(body.lang));
    }
    case "translate": {
      const texts = body.texts;
      if (!Array.isArray(texts) || !texts.length || texts.length > 60) throw new HttpError(400, "texts_required");
      const lang = langOf(body.lang);
      const long = body.long === true;
      if (long && texts.length > 3) throw new HttpError(400, "texts_required");
      if (long) { const user = await getUser(req); if (!user) throw new HttpError(401, "login_required"); await checkUsage(user.id, "tr", 60); }
      return { texts: await translateStrings(texts.map((t: unknown) => String(t).slice(0, long ? 3000 : 300)), lang) };
    }
    case "star_search": {
      const q = String(body.q || "").trim().slice(0, 40);
      if (!q) return { results: [] };
      if (!HAS_NAVER) throw new HttpError(503, "naver_missing");
      return starSearch(q);
    }
    case "star_photos": {
      const name = String(body.name || "").trim().slice(0, 40);
      if (!name || !HAS_NAVER) return { photos: [] };
      return starPhotos(name);
    }
    case "star_feed": {
      const user = await getUser(req);
      if (!user) throw new HttpError(401, "login_required");
      const name = String(body.name || "").trim().slice(0, 40);
      if (!name) throw new HttpError(400, "name_required");
      if (!HAS_NAVER) throw new HttpError(503, "naver_missing");
      return getStarFeed(name, langOf(body.lang), body.force === true, String(body.sub || "").slice(0, 60));
    }
    case "places": {
      const q = String(body.q || "").trim();
      if (!q) return { places: [] };
      const page = Math.min(45, Math.max(1, Number(body.page) || 1));
      const base = { query: q, page, size: 15, sort: body.sort === "distance" && body.lat ? "distance" : "accuracy" };
      let r;
      if (body.lat && body.lng) {
        r = await kakao("/v2/local/search/keyword.json", { ...base, x: body.lng, y: body.lat, radius: 20000 });
        if (!(r.documents || []).length) r = await kakao("/v2/local/search/keyword.json", base);
      } else r = await kakao("/v2/local/search/keyword.json", base);
      return { places: (r.documents || []).map(normPlace), isEnd: !!r.meta?.is_end };
    }
    case "region": {
      const q = String(body.q || "").trim();
      if (!q) return { regions: [] };
      const r = await kakao("/v2/local/search/address.json", { query: q, analyze_type: "similar", size: 15 });
      let regions = (r.documents || []).filter((d: any) => d.address_type === "REGION").map((d: any) => ({ name: d.address_name, lat: Number(d.y), lng: Number(d.x) }));
      if (!regions.length) {
        const k = await kakao("/v2/local/search/keyword.json", { query: q, size: 5 });
        regions = (k.documents || []).map((d: any) => ({ name: d.place_name, sub: d.address_name, lat: Number(d.y), lng: Number(d.x) }));
      }
      return { regions };
    }
    default:
      throw new HttpError(400, "unknown_action");
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  try {
    return reply(await handle(req));
  } catch (e) {
    const err = e as HttpError;
    const status = err.status || 500;
    if (status >= 500) console.error(err.message);
    return reply({ error: err.message || "server_error" }, status);
  }
});
