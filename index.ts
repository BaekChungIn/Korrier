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
  llmModel: env("LLM_MODEL") || "openai/gpt-oss-120b",          // 트렌드 정리
  llmFastModel: env("LLM_FAST_MODEL") || "openai/gpt-oss-20b",   // 번역 (모델별 무료 한도가 따로라 분리)
  llmSearchModel: env("LLM_SEARCH_MODEL") || "groq/compound",    // 네이버 키가 없을 때 웹 검색용
  naverId: env("NAVER_CLIENT_ID"),
  naverSecret: env("NAVER_CLIENT_SECRET"),
  // 2026-07-31부터 신규 키는 네이버 클라우드 NAVER API HUB에서만 발급 → 기본값 hub. 예전 개발자센터 키면 legacy
  naverProvider: (env("NAVER_PROVIDER") || "hub").toLowerCase(),
  kakaoRest: env("KAKAO_REST_API_KEY"),
  googleTranslateKey: env("GOOGLE_TRANSLATE_API_KEY"),
  xBearer: env("X_BEARER_TOKEN"),
  trendTtlMin: Number(env("TREND_CACHE_MINUTES")) || 10,
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

/* ---------------- AI (OpenAI 호환 Chat Completions) ---------------- */
async function llm(prompt: string, { model = CFG.llmModel, json = true, temperature = 0.3, maxTokens = 4096 } = {}): Promise<string> {
  if (!CFG.llmKey) throw new HttpError(503, "LLM_API_KEY 미설정");
  const body: any = { model, messages: [{ role: "user", content: prompt }], temperature, max_tokens: maxTokens };
  if (json && !model.startsWith("groq/compound")) body.response_format = { type: "json_object" };
  if (model.startsWith("openai/gpt-oss")) body.reasoning_effort = "low";
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${CFG.llmBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${CFG.llmKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    const text = await res.text();
    // 무료 플랜 분당 한도 초과 → 잠시 기다렸다 재시도
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      const wait = Math.min(20, Number(res.headers.get("retry-after")) || 6 * (attempt + 1));
      await sleep(wait * 1000);
      continue;
    }
    let data: any = {};
    try { data = JSON.parse(text); } catch { /* */ }
    if (!res.ok) throw new HttpError(res.status === 429 ? 429 : 502, `AI: ${data?.error?.message || `HTTP ${res.status}`}`);
    return data?.choices?.[0]?.message?.content || "";
  }
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
  if (lang === "ko") return texts;
  const key = `str:${lang}:${hashId(JSON.stringify(texts))}`;
  const hit = await cacheGet(key);
  if (hit?.data) return hit.data;
  let out: any;
  if (CFG.googleTranslateKey) out = await googleTranslate(texts, lang);
  else {
    const text = await llm(`Translate each Korean string in "texts" into ${LANG_NAMES[lang]}. Keep proper nouns natural for travelers (localized name if widely used, otherwise romanize). Return JSON {"texts":[...]} with the same number of strings in the same order.\n${JSON.stringify({ texts })}`, { model: CFG.llmFastModel, temperature: 0.1, maxTokens: 2000 });
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
반드시 Google 검색을 여러 번 실행해서 최근 7일 이내 X(트위터), 인스타그램, 틱톡, 유튜브, 네이버 블로그·카페·뉴스, 커뮤니티에서 실제로 언급이 많은 것만 고르세요.
- 실존하지 않거나 확인되지 않은 정보는 절대 만들지 마세요. 확인 못 한 필드는 빈 문자열로 두세요.
- 오래된(수개월 전) 유행은 제외하세요.
- 결과는 JSON 배열 하나만 출력하세요. 설명 문장, 마크다운 금지.
- 정확히 15개 항목, 화제성 높은 순서대로.`;

const SPECS: Record<string, { ask: string; fields: string }> = {
  hotplace: {
    ask: "지금 대한민국에서 가장 핫한 장소(동네, 거리, 팝업스토어, 매장, 카페, 전시, 명소) 15곳",
    fields: '{"name":"장소 한국어 공식명","nameEn":"영문 표기","area":"시/도 + 구/군","address":"도로명 주소(모르면 빈 문자열)","summary":"지금 왜 화제인지 2~3문장(구체적인 최근 팝업/이벤트/이슈 포함)","searchKeyword":"네이버 검색용 핵심 검색어 1~3단어","sourceUrl":"근거 URL"}',
  },
  beauty: {
    ask: "지금 한국에서 가장 많이 팔리고 SNS에서 화제인 뷰티 제품(올리브영 랭킹, 화해, SNS 바이럴 기준) 15개",
    fields: '{"name":"브랜드 포함 한국어 정식 제품명","nameEn":"영문 제품명","brand":"브랜드","productType":"제품 종류","summary":"특징과 지금 인기 있는 이유 2~3문장","searchKeyword":"네이버 검색용(브랜드+제품 핵심명)","sourceUrl":"근거 URL"}',
  },
  "fashion-artist": {
    ask: "최근 2주 이내에 K-POP 아이돌·배우가 실제로 착용해 화제가 된 패션 아이템 15개(공항패션, 무대의상, 패션위크, 화보, 인스타그램 게시물 등)",
    fields: '{"artist":"아티스트명(그룹명)","brand":"브랜드","item":"아이템명","wornDate":"YYYY-MM-DD","wornWhere":"착용 장소/상황","price":"공식 판매가(원 단위, 모르면 빈 문자열)","summary":"착용 상황과 반응 2~3문장","searchKeyword":"브랜드+아이템 검색어","storeUrl":"브랜드 공식 홈페이지 URL","sourceUrl":"근거 기사/게시물 URL"}',
  },
  "fashion-musinsa": {
    ask: "무신사(MUSINSA) 현재 랭킹 상위 및 최근 판매 급상승 상품 15개",
    fields: '{"brand":"브랜드","item":"상품명","price":"판매가(원)","summary":"인기 이유 2문장","searchKeyword":"브랜드+상품 핵심명","sourceUrl":"근거 URL"}',
  },
  "fashion-ably": {
    ask: "에이블리(ABLY) 현재 랭킹 상위 및 최근 판매 급상승 상품 15개",
    fields: '{"brand":"마켓/브랜드","item":"상품명","price":"판매가(원)","summary":"인기 이유 2문장","searchKeyword":"브랜드+상품 핵심명","sourceUrl":"근거 URL"}',
  },
  concert: {
    ask: "오늘 이후(또는 현재 진행 중) 한국에서 열리는 콘서트·팬미팅 중 가장 화제인 15개",
    fields: '{"title":"공연명","artist":"아티스트","startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","venue":"공연장","city":"도시","ticketVendor":"예매처","ticketUrl":"예매 페이지 URL","summary":"공연 소개와 화제 포인트 2~3문장","searchKeyword":"아티스트+공연 검색어","sourceUrl":"근거 URL"}',
  },
  slang: {
    ask: "최근 한 달 사이 한국 SNS(X, 인스타그램, 틱톡, 유튜브 쇼츠, 커뮤니티)에서 실제로 많이 쓰이는 유행어·신조어 15개",
    fields: '{"word":"유행어","romanization":"국어의 로마자 표기법, 음절을 하이픈으로 구분(예: Jung-ji-jeong)","meaning":"짧은 뜻(15자 이내)","example":"자연스러운 한국어 예문 1개","nuance":"의미와 뉘앙스, 유래 2~3문장","searchKeyword":"검색어"}',
  },
};

function keyOf(cat: string, c: any): string {
  if (cat === "slang") return c.word;
  if (cat === "concert") return c.title;
  if (cat.startsWith("fashion")) return `${c.artist || ""} ${c.brand || ""} ${c.item || ""}`.trim();
  return c.name;
}

function baseItem(cat: string, c: any): any {
  const keyword = String(c.searchKeyword || keyOf(cat, c) || "").trim();
  const item: any = {
    id: hashId(cat + "|" + keyOf(cat, c)), cat, keyword,
    title: "", subtitle: "", desc: c.summary || "", tag: "", link: "", linkKind: "web",
    sourceUrl: isHttpUrl(c.sourceUrl) ? c.sourceUrl : "",
    image: null, location: null, shop: null, dates: null, price: "", slang: null,
  };
  switch (cat) {
    case "hotplace":
      Object.assign(item, { title: c.name, subtitle: c.nameEn || "", tag: c.area || "", linkKind: "map", location: { name: c.name, address: c.address || c.area || "" } });
      break;
    case "beauty":
      Object.assign(item, { title: c.name, subtitle: c.nameEn || c.brand || "", tag: c.productType || "", linkKind: "store" });
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
        title: c.title, subtitle: [c.venue, c.city].filter(Boolean).join(" · "), tag: c.artist || "",
        dates: { start: c.startDate || "", end: c.endDate || c.startDate || "" },
        location: { name: c.venue || "", address: c.city || "" },
        link: isHttpUrl(c.ticketUrl) ? c.ticketUrl : "", linkKind: "ticket", ticketVendor: c.ticketVendor || "",
      });
      break;
    case "slang":
      Object.assign(item, {
        title: c.word, subtitle: c.romanization || "", desc: c.nuance || "",
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
  if (it.location?.name) {
    tasks.push(kakaoFirstPlace(it.location.name).then((p) => {
      if (p) Object.assign(it.location, { address: p.address || it.location.address, lat: p.lat, lng: p.lng, kakaoUrl: p.url });
    }).catch(() => {}));
  }
  await Promise.all(tasks);
  if (it.cat === "hotplace") {
    const q = it.location?.lat ? `${it.location.lat},${it.location.lng}` : it.title;
    it.link = `https://www.google.com/maps/search/?api=1&query=${enc(q)}`;
  }
  if (!it.link) it.link = it.sourceUrl || `https://search.naver.com/search.naver?query=${enc(it.keyword)}`;
  return it;
}

/* ---------- 실제 최신 글 수집 (네이버 뉴스·블로그 최근 7일) ---------- */
const SEEDS: Record<string, string[]> = {
  hotplace: ["팝업스토어 오픈", "핫플 웨이팅", "요즘 핫플"],
  beauty: ["올리브영 랭킹", "품절 대란 화장품", "뷰티 신상 인기"],
  "fashion-artist": ["공항패션 착용", "아이돌 착용 브랜드", "사복 패션 화제"],
  "fashion-musinsa": ["무신사 랭킹", "무신사 인기 상품"],
  "fashion-ably": ["에이블리 랭킹", "에이블리 인기 상품"],
  concert: ["콘서트 티켓 오픈", "팬미팅 개최", "내한 공연 확정"],
  slang: ["신조어 뜻", "요즘 유행어", "MZ 유행어"],
};
type Snip = { t: string; d: string; link: string; kind: string; date: string };
async function collectSnippets(queries: string[], perQuery = 30, max = 26): Promise<Snip[]> {
  const since = Date.now() - 7 * 86400e3;
  const sinceBlog = seoulDate(-7).replace(/-/g, "");
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
const snipText = (snips: Snip[]) => snips.map((x, i) => `[${i}] (${x.kind} ${x.date}) ${x.t} — ${x.d.slice(0, 80)}`).join("\n");

async function buildTrends(cat: string) {
  const spec = SPECS[cat];
  const today = seoulDate();
  let hint = "";
  if (cat === "hotplace" || cat === "slang" || cat === "concert") {
    const gt = await googleTrendsKR().catch(() => []);
    if (gt.length) hint = `\n참고: 지금 구글 트렌드 한국 급상승 검색어(검색량): ${gt.join(", ")}\n관련 있는 것이 있으면 우선 반영하세요.`;
  }
  let text: string;
  let sources: { title: string; uri: string }[] = [];
  let snips: Snip[] = [];
  if (HAS_NAVER) {
    snips = await collectSnippets(SEEDS[cat]);
    if (snips.length < 5) throw new HttpError(502, "not_enough_data");
    text = await llm(`오늘은 ${today}(한국 시간)입니다. 아래는 최근 7일 동안 실제로 올라온 네이버 뉴스·블로그 글 목록입니다.${hint}
이 자료에 나온 내용만 근거로 ${spec.ask.replace("15개", "12개").replace("15곳", "12곳")}을(를) 화제성 높은 순서로 골라주세요.
- 자료에 없는 것은 절대 만들지 마세요. 모르는 필드는 빈 문자열.
- 여러 글에 반복해서 나온 것을 우선하세요.
- 각 항목에 근거가 된 글 번호를 "refs":[번호] 로 넣으세요.
- 결과는 {"items":[...]} 형태의 JSON 하나만 출력하세요.
각 항목 형식: ${spec.fields.replace(/,"sourceUrl":"[^"]*"/, "")} + "refs"

자료:
${snipText(snips)}`, { maxTokens: 3000 });
  } else {
    text = await llm(`${spec.ask}을(를) 웹 검색으로 찾아주세요.${COMMON_RULES(today)}${hint}\n결과는 {"items":[...]} 형태 JSON 하나만. 각 항목 형식: ${spec.fields}`, { model: CFG.llmSearchModel, maxTokens: 4000 });
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
  cands = cands.filter((c: any) => c && typeof c === "object" && keyOf(cat, c));
  if (cat === "concert") cands = cands.filter((c: any) => !c.endDate || c.endDate >= today);
  const seen = new Set<string>();
  let items = cands.map((c: any) => baseItem(cat, c)).filter((it: any) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
  const scored = await scoreItems(items);
  items = scored.items.slice(0, 10);
  await mapLimit(items, 4, enrichItem);
  items.forEach((it: any, i: number) => { it.rank = i + 1; });
  return { cat, items, sources: sources.slice(0, 12), basis: scored.basis, updatedAt: new Date().toISOString() };
}

async function translateTrend(result: any, lang: string) {
  if (lang === "ko") return result;
  const ck = `tr:${result.cat}:${lang}`;
  const hit = await cacheGet(ck);
  if (hit?.data && hit.data.updatedAt === result.updatedAt) return hit.data;

  const payload = result.items.map((it: any) => {
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
${JSON.stringify({ items: payload })}`;
  const text = await llm(prompt, { model: CFG.llmFastModel, temperature: 0.2, maxTokens: 4000 });
  const parsedTr = parseJsonLoose(text);
  const arr = Array.isArray(parsedTr) ? parsedTr : parsedTr?.items;
  if (!Array.isArray(arr)) throw new HttpError(502, "translate_parse_failed");
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

async function getTrends(cat: string, lang: string, force: boolean) {
  if (!SPECS[cat]) throw new HttpError(404, "unknown_category");
  const key = `trend:${cat}`;
  const ttl = CFG.trendTtlMin * 60e3;
  let row = await cacheGet(key);
  let base = row?.data || null;
  const age = base ? Date.now() - Date.parse(base.updatedAt) : Infinity;
  let stale = false;
  if (!base || age > ttl || (force && age > 2 * 60e3)) {
    if (await tryLock(key)) {
      try {
        base = await buildTrends(cat);
        await cacheSet(key, base);
      } catch (e) {
        await unlock(key);
        if (!base) throw e;
        console.warn("[trends] refresh failed, serving cache:", (e as Error).message);
        stale = true;
      }
    } else if (!base) {
      // 다른 요청이 검색 중 → 결과를 기다림 (최대 100초)
      for (let i = 0; i < 50 && !base; i++) {
        await sleep(2000);
        row = await cacheGet(key);
        base = row?.data || null;
      }
      if (!base) throw new HttpError(504, "trend_timeout");
    }
  }
  const out = await translateTrend(base, lang);
  return { ...out, stale, nextRefreshAt: new Date(Date.parse(base.updatedAt) + ttl).toISOString() };
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
  const text = await llm(prompt, { model: snips.length ? CFG.llmModel : CFG.llmSearchModel, maxTokens: 1500 });
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
      return { texts: await translateStrings(texts.map((t: unknown) => String(t).slice(0, 300)), lang) };
    }
    case "places": {
      const q = String(body.q || "").trim();
      if (!q) return { places: [] };
      const page = Math.min(45, Math.max(1, Number(body.page) || 1));
      const base = { query: q, page, size: 15, sort: "accuracy" };
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
