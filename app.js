/* =====================================================================
   Korrier 앱 로직
   ===================================================================== */
'use strict';

/* ---------------- 기본 유틸 ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const STAR_PATH = 'm12 3 2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4l-5.5 2.9 1-6.2L3 9.7l6.2-.9z';

const LS = { lang: 'korrier_lang', auto: 'korrier_auto', trip: 'korrier_trip_local' };

/* ---------------- 상태 ---------------- */
const S = {
  lang: localStorage.getItem(LS.lang) || 'ko',
  tab: 'hotplace',
  fashionSub: 'artist',
  platform: 'musinsa',
  config: null,
  user: null,
  trends: {},
  loading: {},
  errors: {},
  autoMin: Number(localStorage.getItem(LS.auto)) || 0,
  autoTimer: null,
  trip: null,
  tripReadOnly: false,
  sharedOwner: '',
  savedTrips: [],
  planDay: 'day1',
  placeType: 'spot',
  placeSel: null,
  wiz: null,
  shown: {},
  layers: { oy: true, hot: true, popup: true, venue: true },
  oyPois: null,
  oyKey: '',
  hotFilter: 'all',
  hotSel: null,
  detail: null,
  authMode: 'login',
};
if (!LANGS.some((l) => l.code === S.lang)) S.lang = 'ko';

/* ---------------- 번역 ---------------- */
const langIdx = () => Math.max(0, LANGS.findIndex((l) => l.code === S.lang));
const langInfo = () => LANGS[langIdx()];
function t(key, vars) {
  const row = I18N[key];
  let s = row ? (row[langIdx()] || row[0]) : key;
  if (vars) Object.keys(vars).forEach((k) => { s = s.split(`{${k}}`).join(vars[k]); });
  return s;
}
function applyI18n(root = document) {
  $$('[data-i18n]', root).forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-ph]', root).forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.documentElement.lang = S.lang;
}
function renderIcons(root = document) {
  $$('[data-icon]', root).forEach((el) => { if (!el.dataset.iconDone) { el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, el.dataset.iconCls || 'w-4 h-4')); el.dataset.iconDone = '1'; } });
}

/** 서버 번역이 필요한 동적 텍스트 (카카오 카테고리, 지역명 등) */
const dynCache = new Map();
async function translateDom(root) {
  if (S.lang === 'ko' || !(S.config && S.config.features.translate)) return;
  const els = $$('[data-tr]', root);
  const lang = S.lang;
  const need = [...new Set(els.map((e) => e.dataset.tr).filter((x) => x && !dynCache.has(lang + '|' + x)))].slice(0, 60);
  if (need.length) {
    try {
      const r = await fn('translate', { texts: need, lang });
      need.forEach((x, i) => dynCache.set(lang + '|' + x, r.texts[i]));
    } catch (e) { /* 원문 유지 */ }
  }
  if (lang !== S.lang) return;
  els.forEach((e) => { const v = dynCache.get(lang + '|' + e.dataset.tr); if (v) e.textContent = v; });
}
const trSpan = (text) => {
  const cached = S.lang !== 'ko' && dynCache.get(S.lang + '|' + text);
  return `<span data-tr="${esc(text)}">${esc(cached || text)}</span>`;
};

/* ---------------- Supabase / Edge Function ---------------- */
const CFGK = window.KORRIER_CONFIG || {};
const SB_READY = !!(window.supabase && CFGK.SUPABASE_URL && CFGK.SUPABASE_ANON_KEY && !/YOUR-/.test(CFGK.SUPABASE_URL + CFGK.SUPABASE_ANON_KEY));
const sb = SB_READY ? window.supabase.createClient(CFGK.SUPABASE_URL, CFGK.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'korrier-auth' } }) : null;
const appUrl = () => location.origin + location.pathname;
const mkErr = (code, status) => { const e = new Error(code); e.code = code; e.status = status; return e; };

/** Edge Function(korrier-api) 호출 */
async function fn(action, payload = {}) {
  if (!sb) throw mkErr('setup', 503);
  const { data } = await sb.auth.getSession();
  const session = data && data.session;
  const headers = { 'content-type': 'application/json', apikey: CFGK.SUPABASE_ANON_KEY };
  if (session) headers.Authorization = `Bearer ${session.access_token}`;
  else if (CFGK.SUPABASE_ANON_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${CFGK.SUPABASE_ANON_KEY}`;
  let res;
  try {
    res = await fetch(`${CFGK.SUPABASE_URL}/functions/v1/${CFGK.FUNCTION_NAME || 'korrier-api'}`, { method: 'POST', headers, body: JSON.stringify({ action, ...payload }) });
  } catch (e) { throw mkErr('network'); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { const err = mkErr(out.error || out.message || 'error', res.status); err.message = out.error || out.message || `HTTP ${res.status}`; throw err; }
  return out;
}
/** Supabase DB 결과 처리 */
function must({ data, error }) { if (error) { const e = mkErr(error.code || 'db', 500); e.message = error.message; throw e; } return data; }
function errText(e) {
  if (e && e.code && I18N['err_' + e.code]) return t('err_' + e.code);
  if (e && e.status === 503) return t('setupNeeded');
  return t('err_generic');
}

/* ---------------- 토스트 ---------------- */
let toastTimer;
function toast(msg, ic = 'check') {
  $('#toastIcon').innerHTML = icon(ic, 'w-3.5 h-3.5');
  $('#toastMsg').textContent = msg;
  const el = $('#toast');
  el.classList.remove('opacity-0', '-translate-y-2');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('opacity-0', '-translate-y-2'), 2400);
}
const toastErr = (e) => toast(errText(e), 'alert');

/* ---------------- 모달 공통 ---------------- */
const openModal = (id) => $('#' + id).classList.add('open');
const closeModal = (id) => $('#' + id).classList.remove('open');
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]');
  if (c) closeModal(c.dataset.close);
  ['authModal', 'profileModal', 'wizardModal', 'placeModal'].forEach((id) => { if (e.target.id === id) closeModal(id); });
});

/* ---------------- 탭 / 카테고리 ---------------- */
const TABS = [
  { key: 'map', icon: 'map', color: '#0071E3' },
  { key: 'hotplace', icon: 'pin', color: '#F59E0B' },
  { key: 'beauty', icon: 'sparkles', color: '#E11D48' },
  { key: 'fashion', icon: 'bag', color: '#4F46E5' },
  { key: 'concert', icon: 'ticket', color: '#2563EB' },
  { key: 'slang', icon: 'chat', color: '#34A853' },
];
const CAT_STYLE = {
  hotplace: { bg: '#FFF6ED', fg: '#F97316' },
  beauty: { bg: '#FFF1F3', fg: '#E11D48' },
  'fashion-artist': { bg: '#EEF0FF', fg: '#4F46E5' },
  'fashion-musinsa': { bg: '#F2F2F7', fg: '#1D1D1F' },
  'fashion-ably': { bg: '#FFF1F3', fg: '#E11D48' },
  concert: { bg: '#EAF2FF', fg: '#2563EB' },
  slang: { bg: '#EAF7EC', fg: '#4CAF50' },
};
function catKey() {
  if (S.tab === 'fashion') return S.fashionSub === 'artist' ? 'fashion-artist' : `fashion-${S.platform}`;
  return S.tab;
}

function renderTabBar() {
  $('#tabBar').innerHTML = TABS.map((tb) => {
    const on = tb.key === S.tab;
    return `<button data-tab="${tb.key}" class="flex-1 flex flex-col items-center justify-center gap-0.5 min-w-0 transition ${on ? 'font-semibold' : 'text-[#8E8E93] font-normal hover:text-[#1D1D1F]'}" style="${on ? `color:${tb.color}` : ''}">
      ${icon(tb.icon, 'w-[22px] h-[22px]', on ? 2 : 1.7)}
      <span class="text-[10.5px] tracking-tight truncate max-w-full px-0.5">${esc(t('nav_' + tb.key))}</span>
    </button>`;
  }).join('');
}
$('#tabBar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) selectTab(b.dataset.tab);
});

function selectTab(key) {
  S.tab = key;
  renderTabBar();
  updateCategoryTitle();
  $('#contentContainer').scrollTop = 0;
  if (key === 'map') { renderMapView(); }
  else { renderList(); loadTrends(false); }
}
function updateCategoryTitle() {
  const k = S.tab === 'map' ? 'title_map' : S.tab === 'hotplace' ? 'title_hotplace' : 'nav_' + S.tab;
  $('#categoryTitle').textContent = t(k);
  $('#liveBadge').classList.toggle('hidden', S.tab === 'map');
}

/* 패션 서브탭 */
function renderFashionTabs() {
  const on = 'bg-white text-[#1E3A8A] font-semibold shadow-sm';
  const off = 'text-[#8E8E93] hover:text-[#1D1D1F]';
  $('#subTabArtist').className = `py-2 rounded-xl flex items-center justify-center gap-1.5 transition ${S.fashionSub === 'artist' ? on : off}`;
  $('#subTabKFashion').className = `py-2 rounded-xl flex items-center justify-center gap-1.5 transition ${S.fashionSub !== 'artist' ? on : off}`;
  $('#platformArea').classList.toggle('hidden', S.fashionSub === 'artist');
  $('#platMusinsa').className = `flex-1 py-1.5 rounded-xl text-[12px] transition ${S.platform === 'musinsa' ? 'bg-[#1D1D1F] text-white font-semibold' : 'text-[#8E8E93]'}`;
  $('#platAbly').className = `flex-1 py-1.5 rounded-xl text-[12px] transition ${S.platform === 'ably' ? 'bg-[#E11D48] text-white font-semibold' : 'text-[#8E8E93]'}`;
}
$('#subTabArtist').onclick = () => { S.fashionSub = 'artist'; renderList(); loadTrends(false); };
$('#subTabKFashion').onclick = () => { S.fashionSub = 'kfashion'; renderList(); loadTrends(false); };
$('#platMusinsa').onclick = () => { S.platform = 'musinsa'; renderList(); loadTrends(false); };
$('#platAbly').onclick = () => { S.platform = 'ably'; renderList(); loadTrends(false); };

/* ---------------- 언어 / 자동 새로고침 메뉴 ---------------- */
function renderLangMenu() {
  $('#currentLangText').textContent = langInfo().label;
  $('#langMenu').innerHTML = LANGS.map((l) => `
    <button data-lang="${l.code}" class="w-full text-left px-4 py-2.5 hover:bg-black/[0.04] flex items-center gap-2">
      <span class="w-4 text-[#1D1D1F]">${l.code === S.lang ? icon('check', 'w-4 h-4', 2.2) : ''}</span><span>${esc(l.label)}</span>
    </button>`).join('');
}
function autoLabel(m) { return m === 0 ? t('auto_0') : m === 60 ? t('auto_60') : t('auto_n', { n: m }); }
function renderAutoMenu() {
  $('#currentAutoText').textContent = autoLabel(S.autoMin);
  $('#autoMenu').innerHTML = [0, 5, 10, 30, 60].map((m) => `
    <button data-auto="${m}" class="w-full text-left px-4 py-2.5 hover:bg-black/[0.04] flex items-center gap-2">
      <span class="w-4">${m === S.autoMin ? icon('check', 'w-4 h-4', 2.2) : ''}</span><span>${esc(autoLabel(m))}</span>
    </button>`).join('');
}
$('#btnLang').onclick = (e) => { e.stopPropagation(); $('#autoMenu').classList.add('hidden'); $('#langMenu').classList.toggle('hidden'); };
$('#btnAuto').onclick = (e) => { e.stopPropagation(); $('#langMenu').classList.add('hidden'); $('#autoMenu').classList.toggle('hidden'); };
document.addEventListener('click', (e) => {
  if (!e.target.closest('#langMenu') && !e.target.closest('#btnLang')) $('#langMenu').classList.add('hidden');
  if (!e.target.closest('#autoMenu') && !e.target.closest('#btnAuto')) $('#autoMenu').classList.add('hidden');
});
$('#langMenu').addEventListener('click', (e) => { const b = e.target.closest('[data-lang]'); if (b) changeLanguage(b.dataset.lang); });
$('#autoMenu').addEventListener('click', (e) => { const b = e.target.closest('[data-auto]'); if (b) setAuto(Number(b.dataset.auto), true); });

function changeLanguage(code) {
  S.lang = code;
  localStorage.setItem(LS.lang, code);
  $('#langMenu').classList.add('hidden');
  refreshAllText();
  if (S.user && sb) sb.from('korrier_profiles').update({ lang: code }).eq('id', S.user.id).then(() => {});
  if (S.tab === 'map') renderMapView(); else { renderList(); loadTrends(false); }
  prefetchAll();
  if (S.detail) renderDetail();
  toast(t('toast_langChanged'), 'globe');
}
function refreshAllText() {
  applyI18n();
  renderLangMenu();
  renderAutoMenu();
  renderTabBar();
  updateCategoryTitle();
  renderProfileButton();
  renderAuthModal();
  updateClock();
}

function setAuto(min, notify) {
  S.autoMin = min;
  localStorage.setItem(LS.auto, String(min));
  clearInterval(S.autoTimer);
  S.autoTimer = null;
  if (min > 0) S.autoTimer = setInterval(async () => {
    if (S.tab === 'map') return;
    const cat = catKey(); const lang = S.lang;
    const old = S.trends[`${cat}|${lang}`];
    try {
      const d = await fetchCat(cat, lang, false);
      if ((!old || old.updatedAt !== d.updatedAt) && catKey() === cat && S.lang === lang) { renderList(); toast(t('toast_refreshed'), 'refresh'); }
    } catch {}
  }, min * 60e3);
  renderAutoMenu();
  $('#autoMenu').classList.add('hidden');
  if (notify) toast(t('toast_autoSet', { v: autoLabel(min) }), 'timer');
}

/* ---------------- 시계 ---------------- */
function updateClock() {
  const now = new Date();
  const loc = langInfo().locale;
  const d = new Intl.DateTimeFormat(loc, { year: 'numeric', month: 'short', day: '2-digit' }).format(now);
  const tm = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now);
  $('#liveClock').textContent = `${d} • ${tm}`.toUpperCase();
}
function relTime(iso) {
  const diffMin = Math.round((Date.parse(iso) - Date.now()) / 60e3);
  if (Math.abs(diffMin) < 1) return t('justNow');
  const rtf = new Intl.RelativeTimeFormat(langInfo().locale, { numeric: 'auto' });
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');
  return rtf.format(Math.round(diffMin / 60), 'hour');
}

/* ---------------- 트렌드 로딩 ---------------- */
const ALL_CATS = ['hotplace', 'beauty', 'fashion-artist', 'fashion-musinsa', 'fashion-ably', 'concert', 'slang'];
const trendData = (cat) => S.trends[`${cat}|${S.lang}`] || S.trends[`${cat}|ko`];

/** 한 카테고리 불러오기 (같은 요청은 한 번만) */
function fetchCat(cat, lang, force) {
  const key = `${cat}|${lang}`;
  if (S.loading[key]) return S.loading[key];
  delete S.errors[key];
  const p = (async () => {
    try {
      const data = await fn('trends', { cat, lang, force: !!force });
      S.trends[key] = data;
      // 서버가 오래된 결과를 주고 뒤에서 새로 검색 중이면 잠시 뒤 다시 받아옴
      if (data.refreshing) setTimeout(() => fetchCat(cat, lang, false).then(() => afterFetch(cat, lang)).catch(() => {}), 45000);
      return data;
    } catch (e) { S.errors[key] = e; throw e; }
    finally { delete S.loading[key]; }
  })();
  S.loading[key] = p;
  return p;
}
function afterFetch(cat, lang) {
  if (S.lang !== lang) return;
  if (S.tab !== 'map' && catKey() === cat) renderList();
  if ((cat === 'hotplace' || cat === 'concert')) {
    if (S.tab === 'map' && S.trip) { renderLayerChips(); drawMap(false); }
    if (!$('#hotMapOverlay').classList.contains('hidden') && cat === 'hotplace') drawHotMap(false);
  }
}
/** 앱을 열면 모든 탭을 미리 검색해 둠 */
async function prefetchAll() {
  const lang = S.lang;
  const queue = ALL_CATS.filter((c) => !S.trends[`${c}|${lang}`]);
  let i = 0;
  const worker = async () => {
    while (i < queue.length && S.lang === lang) {
      const c = queue[i++];
      try { await fetchCat(c, lang, false); } catch {}
      afterFetch(c, lang);
    }
  };
  await Promise.all([worker(), worker()]);
}

async function loadTrends(force, silent) {
  const cat = catKey();
  const lang = S.lang;
  const key = `${cat}|${lang}`;
  const cached = S.trends[key];
  if (!force && cached && Date.parse(cached.nextRefreshAt) > Date.now()) { renderList(); return; }
  $('#refreshIcon').classList.add('animate-spin');
  const p = fetchCat(cat, lang, force);
  renderList();
  try {
    await p;
    if (force && !silent) toast(t('toast_refreshed'), 'refresh');
  } catch {} finally {
    $('#refreshIcon').classList.remove('animate-spin');
    afterFetch(cat, lang);
  }
}
$('#btnRefresh').onclick = () => { if (S.tab === 'map') { renderMapView(); toast(t('toast_refreshed'), 'refresh'); } else loadTrends(true); };

/* ---------------- 목록 렌더링 ---------------- */
function renderMeta(data) {
  const el = $('#metaLine');
  if (!data) { el.classList.add('hidden'); return; }
  const basis = (data.basis || []).map((b) => t('basis_' + b)).join(' · ');
  el.innerHTML = `
    <div class="flex items-center gap-1">${icon('clock', 'w-3 h-3')}<span>${esc(t('updated', { t: relTime(data.updatedAt) }))}</span></div>
    <div class="flex items-start gap-1 mt-0.5">${icon('trend', 'w-3 h-3 mt-[2px] shrink-0')}<span>${esc(t('rankBasis'))}: ${esc(basis)}</span></div>
    ${data.stale ? `<div class="flex items-center gap-1 mt-0.5 text-amber-600">${icon('alert', 'w-3 h-3')}<span>${esc(t('stale'))}</span></div>` : ''}`;
  el.classList.remove('hidden');
}

function renderList() {
  const area = $('#listArea');
  $('#mapView').classList.add('hidden');
  area.classList.remove('hidden');
  $('#fashionSubTabs').classList.toggle('hidden', S.tab !== 'fashion');
  if (S.tab === 'fashion') renderFashionTabs();

  const cat = catKey();
  const key = `${cat}|${S.lang}`;
  const data = S.trends[key];
  const err = S.errors[key];
  const loading = S.loading[key];
  renderMeta(data);

  if (!data && loading) { area.innerHTML = loadingHtml(); return; }
  if (!data && err) { area.innerHTML = errorHtml(err); return; }
  if (!data) { area.innerHTML = loadingHtml(); return; }
  if (!data.items || !data.items.length) { area.innerHTML = `<div class="text-center text-[13px] text-[#8E8E93] py-10">${esc(t('empty'))}</div>`; return; }

  const errBanner = err ? `<div class="bg-amber-50 border border-amber-100 text-amber-800 text-[12px] rounded-2xl px-4 py-2.5 flex items-center gap-2">${icon('alert', 'w-4 h-4')}<span>${esc(errText(err))}</span></div>` : '';
  const total = data.items.length;
  const shown = Math.min(total, S.shown[cat] || 10);
  const items = data.items.slice(0, shown);
  const body = cat === 'slang' ? slangHtml(items) : items.map(cardHtml).join('');
  const more = total > shown ? `<button data-more="${esc(cat)}" class="w-full py-3.5 rounded-[22px] bg-white border border-black/[0.05] text-[14px] font-semibold flex items-center justify-center gap-1.5 active:scale-[0.99] transition">${icon('chevD', 'w-4 h-4')}${esc(t('more', { a: shown + 1, b: Math.min(total, shown + 10), n: total }))}</button>` : '';
  const hotBtn = cat === 'hotplace' ? hotMapButtonHtml(data) : '';
  area.innerHTML = errBanner + hotBtn + body + more + sourcesHtml(data.sources);
  if (cat === 'slang') bindSlangCarousel();
}

function loadingHtml() {
  const sk = Array.from({ length: 3 }, () => `
    <div class="bg-white rounded-[28px] p-5 border border-black/[0.03]"><div class="flex gap-4">
      <div class="w-11 h-11 rounded-[16px] skeleton"></div>
      <div class="flex-1 space-y-2"><div class="h-4 w-2/3 rounded skeleton"></div><div class="h-3 w-1/3 rounded skeleton"></div><div class="h-3 w-full rounded skeleton"></div></div>
    </div></div>`).join('');
  const translating = S.lang !== 'ko' && S.trends[`${catKey()}|ko`];
  return `
    <div class="bg-white rounded-[28px] p-5 border border-black/[0.03] flex items-start gap-3">
      <div class="w-9 h-9 rounded-full bg-[#E8F5E9] text-[#2E7D32] flex items-center justify-center shrink-0"><div class="w-4 h-4 border-2 border-[#34C759] border-t-transparent rounded-full animate-spin"></div></div>
      <div><p class="text-[14px] font-semibold">${esc(translating ? t('translating') : t('loadingTitle'))}</p><p class="text-[12px] text-[#8E8E93] mt-0.5 leading-relaxed">${esc(t('loadingSub'))}</p></div>
    </div>${sk}`;
}
function errorHtml(e) {
  return `<div class="bg-white rounded-[28px] p-6 border border-black/[0.03] text-center">
    <div class="w-12 h-12 rounded-full bg-rose-50 text-rose-500 mx-auto flex items-center justify-center mb-3">${icon('alert', 'w-6 h-6')}</div>
    <p class="text-[15px] font-semibold">${esc(t('errorTitle'))}</p>
    <p class="text-[12px] text-[#8E8E93] mt-1">${esc(errText(e))}</p>
    ${e.status && e.status !== 503 && e.message ? `<p class="text-[10px] text-[#AEAEB2] mt-2 break-all">${esc(e.message)}</p>` : ''}
    <button onclick="loadTrends(true)" class="mt-4 px-5 py-2.5 rounded-full bg-[#1D1D1F] text-white text-[13px] font-medium inline-flex items-center gap-1.5">${icon('refresh', 'w-4 h-4')}${esc(t('retry'))}</button>
  </div>`;
}
function sourcesHtml(sources) {
  if (!sources || !sources.length) return '';
  return `<details class="bg-white rounded-[22px] px-5 py-3 border border-black/[0.03] text-[12px]">
    <summary class="cursor-pointer text-[#8E8E93] font-medium flex items-center gap-1.5">${icon('link', 'w-3.5 h-3.5')}${esc(t('sources'))} (${sources.length})</summary>
    <ul class="mt-2 space-y-1.5">${sources.map((s) => `<li><a href="${esc(safeUrl(s.uri))}" target="_blank" rel="noopener noreferrer" class="text-[#0071E3] hover:underline break-all">${esc(s.title || s.uri)}</a></li>`).join('')}</ul>
  </details>`;
}

function hotMapButtonHtml(data) {
  const n = data.items.filter((it) => it.location && it.location.lat).length;
  return `<button data-hotmap="1" class="w-full text-left bg-white rounded-[24px] p-4 border border-black/[0.04] shadow-[0_2px_14px_rgba(0,0,0,0.03)] flex items-center gap-3 active:scale-[0.99] transition">
    <span class="w-12 h-12 rounded-2xl bg-[#FFF1E6] text-[#F97316] flex items-center justify-center shrink-0">${icon('map', 'w-6 h-6')}</span>
    <span class="flex-1 min-w-0"><span class="block text-[15px] font-bold">${esc(t('hotMap'))}</span><span class="block text-[12px] text-[#8E8E93]">${esc(t('hotMapDesc', { n }))}</span></span>
    <span class="text-[#C7C7CC]">${icon('chevR', 'w-5 h-5')}</span>
  </button>`;
}

function cardHtml(it) {
  const st = CAT_STYLE[it.cat] || CAT_STYLE.hotplace;
  let tag = '';
  if (it.cat === 'concert' && it.dates && it.dates.start) {
    tag = `<span class="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-lg bg-[#EAF2FF] text-[#2563EB]">${icon('calendar', 'w-3.5 h-3.5')}${esc(it.dates.start)}${it.dates.end && it.dates.end !== it.dates.start ? ' ~ ' + esc(it.dates.end) : ''}</span>`;
  } else if (it.cat === 'fashion-artist' && it.tag) {
    tag = `<span class="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-lg bg-[#EEF0FF] text-[#4F46E5]">${icon('star', 'w-3.5 h-3.5')}By ${esc(it.tag)}</span>`;
  } else if (it.tag) {
    tag = `<span class="inline-flex items-center gap-1 text-[11px] text-[#8E8E93]">${icon(it.cat === 'hotplace' ? 'pin' : 'tag', 'w-3 h-3')}${esc(it.tag)}</span>`;
  }
  const price = it.shop && it.shop.lowPrice ? `<span class="inline-flex items-center gap-1">${icon('store', 'w-3 h-3')}${esc(t('lowestPrice'))} ${it.shop.lowPrice.toLocaleString()}₩</span>` : '';
  return `<button data-item="${esc(it.id)}" class="w-full text-left bg-white rounded-[28px] p-5 shadow-[0_2px_14px_rgba(0,0,0,0.03)] border border-black/[0.03] hover:shadow-[0_8px_24px_rgba(0,0,0,0.06)] transition-all active:scale-[0.99]">
    <div class="flex items-start gap-4">
      <div class="w-11 h-11 rounded-[16px] flex items-center justify-center text-[17px] font-semibold shrink-0" style="background:${st.bg};color:${st.fg}">${it.rank}</div>
      <div class="flex-1 min-w-0">
        ${tag ? `<div class="mb-1.5">${tag}</div>` : ''}
        <h4 class="${it.cat === 'concert' ? 'text-[20px] font-bold' : 'text-[17px] font-semibold'} tracking-tight leading-snug truncate">${esc(it.title)}</h4>
        ${it.subtitle ? `<p class="${it.cat === 'concert' ? 'text-[14px] font-semibold' : 'text-[13px] font-medium'} mt-0.5 truncate" style="color:${st.fg}">${esc(it.subtitle)}</p>` : ''}
        ${it.cat === 'concert' && it.tag ? `<p class="text-[12px] text-[#6E6E73] mt-1 truncate flex items-center gap-1">${icon('pin', 'w-3.5 h-3.5 shrink-0')}${esc(it.tag)}</p>` : ''}
        <p class="text-[13px] text-[#8E8E93] font-light mt-1.5 line-clamp-2 leading-relaxed">${esc(it.desc)}</p>
        <div class="flex items-center gap-3 mt-2 text-[11px] text-[#AEAEB2]">
          <span class="inline-flex items-center gap-1">${icon('trend', 'w-3 h-3')}${esc(t('score', { n: it.score ?? '-' }))}</span>${price}
        </div>
      </div>
    </div>
  </button>`;
}

/* 유행어: 사진 속 디자인 (가로 스와이프 카드) */
function slangHtml(items) {
  const cards = items.map((it) => {
    const s = it.slang || {};
    const line = S.lang === 'ko' ? s.meaning : [s.pron, s.meaning ? `(${s.meaning})` : ''].filter(Boolean).join(' ');
    return `<article class="snap-center shrink-0 w-full bg-white rounded-[40px] px-7 pt-8 pb-7 border border-black/[0.04] shadow-[0_2px_18px_rgba(0,0,0,0.04)]">
      <span class="inline-block px-4 py-1.5 rounded-full bg-[#EAF7EC] text-[#5CB85F] text-[14px] font-medium">${esc(t('rank', { n: it.rank }))}</span>
      <h2 class="text-[46px] font-black tracking-tight leading-[1.1] mt-7 break-keep">${esc(it.title)}</h2>
      ${it.subtitle ? `<p class="text-[22px] font-semibold italic text-[#5CB85F] mt-2">${esc(it.subtitle)}</p>` : ''}
      ${line ? `<p class="text-[16px] text-[#6E6E73] mt-2 leading-snug">${esc(line)}</p>` : ''}
      <div class="bg-[#F2F2F7] rounded-[26px] px-5 py-5 mt-7">
        <p class="text-[13px] text-[#8E8E93] mb-2">${esc(t('example'))}</p>
        <p class="text-[17px] font-semibold leading-relaxed">"${esc(s.example)}"</p>
        ${s.exampleTr ? `<p class="text-[14px] text-[#6E6E73] mt-2 leading-relaxed">${esc(s.exampleTr)}</p>` : ''}
      </div>
      <p class="text-[13px] text-[#8E8E93] mt-7 mb-2">${esc(t('nuance'))}</p>
      <div class="bg-[#EDF7EE] rounded-[26px] px-5 py-5 text-[15px] leading-relaxed text-[#2F3B30]">${esc(it.desc)}</div>
      <div class="grid grid-cols-3 gap-2 mt-5">
        <a href="${esc(safeUrl(it.link))}" target="_blank" rel="noopener noreferrer" class="py-2.5 rounded-2xl bg-[#F2F2F7] text-[12px] font-medium flex flex-col items-center gap-1">${icon('hash', 'w-4 h-4')}${esc(t('xReaction'))}</a>
        <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(it.original || it.title)}" target="_blank" rel="noopener noreferrer" class="py-2.5 rounded-2xl bg-[#F2F2F7] text-[12px] font-medium flex flex-col items-center gap-1">${icon('play', 'w-4 h-4')}${esc(t('youtube'))}</a>
        <button data-ai="${esc(it.id)}" class="py-2.5 rounded-2xl bg-[#F2F2F7] text-[12px] font-medium flex flex-col items-center gap-1 text-[#7C3AED]">${icon('sparkles', 'w-4 h-4')}${esc(t('aiOpinion'))}</button>
      </div>
    </article>`;
  }).join('');
  return `<div>
    <div id="slangCarousel" class="flex gap-3 overflow-x-auto snap-x-mandatory no-scrollbar scroll-smooth">${cards}</div>
    <div class="flex items-center justify-between mt-3 px-1">
      <button id="slangPrev" class="w-9 h-9 rounded-full bg-white border border-black/[0.06] flex items-center justify-center">${icon('chevL', 'w-4 h-4')}</button>
      <div id="slangDots" class="text-[13px] font-semibold text-[#5CB85F]">1 / ${items.length}</div>
      <button id="slangNext" class="w-9 h-9 rounded-full bg-white border border-black/[0.06] flex items-center justify-center">${icon('chevR', 'w-4 h-4')}</button>
    </div>
  </div>`;
}
function bindSlangCarousel() {
  const car = $('#slangCarousel');
  if (!car) return;
  const n = car.children.length;
  const update = () => {
    const i = Math.round(car.scrollLeft / (car.clientWidth + 12));
    $('#slangDots').textContent = `${Math.min(n, i + 1)} / ${n}`;
  };
  if (S.slangJump) { const j = S.slangJump; S.slangJump = 0; car.style.scrollBehavior = 'auto'; car.scrollLeft = j * (car.clientWidth + 12); car.style.scrollBehavior = ''; update(); }
  car.addEventListener('scroll', debounce(update, 60));
  $('#slangPrev').onclick = () => car.scrollBy({ left: -(car.clientWidth + 12), behavior: 'smooth' });
  $('#slangNext').onclick = () => car.scrollBy({ left: car.clientWidth + 12, behavior: 'smooth' });
}

function findItem(id) {
  const data = S.trends[`${catKey()}|${S.lang}`];
  return data && data.items.find((x) => x.id === id);
}
$('#listArea').addEventListener('click', (e) => {
  const more = e.target.closest('[data-more]');
  if (more) {
    const cat = more.dataset.more;
    const prev = S.shown[cat] || 10;
    S.shown[cat] = prev + 10;
    if (cat === 'slang') S.slangJump = prev;
    renderList();
    return;
  }
  if (e.target.closest('[data-hotmap]')) { openHotMap(); return; }
  const ai = e.target.closest('[data-ai]');
  if (ai) { const it = findItem(ai.dataset.ai); if (it) { openDetail(it); fetchOpinion(); } return; }
  const card = e.target.closest('[data-item]');
  if (card) { const it = findItem(card.dataset.item); if (it) openDetail(it); }
});

/* ---------------- 상세 시트 ---------------- */
function openDetail(it) {
  S.detail = { it, opinion: null, opLoading: false, opError: null };
  renderDetail();
  $('#sheetBackdrop').classList.remove('hidden');
  const sh = $('#detailSheet');
  sh.classList.remove('hidden'); sh.classList.add('flex', 'sheet-enter');
  $('#detailBody').scrollTop = 0;
}
function closeDetail() {
  S.detail = null;
  $('#sheetBackdrop').classList.add('hidden');
  const sh = $('#detailSheet');
  sh.classList.add('hidden'); sh.classList.remove('flex', 'sheet-enter');
}
$('#sheetBackdrop').onclick = closeDetail;
$('#sheetHandle').onclick = closeDetail;

function starsHtml(r) {
  let h = '';
  for (let i = 0; i < 5; i++) {
    const f = Math.max(0, Math.min(1, r - i)) * 100;
    const id = 'st' + Math.random().toString(36).slice(2, 8);
    h += `<svg class="w-5 h-5" viewBox="0 0 24 24"><defs><linearGradient id="${id}"><stop offset="${f}%" stop-color="#F59E0B"/><stop offset="${f}%" stop-color="#E5E7EB"/></linearGradient></defs><path d="${STAR_PATH}" fill="url(#${id})"/></svg>`;
  }
  return h;
}

function actionBtn({ href, onclick, ic, label, color = '#1D1D1F' }) {
  const inner = `<span class="w-11 h-11 rounded-full bg-white flex items-center justify-center shadow-sm" style="color:${color}">${icon(ic, 'w-5 h-5')}</span><span class="text-[11.5px] font-medium text-center leading-tight">${esc(label)}</span>`;
  const cls = 'rounded-[22px] bg-[#F2F2F7] hover:bg-[#E9E9EE] py-3.5 px-1 flex flex-col items-center gap-2 active:scale-95 transition';
  return href
    ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" class="${cls}">${inner}</a>`
    : `<button data-act="${onclick}" class="${cls}">${inner}</button>`;
}

function renderDetail() {
  if (!S.detail) return;
  // 언어가 바뀐 경우 같은 항목의 번역본으로 교체
  const fresh = findItem(S.detail.it.id);
  if (fresh) S.detail.it = fresh;
  const it = S.detail.it;
  const st = CAT_STYLE[it.cat] || CAT_STYLE.hotplace;
  const loc = it.location || {};
  const hasCoords = loc.lat && loc.lng;
  const searchName = it.original || it.title;

  const metas = [];
  if (loc.address) metas.push(`<div class="flex items-start gap-2">${icon('pin', 'w-4 h-4 mt-0.5 shrink-0')}<span>${esc(loc.name && loc.name !== it.title ? loc.name + ' · ' : '')}${esc(loc.address)}</span></div>`);
  if (it.dates && it.dates.start) metas.push(`<div class="flex items-center gap-2">${icon('calendar', 'w-4 h-4')}<span>${esc(it.dates.start)}${it.dates.end && it.dates.end !== it.dates.start ? ' ~ ' + esc(it.dates.end) : ''}</span></div>`);
  if (it.price) metas.push(`<div class="flex items-center gap-2">${icon('tag', 'w-4 h-4')}<span>${esc(t('officialPrice'))}: <b>${esc(it.price)}</b></span></div>`);
  if (it.shop && it.shop.lowPrice) metas.push(`<div class="flex items-center gap-2">${icon('store', 'w-4 h-4')}<span>${esc(t('lowestPrice'))}: <b class="text-[#E11D48]">${it.shop.lowPrice.toLocaleString()}₩</b> · ${esc(it.shop.mall || '')}</span></div>`);
  const sg = it.signals || {};
  if (sg.search != null || sg.blog != null) {
    metas.push(`<div class="flex items-center gap-2 text-[11px] opacity-80">${icon('trend', 'w-4 h-4')}<span>${esc(t('signals', { s: sg.search ?? '-', b: sg.blog ?? '-', n: sg.news ?? '-' }))}${sg.x != null ? esc(t('signalsX', { x: sg.x })) : ''}</span></div>`);
  }

  const ctaKey = { map: 'cta_map', ticket: 'cta_ticket', store: 'cta_store', x: 'cta_x' }[it.linkKind] || 'cta_web';
  const cta = safeUrl(it.link) ? `<a href="${esc(it.link)}" target="_blank" rel="noopener noreferrer" class="w-full py-3.5 px-4 bg-[#E11D48] hover:bg-[#BE123C] text-white font-medium text-[14px] rounded-2xl shadow-sm flex items-center justify-center gap-2 active:scale-95 transition">${icon('external', 'w-4 h-4')}<span>${esc(t(ctaKey))}</span></a>` : '';

  const yt = `https://www.youtube.com/results?search_query=${encodeURIComponent(it.keyword || searchName)}`;
  const acts = [];
  if (it.cat === 'beauty') {
    acts.push(actionBtn({ href: `https://map.kakao.com/?q=${encodeURIComponent('올리브영')}`, ic: 'store', label: t('oliveStore') }));
    acts.push(actionBtn({ href: (it.shop && safeUrl(it.shop.compareUrl)) || `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(it.keyword)}`, ic: 'tag', label: t('lowestFind'), color: '#E11D48' }));
  } else if (hasCoords || loc.name) {
    const gq = hasCoords ? `${loc.lat},${loc.lng}` : loc.name;
    acts.push(actionBtn({ href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(gq)}`, ic: 'pin', label: t('location') }));
  } else if (it.cat.startsWith('fashion')) {
    acts.push(actionBtn({ href: (it.shop && safeUrl(it.shop.compareUrl)) || `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(it.keyword)}`, ic: 'tag', label: t('lowestFind'), color: '#E11D48' }));
  }
  acts.push(actionBtn({ href: yt, ic: 'play', label: t('youtube'), color: '#FF0000' }));
  acts.push(actionBtn({ onclick: 'ai', ic: 'sparkles', label: t('aiOpinion'), color: '#7C3AED' }));
  const cols = acts.length === 4 ? 'grid-cols-4' : acts.length === 2 ? 'grid-cols-2' : 'grid-cols-3';

  const extra = [];
  if (hasCoords && loc.kakaoUrl) extra.push(`<a href="${esc(safeUrl(loc.kakaoUrl))}" target="_blank" rel="noopener noreferrer" class="flex-1 py-2.5 rounded-xl bg-[#FEE500]/80 text-[#3C1E1E] text-[12px] font-medium flex items-center justify-center gap-1.5">${icon('map', 'w-4 h-4')}${esc(t('kakaoMap'))}</a>`);
  if (hasCoords && !S.tripReadOnly) extra.push(`<button data-act="addtrip" class="flex-1 py-2.5 rounded-xl bg-[#0071E3]/10 text-[#0071E3] text-[12px] font-medium flex items-center justify-center gap-1.5">${icon('plus', 'w-4 h-4')}${esc(t('addToTrip'))}</button>`);

  const img = it.image && safeUrl(it.image.url) ? `
    <a href="${esc(safeUrl(it.link) || safeUrl(it.image.url))}" target="_blank" rel="noopener noreferrer" class="block relative rounded-[22px] overflow-hidden border border-black/[0.05] bg-[#F2F2F7]">
      <img src="${esc(it.image.url)}" data-thumb="${esc(safeUrl(it.image.thumb))}" referrerpolicy="no-referrer" alt="" class="w-full h-52 object-cover" onerror="if(this.dataset.thumb&&this.src!==this.dataset.thumb){this.src=this.dataset.thumb}else{this.closest('a').remove()}">
      <span class="absolute bottom-2 right-2 text-[10px] text-white bg-black/40 backdrop-blur px-2 py-0.5 rounded-full">${esc(t('imageCredit'))}</span>
    </a>` : '';

  $('#detailBody').innerHTML = `
    <div>
      <div class="flex items-center gap-2 mb-2 flex-wrap">
        <span class="text-[13px] font-medium px-3 py-1 rounded-full" style="background:${st.bg};color:${st.fg}">${esc(t('rank', { n: it.rank }))}</span>
        ${it.tag ? `<span class="text-[11px] px-2.5 py-1 rounded-full bg-[#F2F2F7] text-[#6E6E73]">${esc(it.tag)}</span>` : ''}
      </div>
      <h3 class="text-[24px] font-bold tracking-tight leading-tight">${esc(it.title)}</h3>
      ${it.subtitle ? `<p class="text-[14px] font-medium mt-1" style="color:${st.fg}">${esc(it.subtitle)}</p>` : ''}
    </div>
    ${img}
    <div class="bg-[#F2F2F7] rounded-[22px] p-5"><p class="text-[15px] text-[#3A3A3C] leading-relaxed">${esc(it.desc)}</p></div>
    ${metas.length ? `<div class="bg-blue-50/70 border border-blue-100 rounded-[18px] p-3.5 text-[12.5px] text-blue-900 space-y-1.5">${metas.join('')}</div>` : ''}
    ${cta}
    <div class="grid ${cols} gap-2.5">${acts.join('')}</div>
    ${extra.length ? `<div class="flex gap-2">${extra.join('')}</div>` : ''}
    <div id="aiBox">${opinionHtml()}</div>
    ${safeUrl(it.sourceUrl) ? `<a href="${esc(it.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="flex items-center gap-1.5 text-[11px] text-[#8E8E93] hover:text-[#0071E3]">${icon('link', 'w-3.5 h-3.5')}${esc(t('source'))}: <span class="truncate">${esc(it.sourceUrl)}</span></a>` : ''}
    <button data-act="close" class="w-full py-3 rounded-2xl bg-[#F2F2F7] text-[14px] font-medium">${esc(t('back'))}</button>`;
}

function opinionHtml() {
  const d = S.detail;
  if (!d) return '';
  if (d.opLoading) return `<div class="rounded-[24px] border border-black/[0.06] p-5 flex items-center gap-3"><div class="w-5 h-5 border-2 border-[#7C3AED] border-t-transparent rounded-full animate-spin"></div><span class="text-[13px] text-[#6E6E73]">${esc(t('analyzing'))}</span></div>`;
  if (d.opError) return `<div class="rounded-[24px] border border-rose-100 bg-rose-50 p-4 text-[12px] text-rose-700 flex items-center gap-2">${icon('alert', 'w-4 h-4')}${esc(errText(d.opError))}</div>`;
  const o = d.opinion;
  if (!o) return '';
  const list = (arr, ic, color) => arr.length ? `<ul class="space-y-1 mt-1">${arr.map((x) => `<li class="flex items-start gap-1.5"><span style="color:${color}" class="mt-0.5 shrink-0">${icon(ic, 'w-3.5 h-3.5')}</span><span>${esc(x)}</span></li>`).join('')}</ul>` : '';
  return `<div class="rounded-[26px] border border-black/[0.06] p-5 shadow-[0_2px_14px_rgba(0,0,0,0.03)]">
    <div class="flex items-center justify-between mb-3">
      <span class="flex items-center gap-2 text-[16px] font-bold">${icon('bot', 'w-5 h-5')}${esc(t('aiSummary'))}</span>
      ${o.rating != null ? `<span class="flex items-center gap-1.5 bg-[#F2F2F7] rounded-full pl-3 pr-2 py-1"><b class="text-[15px]">${o.rating.toFixed(1)}</b><span class="flex">${starsHtml(o.rating)}</span></span>` : `<span class="text-[11px] text-[#8E8E93]">${esc(t('noRating'))}</span>`}
    </div>
    <p class="text-[15px] leading-relaxed text-[#3A3A3C]">${esc(o.summary)}</p>
    ${o.positives.length ? `<p class="text-[12px] font-semibold text-[#2E7D32] mt-4">${esc(t('positives'))}</p><div class="text-[13px] text-[#3A3A3C]">${list(o.positives, 'plusCircle', '#34C759')}</div>` : ''}
    ${o.negatives.length ? `<p class="text-[12px] font-semibold text-[#C2410C] mt-3">${esc(t('negatives'))}</p><div class="text-[13px] text-[#3A3A3C]">${list(o.negatives, 'minusCircle', '#F97316')}</div>` : ''}
    ${o.tip ? `<div class="mt-4 bg-amber-50 rounded-2xl px-3.5 py-2.5 text-[12.5px] text-amber-900 flex items-start gap-2">${icon('bulb', 'w-4 h-4 shrink-0 mt-0.5')}<span><b>${esc(t('tip'))}</b> · ${esc(o.tip)}</span></div>` : ''}
    ${o.sources && o.sources.length ? `<details class="mt-3 text-[11px]"><summary class="cursor-pointer text-[#8E8E93]">${esc(t('sources'))} (${o.sources.length})</summary><ul class="mt-1.5 space-y-1">${o.sources.map((s) => `<li><a class="text-[#0071E3] break-all" href="${esc(safeUrl(s.uri))}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.uri)}</a></li>`).join('')}</ul></details>` : ''}
  </div>`;
}

async function fetchOpinion() {
  const d = S.detail;
  if (!d || d.opLoading) return;
  d.opLoading = true; d.opError = null;
  $('#aiBox').innerHTML = opinionHtml();
  $('#aiBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const it = d.it;
  try {
    d.opinion = await fn('opinion', { keyword: it.keyword || it.original || it.title, title: it.original || it.title, lang: S.lang });
  } catch (e) {
    d.opError = e;
    if (e.status === 401) { d.opLoading = false; d.opError = null; $('#aiBox').innerHTML = ''; toast(t('loginForAi'), 'lock'); openAuth('login'); return; }
  }
  d.opLoading = false;
  if (S.detail === d) { $('#aiBox').innerHTML = opinionHtml(); $('#aiBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}

$('#detailBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'ai') fetchOpinion();
  if (b.dataset.act === 'close') closeDetail();
  if (b.dataset.act === 'addtrip') addDetailToTrip();
});

function addDetailToTrip() {
  const it = S.detail && S.detail.it;
  if (!it || !it.location) return;
  if (!S.trip || S.tripReadOnly) { toast(t('toast_needTrip'), 'info'); closeDetail(); closeHotMap(); selectTab('map'); return; }
  const day = S.planDay;
  const list = S.trip.days[day] || (S.trip.days[day] = []);
  list.push({
    name: it.original || it.title, category: it.tag || '', address: it.location.address || '',
    type: it.cat === 'concert' ? 'spot' : 'spot', time: it.cat === 'concert' ? '18:00' : '12:00', duration: it.cat === 'concert' ? 180 : 60,
    memo: '', lat: it.location.lat, lng: it.location.lng, url: it.location.kakaoUrl || '', phone: '',
  });
  scheduleSave();
  toast(t('toast_placeAdded', { name: it.title, day: dayLabel(day), time: it.cat === 'concert' ? '18:00' : '12:00' }), 'plus');
}

/* ---------------- 인증 ---------------- */
function avatarHtml(user, size) {
  if (user && user.photo) return `<img src="${esc(user.photo)}" alt="" class="w-full h-full object-cover">`;
  return icon('user', size);
}
function renderProfileButton() {
  $('#navAvatar').innerHTML = avatarHtml(S.user, 'w-4 h-4');
  $('#navProfileName').textContent = S.user ? S.user.nickname : t('login');
}
$('#btnProfile').onclick = () => { if (S.user) openProfile(); else openAuth('login'); };

function openAuth(mode) {
  if (!sb) { toast(t('setupNeeded'), 'alert'); return; }
  S.authMode = mode;
  hideAuthMsgs();
  renderAuthModal();
  openModal('authModal');
  setTimeout(() => (mode === 'recover' ? $('#authPassword') : $('#authEmail')).focus(), 50);
}
function hideAuthMsgs() { $('#authError').classList.add('hidden'); $('#authInfo').classList.add('hidden'); }
function showAuthMsg(id, ic, text) { const el = $(id); el.innerHTML = icon(ic, 'w-3.5 h-3.5 mt-[1px] shrink-0') + `<span>${esc(text)}</span>`; el.classList.remove('hidden'); }
function renderAuthModal() {
  const m = S.authMode;
  $('#authTitle').textContent = t({ login: 'authLoginTitle', signup: 'authSignupTitle', forgot: 'forgotTitle', recover: 'recoverTitle' }[m]);
  $('#authSubmit').textContent = t({ login: 'login', signup: 'signup', forgot: 'sendResetLink', recover: 'save' }[m]);
  $('#authSwitch').textContent = m === 'login' ? t('noAccount') : m === 'signup' ? t('haveAccount') : t('backToLogin');
  $('#authSwitch').classList.toggle('hidden', m === 'recover');
  $('#authForgot').classList.toggle('hidden', m !== 'login');
  $('#emailWrap').classList.toggle('hidden', m === 'recover');
  $('#pwWrap').classList.toggle('hidden', m === 'forgot');
  $('#pwLabel').textContent = m === 'recover' ? t('newPw') : t('password');
  $('#nickWrap').classList.toggle('hidden', m !== 'signup');
  $('#pwHintText').classList.toggle('hidden', !(m === 'signup' || m === 'recover'));
  $('#authPassword').autocomplete = m === 'login' ? 'current-password' : 'new-password';
}
$('#authSwitch').onclick = () => { S.authMode = S.authMode === 'login' ? 'signup' : 'login'; hideAuthMsgs(); renderAuthModal(); };
$('#authForgot').onclick = () => { S.authMode = 'forgot'; hideAuthMsgs(); renderAuthModal(); };

/** Supabase Auth 오류 → 번역 키 */
function authCode(e) {
  const c = (e && e.code) || '';
  const m = ((e && e.message) || '').toLowerCase();
  if (c === 'network') return 'network';
  if (c === 'invalid_credentials' || m.includes('invalid login')) return 'invalid_credentials';
  if (c === 'user_already_exists' || c === 'email_exists' || m.includes('already registered')) return 'email_taken';
  if (c === 'weak_password' || m.includes('password should')) return 'weak_password';
  if (c === 'email_not_confirmed' || m.includes('not confirmed')) return 'email_not_confirmed';
  if (c === 'same_password') return 'same_password';
  if (c.startsWith('over_') || m.includes('rate limit')) return 'too_many_requests';
  if (c === 'email_address_invalid' || c === 'validation_failed' || m.includes('invalid email') || m.includes('validate email')) return 'invalid_email';
  return 'generic';
}
const authFail = (e) => mkErr(authCode(e));

$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('#authSubmit');
  btn.disabled = true;
  hideAuthMsgs();
  const m = S.authMode;
  const email = $('#authEmail').value.trim();
  const pw = $('#authPassword').value;
  try {
    if (m !== 'recover' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw mkErr('invalid_email');
    if ((m === 'signup' || m === 'recover') && pw.length < 8) throw mkErr('weak_password');
    if (m === 'signup') {
      const nickname = $('#authNickname').value.trim().slice(0, 20);
      if (!nickname) throw mkErr('nickname_required');
      const { data, error } = await sb.auth.signUp({ email, password: pw, options: { data: { nickname, lang: S.lang }, emailRedirectTo: appUrl() } });
      if (error) throw authFail(error);
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw mkErr('email_taken');
      if (!data.session) {
        S.authMode = 'login'; renderAuthModal();
        showAuthMsg('#authInfo', 'mail', t('confirmEmailSent'));
        return;
      }
      S.welcomePending = true;
    } else if (m === 'login') {
      const { error } = await sb.auth.signInWithPassword({ email, password: pw });
      if (error) throw authFail(error);
      S.welcomePending = true;
    } else if (m === 'forgot') {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
      if (error) throw authFail(error);
      showAuthMsg('#authInfo', 'mail', t('resetSent'));
      return;
    } else if (m === 'recover') {
      const { error } = await sb.auth.updateUser({ password: pw });
      if (error) throw authFail(error);
      toast(t('toast_pwChanged'), 'lock');
    }
    $('#authPassword').value = '';
    closeModal('authModal');
  } catch (err) {
    showAuthMsg('#authError', 'alert', errText(err));
  } finally { btn.disabled = false; }
};

/** 세션이 생기면 Korrier 프로필을 불러오거나 처음 한 번 만든다 */
let sessionUid = null;
async function handleSession(session) {
  if (!session) {
    if (S.user) clearUser();
    sessionUid = null;
    return;
  }
  const u = session.user;
  if (sessionUid === u.id) return;
  sessionUid = u.id;
  try {
    let prof = must(await sb.from('korrier_profiles').select('*').eq('id', u.id).maybeSingle());
    if (!prof) {
      const meta = u.user_metadata || {};
      const nickname = String(meta.nickname || (u.email || '').split('@')[0] || 'Traveler').slice(0, 20);
      prof = must(await sb.from('korrier_profiles').upsert({ id: u.id, nickname, lang: LANGS.some((l) => l.code === meta.lang) ? meta.lang : S.lang }).select().single());
    }
    await onLogin({ id: u.id, email: u.email, nickname: prof.nickname, photo: prof.photo || '', lang: prof.lang });
    if (S.welcomePending) { S.welcomePending = false; toast(t('toast_welcome', { name: prof.nickname }), 'user'); }
  } catch (e) {
    sessionUid = null;
    toastErr(e);
  }
}
function clearUser() {
  S.user = null; S.savedTrips = [];
  if (S.trip && S.trip.id && !S.tripReadOnly) S.trip = null;
  renderProfileButton();
  if (S.tab === 'map') renderMapView();
}

async function onLogin(user) {
  S.user = user;
  if (!localStorage.getItem(LS.lang) && user.lang && user.lang !== S.lang) { S.lang = user.lang; refreshAllText(); }
  renderProfileButton();
  // 로그인 전 기기에 저장한 일정을 계정으로 이전
  if (S.trip && !S.trip.id && !S.tripReadOnly) await saveTripNow(false);
  await refreshSavedTrips();
  if (S.tab === 'map') renderMapView();
}

function openProfile() {
  const u = S.user;
  $('#profileAvatar').innerHTML = avatarHtml(u, 'w-10 h-10');
  $('#profileEmail').textContent = u.email;
  $('#profileNickname').value = u.nickname;
  $('#pwCurrent').value = ''; $('#pwNext').value = '';
  pendingPhoto = null;
  resetDeleteBtn();
  openModal('profileModal');
}
let pendingPhoto;
$('#btnPhoto').onclick = () => $('#photoInput').click();
$('#photoInput').onchange = async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    pendingPhoto = await resizeImage(f, 256);
    $('#profileAvatar').innerHTML = `<img src="${pendingPhoto}" class="w-full h-full object-cover" alt="">`;
  } catch { toast(t('err_generic'), 'alert'); }
  e.target.value = '';
};
function resizeImage(file, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas');
      const s = Math.min(img.width, img.height);
      c.width = c.height = size;
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = url;
  });
}
$('#btnSaveProfile').onclick = async () => {
  try {
    const nickname = $('#profileNickname').value.trim().slice(0, 20);
    if (!nickname) throw mkErr('nickname_required');
    const body = { nickname };
    if (pendingPhoto) body.photo = pendingPhoto;
    const prof = must(await sb.from('korrier_profiles').update(body).eq('id', S.user.id).select().single());
    Object.assign(S.user, { nickname: prof.nickname, photo: prof.photo || '' });
    pendingPhoto = null;
    renderProfileButton();
    closeModal('profileModal');
    toast(t('toast_profileSaved'), 'check');
  } catch (e) { toastErr(e); }
};
$('#btnChangePw').onclick = async () => {
  try {
    const next = $('#pwNext').value;
    if (next.length < 8) throw mkErr('weak_password');
    const chk = await sb.auth.signInWithPassword({ email: S.user.email, password: $('#pwCurrent').value });
    if (chk.error) throw mkErr('invalid_credentials');
    const { error } = await sb.auth.updateUser({ password: next });
    if (error) throw authFail(error);
    $('#pwCurrent').value = ''; $('#pwNext').value = '';
    toast(t('toast_pwChanged'), 'lock');
  } catch (e) { toastErr(e); }
};
$('#btnLogout').onclick = async () => {
  await sb.auth.signOut().catch(() => {});
  sessionUid = null;
  clearUser();
  closeModal('profileModal');
  toast(t('toast_loggedOut'), 'logout');
};
let delArmed = false;
function resetDeleteBtn() { delArmed = false; $('#btnDeleteAccount').textContent = t('deleteAccount'); }
$('#btnDeleteAccount').onclick = async () => {
  if (!delArmed) { delArmed = true; $('#btnDeleteAccount').textContent = t('confirmAgain'); setTimeout(resetDeleteBtn, 4000); return; }
  try {
    // 같은 Supabase 계정을 쓰는 다른 앱 계정은 건드리지 않고 Korrier 데이터만 삭제
    must(await sb.from('korrier_trips').delete().eq('user_id', S.user.id));
    must(await sb.from('korrier_profiles').delete().eq('id', S.user.id));
    await sb.auth.signOut().catch(() => {});
    sessionUid = null;
    S.trip = null;
    clearUser();
    closeModal('profileModal');
    toast(t('toast_accountDeleted'), 'check');
  } catch (e) { toastErr(e); }
};

/* =====================================================================
   여행 일정
   ===================================================================== */
const REGIONS = [
  { id: 'seoul', ko: '서울', n: ['서울', 'Seoul', 'ソウル', '首尔', 'Seúl', 'Séoul', 'โซล'], lat: 37.5665, lng: 126.978, ic: 'building' },
  { id: 'busan', ko: '부산', n: ['부산', 'Busan', '釜山', '釜山', 'Busan', 'Busan', 'ปูซาน'], lat: 35.1796, lng: 129.0756, ic: 'waves' },
  { id: 'jeju', ko: '제주', n: ['제주', 'Jeju', '済州', '济州', 'Jeju', 'Jeju', 'เชจู'], lat: 33.4996, lng: 126.5312, ic: 'leaf' },
  { id: 'gangneung', ko: '강릉', n: ['강릉', 'Gangneung', '江陵', '江陵', 'Gangneung', 'Gangneung', 'คังนึง'], lat: 37.7519, lng: 128.8761, ic: 'coffee' },
  { id: 'gyeongju', ko: '경주', n: ['경주', 'Gyeongju', '慶州', '庆州', 'Gyeongju', 'Gyeongju', 'คย็องจู'], lat: 35.8562, lng: 129.2247, ic: 'landmark' },
  { id: 'jeonju', ko: '전주', n: ['전주', 'Jeonju', '全州', '全州', 'Jeonju', 'Jeonju', 'ช็อนจู'], lat: 35.8242, lng: 127.148, ic: 'food' },
  { id: 'yeosu', ko: '여수', n: ['여수', 'Yeosu', '麗水', '丽水', 'Yeosu', 'Yeosu', 'ยอซู'], lat: 34.7604, lng: 127.6622, ic: 'waves' },
  { id: 'sokcho', ko: '속초', n: ['속초', 'Sokcho', '束草', '束草', 'Sokcho', 'Sokcho', 'ซกโช'], lat: 38.207, lng: 128.5918, ic: 'mountain' },
  { id: 'incheon', ko: '인천', n: ['인천', 'Incheon', '仁川', '仁川', 'Incheon', 'Incheon', 'อินชอน'], lat: 37.4563, lng: 126.7052, ic: 'train' },
  { id: 'daegu', ko: '대구', n: ['대구', 'Daegu', '大邱', '大邱', 'Daegu', 'Daegu', 'แทกู'], lat: 35.8714, lng: 128.6014, ic: 'building' },
  { id: 'gapyeong', ko: '가평', n: ['가평', 'Gapyeong', '加平', '加平', 'Gapyeong', 'Gapyeong', 'คาพยอง'], lat: 37.8315, lng: 127.5105, ic: 'mountain' },
  { id: 'tongyeong', ko: '통영', n: ['통영', 'Tongyeong', '統営', '统营', 'Tongyeong', 'Tongyeong', 'ทงยอง'], lat: 34.8544, lng: 128.4331, ic: 'waves' },
];
const regionLabel = (r) => {
  const c = REGIONS.find((x) => x.ko === r.name);
  if (c) return c.n[langIdx()];
  return (S.lang !== 'ko' && dynCache.get(S.lang + '|' + r.name)) || r.name;
};
const totalDays = (trip) => Math.round((parseDate(trip.endDate) - parseDate(trip.startDate)) / 864e5) + 1;
const dayLabel = (k) => t('day', { n: k.replace('day', '') });
const nightsDays = (trip) => { const d = totalDays(trip); return d === 1 ? t('dayTrip') : t('nightsDays', { n: d - 1, d }); };
const fmtDur = (min) => {
  if (!min) return t('allDay');
  const h = Math.floor(min / 60), m = min % 60;
  return [h ? `${h}${S.lang === 'en' ? '' : ' '}${t('unitH')}` : '', m ? `${m}${S.lang === 'en' ? '' : ' '}${t('unitM')}` : ''].filter(Boolean).join(' ');
};
const TYPE_STYLE = {
  spot: { color: '#2563EB', ic: 'landmark' },
  food: { color: '#EF4444', ic: 'food' },
  hotel: { color: '#14B8A6', ic: 'bed' },
  transport: { color: '#8B5CF6', ic: 'train' },
};

/* 저장 */
let saveChain = Promise.resolve();
const scheduleSave = debounce(() => saveTripNow(false), 700);
/** 저장·공유된 일정을 화면에 쓰기 전에 형식을 강제 (공유 링크로 들어온 데이터 방어) */
function normalizeTrip(tr) {
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : isoDate(new Date()));
  const days = {};
  const src = tr.days && typeof tr.days === 'object' ? tr.days : {};
  Object.keys(src).forEach((k) => {
    if (!/^day\d{1,2}$/.test(k) || !Array.isArray(src[k])) return;
    days[k] = src[k].slice(0, 40).map((p) => ({
      name: str(p.name, 80), category: str(p.category, 120), address: str(p.address, 160),
      type: ['spot', 'food', 'hotel', 'transport'].includes(p.type) ? p.type : 'spot',
      time: /^\d{2}:\d{2}$/.test(p.time) ? p.time : '12:00',
      duration: Math.max(0, Math.min(1440, Number(p.duration) || 0)),
      memo: str(p.memo, 200), lat: num(p.lat), lng: num(p.lng), url: safeUrl(p.url), phone: str(p.phone, 30),
    }));
  });
  const r = tr.region || {};
  const start = date(tr.startDate || tr.start_date);
  let end = date(tr.endDate || tr.end_date);
  if (end < start) end = start;
  return {
    id: tr.id || undefined,
    region: { name: str(r.name, 60), lat: num(r.lat) ?? 37.5665, lng: num(r.lng) ?? 126.978 },
    startDate: start, endDate: end, days, shared: !!tr.shared,
    ownerNickname: str(tr.owner_nickname || tr.ownerNickname, 20), updatedAt: tr.updated_at || tr.updatedAt || '',
  };
}
function tripRow() {
  const { region, startDate, endDate, days, shared } = S.trip;
  return { region, start_date: startDate, end_date: endDate, days, shared: !!shared, owner_nickname: (S.user ? S.user.nickname : '').slice(0, 20) };
}
function saveTripNow(explicit) {
  saveChain = saveChain.then(async () => {
    if (!S.trip || S.tripReadOnly) return;
    if (!S.user) {
      localStorage.setItem(LS.trip, JSON.stringify(S.trip));
      if (explicit) { toast(t('toast_needLogin'), 'info'); openAuth('login'); }
      return;
    }
    try {
      const row = S.trip.id
        ? must(await sb.from('korrier_trips').update(tripRow()).eq('id', S.trip.id).select().single())
        : must(await sb.from('korrier_trips').insert(tripRow()).select().single());
      if (S.trip) S.trip.id = row.id;
      localStorage.removeItem(LS.trip);
      if (explicit) toast(t('toast_tripSaved'), 'bookmark');
      refreshSavedTrips();
    } catch (e) { if (explicit) toastErr(e); }
  });
  return saveChain;
}
async function refreshSavedTrips() {
  if (!S.user) { S.savedTrips = []; return; }
  try {
    const rows = must(await sb.from('korrier_trips').select('*').order('updated_at', { ascending: false }).limit(50));
    S.savedTrips = rows.map(normalizeTrip);
  } catch { S.savedTrips = []; }
  if (S.tab === 'map' && !S.trip) renderTripEmpty();
}

/* 지도 탭 렌더 */
function renderMapView() {
  $('#listArea').classList.add('hidden');
  $('#fashionSubTabs').classList.add('hidden');
  $('#metaLine').classList.add('hidden');
  $('#mapView').classList.remove('hidden');
  const banner = $('#sharedBanner');
  if (S.tripReadOnly && S.trip) {
    banner.innerHTML = `<span class="flex items-center gap-1.5">${icon('share', 'w-4 h-4')}${esc(t('sharedBy', { name: S.sharedOwner || '-' }))}</span><button id="btnCopyShared" class="px-3 py-1.5 rounded-full bg-[#0071E3] text-white text-[11px] font-medium shrink-0">${esc(t('copyTrip'))}</button>`;
    banner.classList.remove('hidden');
    $('#btnCopyShared').onclick = copySharedTrip;
  } else banner.classList.add('hidden');

  if (!S.trip) { $('#tripActive').classList.add('hidden'); $('#tripEmpty').classList.remove('hidden'); renderTripEmpty(); return; }
  $('#tripEmpty').classList.add('hidden');
  $('#tripActive').classList.remove('hidden');
  renderTripActive();
}

function renderTripEmpty() {
  $('#quickRegions').innerHTML = REGIONS.slice(0, 6).map((r) => `
    <button data-quick="${r.id}" class="px-3.5 py-1.5 rounded-full bg-[#F2F2F7] hover:bg-[#E5E5EA] text-[12px] font-medium flex items-center gap-1.5 active:scale-95 transition">${icon(r.ic, 'w-3.5 h-3.5 text-[#0071E3]')}${esc(r.n[langIdx()])}</button>`).join('');
  const box = $('#savedTripsBox');
  if (S.user && S.savedTrips.length) {
    box.classList.remove('hidden');
    $('#noTripBox').classList.add('hidden');
    $('#savedTripsList').innerHTML = S.savedTrips.map((tr) => `
      <div class="flex items-center gap-2 bg-[#F8F8FA] rounded-2xl p-3 border border-black/[0.04]">
        <button data-open-trip="${esc(tr.id)}" class="flex-1 min-w-0 text-left flex items-center gap-3">
          <span class="w-9 h-9 rounded-xl bg-blue-50 text-[#0071E3] flex items-center justify-center shrink-0">${icon('map', 'w-4 h-4')}</span>
          <span class="min-w-0"><span class="block text-[13px] font-semibold truncate">${esc(regionLabel(tr.region))} · ${esc(nightsDays(tr))}</span>
          <span class="block text-[11px] text-[#8E8E93]">${esc(tr.startDate)} ~ ${esc(tr.endDate)}</span></span>
        </button>
        <button data-del-trip="${esc(tr.id)}" class="w-8 h-8 rounded-full hover:bg-rose-50 text-[#8E8E93] hover:text-rose-500 flex items-center justify-center">${icon('trash', 'w-4 h-4')}</button>
      </div>`).join('');
  } else {
    box.classList.add('hidden');
    $('#noTripBox').classList.remove('hidden');
  }
}
$('#quickRegions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-quick]');
  if (!b) return;
  const r = REGIONS.find((x) => x.id === b.dataset.quick);
  openWizard({ name: r.ko, lat: r.lat, lng: r.lng }, 2);
});
$('#savedTripsList').addEventListener('click', async (e) => {
  const o = e.target.closest('[data-open-trip]');
  if (o) { const tr = S.savedTrips.find((x) => x.id === o.dataset.openTrip); if (tr) { S.trip = JSON.parse(JSON.stringify(tr)); S.planDay = 'day1'; S.tripReadOnly = false; renderMapView(); } return; }
  const d = e.target.closest('[data-del-trip]');
  if (d) {
    try { must(await sb.from('korrier_trips').delete().eq('id', d.dataset.delTrip)); toast(t('toast_tripDeleted'), 'trash'); await refreshSavedTrips(); renderTripEmpty(); } catch (err) { toastErr(err); }
  }
});
$('#btnNewTrip').onclick = () => openWizard(null, 1);

function renderTripActive() {
  const tr = S.trip;
  $('#tripBadgeRegion').textContent = regionLabel(tr.region);
  $('#tripBadgeDate').textContent = `${tr.startDate.slice(5).replace('-', '.')} ~ ${tr.endDate.slice(5).replace('-', '.')}`;
  $('#tripHeading').innerHTML = `${esc(regionLabel(tr.region))}<br><span class="text-[#0071E3]">${esc(nightsDays(tr))}</span>`;
  const ro = S.tripReadOnly;
  $('#btnAddPlace').classList.toggle('hidden', ro);
  $('#tripActions').classList.toggle('hidden', ro);
  $('#btnShareTrip').classList.toggle('hidden', ro);
  const n = totalDays(tr);
  if (Number(S.planDay.replace('day', '')) > n) S.planDay = 'day1';
  $('#dayPills').innerHTML = Array.from({ length: n }, (_, i) => {
    const k = `day${i + 1}`;
    const on = k === S.planDay;
    const cnt = (tr.days[k] || []).length;
    return `<button data-day="${k}" class="px-4 py-1.5 rounded-full text-[12px] font-medium shrink-0 transition flex items-center gap-1.5 ${on ? 'bg-[#0071E3] text-white' : 'bg-white text-[#6E6E73] border border-black/[0.08]'}">${esc(dayLabel(k))}${cnt ? `<span class="text-[10px] ${on ? 'bg-white/25' : 'bg-[#F2F2F7]'} rounded-full px-1.5">${cnt}</span>` : ''}</button>`;
  }).join('');
  renderLayerChips();
  renderTimeline();
  loadOliveYoung();
  if (!tr.region.name) return;
  translateDom($('#tripActive'));
  if (S.lang !== 'ko' && !REGIONS.some((x) => x.ko === tr.region.name) && !dynCache.has(S.lang + '|' + tr.region.name)) {
    // 지역명 번역 후 헤더 갱신
    fn('translate', { texts: [tr.region.name], lang: S.lang }).then((r) => { dynCache.set(S.lang + '|' + tr.region.name, r.texts[0]); if (S.trip === tr) { $('#tripBadgeRegion').textContent = regionLabel(tr.region); $('#tripHeading').innerHTML = `${esc(regionLabel(tr.region))}<br><span class="text-[#0071E3]">${esc(nightsDays(tr))}</span>`; } }).catch(() => {});
  }
}
$('#dayPills').addEventListener('click', (e) => { const b = e.target.closest('[data-day]'); if (b) { S.planDay = b.dataset.day; renderTripActive(); } });

function renderTimeline() {
  const tr = S.trip;
  const items = (tr.days[S.planDay] || []).slice().sort((a, b) => a.time.localeCompare(b.time));
  tr.days[S.planDay] = items;
  const box = $('#timeline');
  if (!items.length) {
    box.innerHTML = `<div class="py-8 text-center text-[#8E8E93] text-[12px] border border-dashed border-black/[0.08] rounded-2xl bg-[#FAFAFC]">${esc(t('emptyDay', { day: dayLabel(S.planDay) }))}</div>`;
  } else {
    box.innerHTML = items.map((p, i) => {
      const ty = TYPE_STYLE[p.type] || TYPE_STYLE.spot;
      const hasC = p.lat && p.lng;
      return `<div class="relative flex items-start gap-3">
        <div class="relative flex flex-col items-center shrink-0 pt-1">
          <div class="w-6 h-6 rounded-full text-white flex items-center justify-center text-[11px] font-bold z-10" style="background:${ty.color}">${i + 1}</div>
          ${i < items.length - 1 ? '<div class="timeline-line"></div>' : ''}
        </div>
        <div class="flex-1 min-w-0 bg-white rounded-2xl p-3 border border-black/[0.06]">
          <div class="flex items-center justify-between mb-1.5 gap-2">
            <span class="text-[11px] font-semibold text-[#6E6E73] flex items-center gap-1">${icon('clock', 'w-3.5 h-3.5')}${esc(p.time)} · ${esc(t('stay', { d: fmtDur(p.duration) }))}</span>
            <span class="text-[10px] px-2 py-0.5 rounded-full font-medium flex items-center gap-1 shrink-0" style="background:${ty.color}14;color:${ty.color}">${icon(ty.ic, 'w-3 h-3')}${esc(t('type_' + p.type))}</span>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style="background:${ty.color}12;color:${ty.color}">${icon(ty.ic, 'w-5 h-5')}</div>
            <div class="flex-1 min-w-0">
              <h5 class="text-[14px] font-semibold truncate">${esc(p.name)}</h5>
              ${p.category ? `<p class="text-[11px] text-[#8E8E93] truncate">${trSpan(p.category.split(' > ').slice(-2).join(' > '))}</p>` : ''}
              ${p.address ? `<p class="text-[11px] text-[#AEAEB2] truncate">${esc(p.address)}</p>` : ''}
              ${p.memo ? `<p class="text-[11px] text-[#4B5563] mt-1 bg-[#F8F8FA] px-2 py-1 rounded-lg flex items-center gap-1">${icon('note', 'w-3 h-3 shrink-0')}<span class="truncate">${esc(p.memo)}</span></p>` : ''}
            </div>
          </div>
          <div class="flex items-center gap-3 pt-2 mt-2 border-t border-black/[0.04] text-[11px] flex-wrap">
            ${hasC ? `<a href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}" target="_blank" rel="noopener noreferrer" class="text-[#0071E3] font-medium flex items-center gap-1">${icon('pin', 'w-3.5 h-3.5')}${esc(t('googleMap'))}</a>
            <a href="https://map.kakao.com/link/to/${encodeURIComponent(p.name)},${p.lat},${p.lng}" target="_blank" rel="noopener noreferrer" class="text-[#B45309] font-medium flex items-center gap-1">${icon('nav', 'w-3.5 h-3.5')}${esc(t('kakaoRoute'))}</a>` : `<a href="https://map.kakao.com/?q=${encodeURIComponent(p.name)}" target="_blank" rel="noopener noreferrer" class="text-[#B45309] font-medium flex items-center gap-1">${icon('search', 'w-3.5 h-3.5')}${esc(t('kakaoMap'))}</a>`}
            ${S.tripReadOnly ? '' : `<button data-del-place="${i}" class="ml-auto text-[#8E8E93] hover:text-rose-500 flex items-center gap-1">${icon('trash', 'w-3.5 h-3.5')}${esc(t('delete'))}</button>`}
          </div>
        </div>
      </div>`;
    }).join('');
  }
  drawMap(true);
}
$('#timeline').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del-place]');
  if (!b) return;
  S.trip.days[S.planDay].splice(Number(b.dataset.delPlace), 1);
  scheduleSave();
  renderTripActive();
  toast(t('toast_placeDeleted'), 'trash');
});

$('#btnCloseTrip').onclick = () => { S.trip = null; S.tripReadOnly = false; history.replaceState(null, '', location.pathname); renderMapView(); };
$('#btnSaveTrip').onclick = () => saveTripNow(true);
$('#btnChangeTrip').onclick = () => openWizard(S.trip.region, 1, true);
$('#btnAddPlace').onclick = openPlaceModal;
$('#btnCenterMap').onclick = () => drawMap(true);
$('#btnShareTrip').onclick = async () => {
  if (!S.user) { toast(t('toast_needLogin'), 'info'); openAuth('login'); return; }
  S.trip.shared = true;
  await saveTripNow(false);
  if (!S.trip.id) return;
  const url = `${appUrl()}?trip=${S.trip.id}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Korrier', url });
    else { await navigator.clipboard.writeText(url); toast(t('toast_linkCopied'), 'link'); }
  } catch {
    try { await navigator.clipboard.writeText(url); toast(t('toast_linkCopied'), 'link'); } catch { toast(url, 'link'); }
  }
};
async function copySharedTrip() {
  if (!S.user) { toast(t('toast_needLogin'), 'info'); openAuth('login'); return; }
  const copy = { ...JSON.parse(JSON.stringify(S.trip)), id: undefined, shared: false };
  delete copy.id;
  S.trip = copy; S.tripReadOnly = false;
  history.replaceState(null, '', location.pathname);
  await saveTripNow(false);
  toast(t('toast_copied'), 'copy');
  renderMapView();
}

/* ---------------- 지도 (구글 지도 우선, 실패 시 OpenStreetMap) ---------------- */
let gmapsPromise = null;
function loadGoogleMaps() {
  if (window.google && window.google.maps && window.google.maps.Map) return Promise.resolve();
  if (gmapsPromise) return gmapsPromise;
  gmapsPromise = new Promise((resolve, reject) => {
    window.__gmReady = () => resolve();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(S.config.googleMapsKey)}&callback=__gmReady&libraries=marker&language=${langInfo().gmap}&region=KR&loading=async&v=weekly`;
    s.async = true;
    s.onerror = () => reject(new Error('gmaps_load'));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error('gmaps_timeout')), 15000);
  });
  return gmapsPromise;
}
const GM = { failed: false };
const mapViews = [];
class MapView {
  constructor(id) { this.id = id; this.obj = null; this.kind = null; this.layers = []; mapViews.push(this); }
  get el() { return document.getElementById(this.id); }
  async init(center, zoom = 12) {
    if (this.obj) return;
    const el = this.el;
    if (S.config && S.config.googleMapsKey && !GM.failed) {
      try {
        await loadGoogleMaps();
        el.innerHTML = '';
        this.obj = new google.maps.Map(el, { center, zoom, mapId: S.config.googleMapId, disableDefaultUI: true, zoomControl: true, clickableIcons: false, gestureHandling: 'greedy' });
        this.kind = 'google';
        return;
      } catch (e) { console.warn(e); GM.failed = true; }
    }
    if (el._leaflet_id) { el._leaflet_id = null; el.innerHTML = ''; }
    this.obj = L.map(el, { zoomControl: false, attributionControl: true }).setView([center.lat, center.lng], zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(this.obj);
    this.kind = 'leaflet';
  }
  clear() {
    this.layers.forEach((l) => { if (this.kind === 'google') { if (l.setMap) l.setMap(null); else l.map = null; } else this.obj.removeLayer(l); });
    this.layers = [];
  }
  marker({ lat, lng, html, title, z = 0, size = 32, onClick }) {
    if (this.kind === 'google') {
      let mk;
      if (google.maps.marker && google.maps.marker.AdvancedMarkerElement) {
        const d = document.createElement('div'); d.innerHTML = html;
        const c = d.firstElementChild;
        mk = new google.maps.marker.AdvancedMarkerElement({ map: this.obj, position: { lat, lng }, content: c, title, zIndex: z });
        if (onClick) { c.style.cursor = 'pointer'; c.addEventListener('click', (e) => { e.stopPropagation(); onClick(); }); }
      } else {
        mk = new google.maps.Marker({ map: this.obj, position: { lat, lng }, title, zIndex: z });
        if (onClick) mk.addListener('click', onClick);
      }
      this.layers.push(mk);
      return mk;
    }
    const ic = L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
    const mk = L.marker([lat, lng], { icon: ic, title, zIndexOffset: z }).addTo(this.obj);
    if (onClick) mk.on('click', onClick);
    this.layers.push(mk);
    return mk;
  }
  line(pts) {
    if (pts.length < 2) return;
    if (this.kind === 'google') {
      this.layers.push(new google.maps.Polyline({ map: this.obj, path: pts, strokeOpacity: 0, icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.9, strokeColor: '#1E3A8A', scale: 2.5 }, offset: '0', repeat: '12px' }] }));
    } else {
      this.layers.push(L.polyline(pts.map((p) => [p.lat, p.lng]), { color: '#1E3A8A', weight: 2.5, dashArray: '5,5', opacity: 0.85 }).addTo(this.obj));
    }
  }
  fit(pts, fallback, singleZoom = 14) {
    if (this.kind === 'google') {
      if (pts.length > 1) { const b = new google.maps.LatLngBounds(); pts.forEach((p) => b.extend(p)); this.obj.fitBounds(b, 50); }
      else if (pts.length === 1) { this.obj.setCenter(pts[0]); this.obj.setZoom(singleZoom); }
      else { this.obj.setCenter(fallback); this.obj.setZoom(12); }
      return;
    }
    this.obj.invalidateSize();
    if (pts.length > 1) this.obj.fitBounds(pts.map((p) => [p.lat, p.lng]), { padding: [40, 40] });
    else if (pts.length === 1) this.obj.setView([pts[0].lat, pts[0].lng], singleZoom);
    else this.obj.setView([fallback.lat, fallback.lng], 12);
  }
  pan(p, zoom) {
    if (this.kind === 'google') { this.obj.panTo(p); if (zoom) this.obj.setZoom(zoom); return; }
    this.obj.setView([p.lat, p.lng], zoom || this.obj.getZoom(), { animate: true });
  }
  resize() { if (this.kind === 'leaflet' && this.obj) this.obj.invalidateSize(); }
}
const tripView = new MapView('tripMap');
const hotView = new MapView('hotMap');
window.gm_authFailure = () => {
  console.warn('Google Maps 인증 실패 → OpenStreetMap으로 전환');
  GM.failed = true;
  mapViews.forEach((v) => { v.obj = null; v.kind = null; v.layers = []; });
  if (S.trip) drawMap(true);
  if (!$('#hotMapOverlay').classList.contains('hidden')) drawHotMap(true);
};

function pinHtml(n, color) {
  return `<div style="background:${color};width:28px;height:28px;border-radius:50%;color:#fff;display:flex;align-items:center;justify-content:center;font:700 12px Pretendard,sans-serif;border:2px solid #fff;box-shadow:0 4px 10px rgba(0,0,0,.25)">${n}</div>`;
}

/* 지도 레이어: 올리브영 / 핫플레이스 / 팝업스토어 / 콘서트장 (픽토그램) */
const LAYERS = {
  oy: { color: '#6FA300', ic: 'bottle', key: 'layer_oy' },
  hot: { color: '#F97316', ic: 'flame', key: 'layer_hot' },
  popup: { color: '#E11D74', ic: 'gift', key: 'layer_popup' },
  venue: { color: '#4F46E5', ic: 'mic', key: 'layer_venue' },
};
function poiPinHtml(layer, rank, sel) {
  const ly = LAYERS[layer];
  const sz = sel ? 40 : 32;
  return `<div style="position:relative;width:${sz}px;height:${sz}px;border-radius:50%;background:${ly.color};border:${sel ? 3 : 2}px solid #fff;box-shadow:0 ${sel ? 6 : 3}px ${sel ? 16 : 8}px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;color:#fff;transition:all .15s">${icon(ly.ic, sel ? 'w-5 h-5' : 'w-4 h-4', 2)}${rank ? `<span style="position:absolute;top:-8px;right:-10px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:${sel ? ly.color : '#1D1D1F'};color:#fff;font:700 10px/15px Pretendard,sans-serif;text-align:center;border:1.5px solid #fff">${rank}</span>` : ''}</div>`;
}
const hotLayer = (it) => (it.kind === 'popup' ? 'popup' : 'hot');

/** 트렌드 데이터(핫플·콘서트)에서 지도 표시용 장소 만들기 */
function trendPois() {
  const out = [];
  const hot = trendData('hotplace');
  (hot ? hot.items : []).forEach((it) => {
    const l = it.location;
    if (l && l.lat) out.push({ layer: hotLayer(it), rank: it.rank, name: it.title, original: it.original || it.title, lat: l.lat, lng: l.lng, address: l.address || '', category: it.tag || '', url: l.kakaoUrl || '', item: it });
  });
  const con = trendData('concert');
  const venues = new Map();
  (con ? con.items : []).forEach((it) => {
    const l = it.location;
    if (!l || !l.lat) return;
    const k = `${l.lat.toFixed(4)},${l.lng.toFixed(4)}`;
    if (!venues.has(k)) venues.set(k, { layer: 'venue', rank: it.rank, name: l.name || it.tag, original: l.name || it.tag, lat: l.lat, lng: l.lng, address: l.address || '', category: '', url: l.kakaoUrl || '', concerts: [] });
    venues.get(k).concerts.push(it);
  });
  return out.concat([...venues.values()]);
}

async function loadOliveYoung() {
  if (!S.trip || !(S.config && S.config.features.places)) return;
  const c = S.trip.region;
  const k = `${c.lat.toFixed(3)},${c.lng.toFixed(3)}`;
  if (S.oyKey === k) return;
  S.oyKey = k;
  try {
    const r = await fn('places', { q: '올리브영', lat: c.lat, lng: c.lng, sort: 'distance' });
    if (S.oyKey !== k) return;
    S.oyPois = r.places.filter((p) => /올리브영|OLIVE ?YOUNG/i.test(p.name)).map((p) => ({ layer: 'oy', name: p.name, original: p.name, lat: p.lat, lng: p.lng, address: p.address, category: p.category, url: p.url, phone: p.phone, distance: p.distance }));
    renderLayerChips();
    drawMap(false);
  } catch { S.oyKey = ''; }
}

function renderLayerChips() {
  const box = $('#layerChips');
  if (!box) return;
  const counts = { oy: (S.oyPois || []).length, hot: 0, popup: 0, venue: 0 };
  trendPois().forEach((p) => { counts[p.layer]++; });
  box.innerHTML = Object.keys(LAYERS).map((k) => {
    const ly = LAYERS[k]; const on = S.layers[k];
    return `<button data-layer="${k}" class="px-3 py-1.5 rounded-full text-[12px] font-medium shrink-0 flex items-center gap-1.5 border transition ${on ? 'text-white border-transparent' : 'bg-white text-[#6E6E73] border-black/[0.08]'}" style="${on ? `background:${ly.color}` : ''}">${icon(ly.ic, 'w-3.5 h-3.5', 2)}${esc(t(ly.key))}<span class="text-[10px] opacity-80">${counts[k]}</span></button>`;
  }).join('');
}
$('#layerChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-layer]');
  if (!b) return;
  S.layers[b.dataset.layer] = !S.layers[b.dataset.layer];
  renderLayerChips();
  drawMap(false);
});

async function drawMap(fit = true) {
  if (!S.trip || $('#tripActive').classList.contains('hidden')) return;
  const items = S.trip.days[S.planDay] || [];
  const center = { lat: S.trip.region.lat, lng: S.trip.region.lng };
  await tripView.init(center);
  tripView.clear();
  const pois = [];
  if (S.layers.oy) pois.push(...(S.oyPois || []));
  trendPois().forEach((p) => { if (S.layers[p.layer]) pois.push(p); });
  pois.forEach((p) => tripView.marker({ lat: p.lat, lng: p.lng, html: poiPinHtml(p.layer, p.rank), title: p.name, z: 10, onClick: () => showPoi(p) }));
  const pts = items.filter((p) => p.lat && p.lng);
  pts.forEach((p) => tripView.marker({ lat: p.lat, lng: p.lng, html: pinHtml(items.indexOf(p) + 1, (TYPE_STYLE[p.type] || TYPE_STYLE.spot).color), title: p.name, z: 1000, size: 28 }));
  tripView.line(pts.map((p) => ({ lat: p.lat, lng: p.lng })));
  if (fit) tripView.fit(pts.map((p) => ({ lat: p.lat, lng: p.lng })), center);
  else tripView.resize();
}

/** 지도에서 누른 장소 카드 */
function showPoi(p) {
  S.poi = p;
  const ly = LAYERS[p.layer];
  const box = $('#poiCard');
  const concerts = (p.concerts || []).slice(0, 3).map((c) => `<li class="truncate">${esc(c.title)} · ${esc(c.subtitle)}${c.dates && c.dates.start ? ` <span class="text-[#8E8E93]">(${esc(c.dates.start.slice(5))})</span>` : ''}</li>`).join('');
  const dist = p.distance != null ? (p.distance >= 1000 ? `${(p.distance / 1000).toFixed(1)}km` : `${p.distance}m`) : '';
  box.innerHTML = `<div class="rounded-2xl border border-black/[0.06] bg-white p-3.5 shadow-[0_4px_18px_rgba(0,0,0,0.06)] sheet-enter">
    <div class="flex items-start gap-3">
      <span class="w-10 h-10 rounded-xl text-white flex items-center justify-center shrink-0" style="background:${ly.color}">${icon(ly.ic, 'w-5 h-5', 2)}</span>
      <div class="flex-1 min-w-0">
        <p class="text-[11px] font-semibold" style="color:${ly.color}">${esc(t(ly.key))}${p.rank && p.layer !== 'venue' ? ` · ${esc(t('rank', { n: p.rank }))}` : ''}</p>
        <h5 class="text-[15px] font-bold truncate">${esc(p.name)}</h5>
        <p class="text-[11px] text-[#8E8E93] truncate">${esc([p.address, dist].filter(Boolean).join(' · '))}</p>
        ${concerts ? `<p class="text-[11px] font-semibold text-[#6E6E73] mt-1.5">${esc(t('concertsHere'))}</p><ul class="text-[12px] space-y-0.5">${concerts}</ul>` : ''}
      </div>
      <button data-poi="close" class="w-7 h-7 rounded-full bg-[#F2F2F7] text-[#8E8E93] flex items-center justify-center shrink-0">${icon('close', 'w-3.5 h-3.5')}</button>
    </div>
    <div class="flex gap-2 mt-3">
      ${S.tripReadOnly ? '' : `<button data-poi="add" class="flex-1 py-2 rounded-xl bg-[#0071E3] text-white text-[12px] font-medium flex items-center justify-center gap-1">${icon('plus', 'w-3.5 h-3.5')}${esc(t('addToTrip'))}</button>`}
      ${p.item ? `<button data-poi="detail" class="flex-1 py-2 rounded-xl bg-[#F2F2F7] text-[12px] font-medium">${esc(t('poiDetail'))}</button>` : ''}
      <a href="https://map.kakao.com/link/to/${encodeURIComponent(p.original || p.name)},${p.lat},${p.lng}" target="_blank" rel="noopener noreferrer" class="flex-1 py-2 rounded-xl bg-[#FEE500]/80 text-[#3C1E1E] text-[12px] font-medium flex items-center justify-center gap-1">${icon('nav', 'w-3.5 h-3.5')}${esc(t('route'))}</a>
    </div>
  </div>`;
  box.classList.remove('hidden');
}
$('#poiCard').addEventListener('click', (e) => {
  const b = e.target.closest('[data-poi]');
  if (!b || !S.poi) return;
  const a = b.dataset.poi;
  if (a === 'close') { $('#poiCard').classList.add('hidden'); S.poi = null; }
  if (a === 'add') addPoiToTrip(S.poi);
  if (a === 'detail' && S.poi.item) openDetail(S.poi.item);
});

/** 지도 장소를 일정 추가 창으로 (선택된 상태로 열기) */
function addPoiToTrip(p) {
  if (!S.trip || S.tripReadOnly) { toast(t('toast_needTrip'), 'info'); closeHotMap(); selectTab('map'); return; }
  openPlaceModal();
  const sel = { id: 'poi', name: p.original || p.name, category: p.category || t(LAYERS[p.layer].key), address: p.address || '', lat: p.lat, lng: p.lng, url: p.url || '', phone: p.phone || '', type: p.item && ['cafe', 'food'].includes(p.item.kind) ? 'food' : 'spot', distance: null };
  $('#placeInput').value = sel.name;
  S.placeSel = sel;
  setPlaceType(sel.type);
  renderPlaceResults([sel], sel.name);
}

/* ---------------- 핫플 전체 지도 ---------------- */
function openHotMap() {
  const ov = $('#hotMapOverlay');
  ov.classList.remove('hidden'); ov.classList.add('flex');
  S.hotSel = null;
  renderHotFilters();
  setTimeout(() => drawHotMap(true), 30);
}
function closeHotMap() {
  const ov = $('#hotMapOverlay');
  ov.classList.add('hidden'); ov.classList.remove('flex');
}
$('#btnHotMapClose').onclick = closeHotMap;

function hotItems() {
  const data = trendData('hotplace');
  const all = data ? data.items : [];
  const located = all.filter((it) => it.location && it.location.lat);
  const f = S.hotFilter;
  return { all, located: located.filter((it) => f === 'all' || (f === 'popup' ? it.kind === 'popup' : it.kind !== 'popup')) };
}
function renderHotFilters() {
  $('#hotMapFilters').innerHTML = [['all', 'filterAll', 'pin', '#1D1D1F'], ['place', 'layer_hot', 'flame', LAYERS.hot.color], ['popup', 'layer_popup', 'gift', LAYERS.popup.color]].map(([k, key, ic, color]) => {
    const on = S.hotFilter === k;
    return `<button data-hf="${k}" class="px-3.5 py-1.5 rounded-full text-[12px] font-medium flex items-center gap-1.5 border ${on ? 'text-white border-transparent' : 'bg-white text-[#6E6E73] border-black/[0.08]'}" style="${on ? `background:${color}` : ''}">${icon(ic, 'w-3.5 h-3.5', 2)}${esc(t(key))}</button>`;
  }).join('');
}
$('#hotMapFilters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hf]');
  if (!b) return;
  S.hotFilter = b.dataset.hf; S.hotSel = null;
  renderHotFilters();
  drawHotMap(true);
});

async function drawHotMap(fit) {
  const { all, located } = hotItems();
  $('#hotMapSub').textContent = t('hotMapSub', { n: located.length, m: Math.max(0, all.length - all.filter((it) => it.location && it.location.lat).length) });
  const center = located[0] ? { lat: located[0].location.lat, lng: located[0].location.lng } : { lat: 37.5665, lng: 126.978 };
  await hotView.init(center, 12);
  drawHotMarkers();
  $('#hotMapCards').innerHTML = located.length ? located.map((it) => {
    const ly = LAYERS[hotLayer(it)];
    return `<div data-hot="${esc(it.id)}" class="snap-center shrink-0 w-[82%] bg-white rounded-[22px] p-3.5 shadow-[0_8px_24px_rgba(0,0,0,0.14)] border border-black/[0.04]">
      <div class="flex items-center gap-2 mb-1">
        <span class="px-2 py-0.5 rounded-full text-[11px] font-bold text-white" style="background:${ly.color}">${esc(t('rank', { n: it.rank }))}</span>
        <span class="text-[11px] font-medium flex items-center gap-1" style="color:${ly.color}">${icon(ly.ic, 'w-3.5 h-3.5', 2)}${esc(t(ly.key))}</span>
        <span class="text-[11px] text-[#8E8E93] truncate ml-auto">${esc(it.tag)}</span>
      </div>
      <h5 class="text-[16px] font-bold truncate">${esc(it.title)}</h5>
      <p class="text-[12px] text-[#6E6E73] line-clamp-2 mt-0.5 leading-snug">${esc(it.desc)}</p>
      <div class="flex gap-2 mt-2.5">
        <button data-hotact="detail" class="flex-1 py-2 rounded-xl bg-[#F2F2F7] text-[12px] font-medium">${esc(t('poiDetail'))}</button>
        <button data-hotact="add" class="flex-1 py-2 rounded-xl bg-[#0071E3] text-white text-[12px] font-medium">${esc(t('addToTrip'))}</button>
        <a href="https://map.kakao.com/link/to/${encodeURIComponent(it.original || it.title)},${it.location.lat},${it.location.lng}" target="_blank" rel="noopener noreferrer" class="w-10 py-2 rounded-xl bg-[#FEE500]/80 text-[#3C1E1E] flex items-center justify-center">${icon('nav', 'w-4 h-4')}</a>
      </div>
    </div>`;
  }).join('') : `<div class="w-full bg-white rounded-[22px] p-4 text-center text-[13px] text-[#8E8E93]">${esc(trendData('hotplace') ? t('noResults') : t('loadingTitle'))}</div>`;
  if (fit) hotView.fit(located.map((it) => ({ lat: it.location.lat, lng: it.location.lng })), center, 15);
  else hotView.resize();
  if (!trendData('hotplace')) fetchCat('hotplace', S.lang, false).then(() => drawHotMap(true)).catch(() => {});
}
function drawHotMarkers() {
  const { located } = hotItems();
  hotView.clear();
  located.forEach((it) => {
    const sel = it.id === S.hotSel;
    hotView.marker({ lat: it.location.lat, lng: it.location.lng, html: poiPinHtml(hotLayer(it), it.rank, sel), title: it.title, z: sel ? 2000 : 1000 - it.rank, size: sel ? 40 : 32, onClick: () => focusHot(it.id, true) });
  });
}
function focusHot(id, scrollCard) {
  const it = hotItems().located.find((x) => x.id === id);
  if (!it) return;
  S.hotSel = id;
  drawHotMarkers();
  hotView.pan({ lat: it.location.lat, lng: it.location.lng });
  $$('#hotMapCards [data-hot]').forEach((c) => c.classList.toggle('ring-2', c.dataset.hot === id));
  if (scrollCard) {
    const card = $(`#hotMapCards [data-hot="${CSS.escape(id)}"]`);
    if (card) { hotCardLock = Date.now(); card.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }); }
  }
}
let hotCardLock = 0;
$('#hotMapCards').addEventListener('scroll', debounce(() => {
  if (Date.now() - hotCardLock < 700) return;
  const box = $('#hotMapCards');
  const mid = box.getBoundingClientRect().left + box.clientWidth / 2;
  let best = null; let bestD = Infinity;
  $$('#hotMapCards [data-hot]').forEach((c) => { const r = c.getBoundingClientRect(); const d = Math.abs(r.left + r.width / 2 - mid); if (d < bestD) { bestD = d; best = c; } });
  if (best && best.dataset.hot !== S.hotSel) focusHot(best.dataset.hot, false);
}, 120));
$('#hotMapCards').addEventListener('click', (e) => {
  const card = e.target.closest('[data-hot]');
  if (!card) return;
  const it = hotItems().located.find((x) => x.id === card.dataset.hot);
  if (!it) return;
  const act = e.target.closest('[data-hotact]');
  if (!act) { focusHot(it.id, false); return; }
  if (act.dataset.hotact === 'detail') openDetail(it);
  if (act.dataset.hotact === 'add') addPoiToTrip({ layer: hotLayer(it), rank: it.rank, name: it.title, original: it.original || it.title, lat: it.location.lat, lng: it.location.lng, address: it.location.address || '', category: it.tag, url: it.location.kakaoUrl || '', item: it });
});

/* ---------------- 일정 마법사 ---------------- */
function openWizard(region, step, editing) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = editing && S.trip ? parseDate(S.trip.startDate) : today;
  const end = editing && S.trip ? parseDate(S.trip.endDate) : new Date(today.getTime() + 2 * 864e5);
  S.wiz = { step, region: region || null, start, end, picking: false, calY: start.getFullYear(), calM: start.getMonth(), editing: !!editing, results: null };
  $('#regionInput').value = '';
  renderWizard();
  openModal('wizardModal');
}
function renderWizard() {
  const w = S.wiz;
  $('#wizStep').textContent = t('step', { n: w.step });
  $('#wizTitle').textContent = w.step === 1 ? t('whereTo') : t('wizQ2');
  $('#wizStep1').classList.toggle('hidden', w.step !== 1);
  $('#wizStep2').classList.toggle('hidden', w.step !== 2);
  $('#wizPrev').classList.toggle('hidden', w.step === 1);
  $('#wizNext').textContent = w.step === 1 ? t('nextDates') : t('createTrip');
  if (w.step === 1) renderRegionGrid(); else renderCalendar();
}
function renderRegionGrid() {
  const w = S.wiz;
  const list = w.results || REGIONS.map((r) => ({ name: r.ko, lat: r.lat, lng: r.lng, ic: r.ic }));
  $('#regionListLabel').textContent = w.results ? `${t('searchResults')} (${list.length})` : t('popularRegions');
  $('#regionGrid').innerHTML = list.length ? list.map((r, i) => {
    const sel = w.region && w.region.name === r.name;
    const label = regionLabel(r);
    return `<button data-region="${i}" class="rounded-2xl p-3 border text-left transition active:scale-95 flex items-center gap-2.5 ${sel ? 'border-[#0071E3] bg-blue-50/60 ring-1 ring-[#0071E3]' : 'border-black/[0.05] bg-[#F8F8FA] hover:bg-[#F2F2F7]'}">
      <span class="w-9 h-9 rounded-xl bg-white flex items-center justify-center text-[#0071E3] shrink-0 shadow-sm">${icon(r.ic || 'pin', 'w-4 h-4')}</span>
      <span class="min-w-0 flex-1"><span class="block text-[13px] font-bold truncate">${w.results && !REGIONS.some((x) => x.ko === r.name) ? trSpan(r.name) : esc(label)}</span>
      <span class="block text-[10px] text-[#8E8E93] truncate">${esc(r.sub || (S.lang !== 'ko' ? r.name : ''))}</span></span>
      ${sel ? `<span class="text-[#0071E3]">${icon('check', 'w-4 h-4', 2.4)}</span>` : ''}
    </button>`;
  }).join('') : `<p class="col-span-2 text-center text-[12px] text-[#8E8E93] py-6">${esc(t('noResults'))}</p>`;
  translateDom($('#regionGrid'));
}
$('#regionGrid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-region]');
  if (!b) return;
  const list = S.wiz.results || REGIONS.map((r) => ({ name: r.ko, lat: r.lat, lng: r.lng, ic: r.ic }));
  S.wiz.region = list[Number(b.dataset.region)];
  renderRegionGrid();
});
$('#regionInput').addEventListener('input', debounce(async () => {
  const q = $('#regionInput').value.trim();
  if (!q) { S.wiz.results = null; renderRegionGrid(); return; }
  const local = REGIONS.filter((r) => r.n.some((n) => n.toLowerCase().includes(q.toLowerCase()))).map((r) => ({ name: r.ko, lat: r.lat, lng: r.lng, ic: r.ic }));
  if (S.config && S.config.features.places) {
    try {
      const r = await fn('region', { q });
      const seen = new Set(local.map((x) => x.name));
      S.wiz.results = [...local, ...r.regions.filter((x) => !seen.has(x.name))];
    } catch { S.wiz.results = local; }
  } else S.wiz.results = local;
  renderRegionGrid();
}, 300));

function renderCalendar() {
  const w = S.wiz;
  const loc = langInfo().locale;
  $('#calLabel').textContent = new Intl.DateTimeFormat(loc, { year: 'numeric', month: 'long' }).format(new Date(w.calY, w.calM, 1));
  const wd = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(loc, { weekday: 'narrow' }).format(new Date(2023, 0, 1 + i)));
  $('#calWeekdays').innerHTML = wd.map((d, i) => `<span class="${i === 0 ? 'text-rose-500' : i === 6 ? 'text-blue-500' : ''}">${esc(d)}</span>`).join('');
  const first = new Date(w.calY, w.calM, 1).getDay();
  const last = new Date(w.calY, w.calM + 1, 0).getDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let h = '';
  for (let i = 0; i < first; i++) h += '<span></span>';
  for (let d = 1; d <= last; d++) {
    const dt = new Date(w.calY, w.calM, d);
    const tm = dt.getTime();
    const isS = tm === w.start.getTime(), isE = tm === w.end.getTime();
    const inR = tm > w.start.getTime() && tm < w.end.getTime();
    let cls = 'py-2 rounded-xl transition cursor-pointer ';
    if (isS || isE) cls += 'bg-[#0071E3] text-white font-bold';
    else if (inR) cls += 'bg-blue-100 text-[#0071E3] font-medium';
    else cls += (dt < today ? 'text-[#C7C7CC] ' : '') + 'hover:bg-black/5';
    h += `<span data-date="${isoDate(dt)}" class="${cls}">${d}</span>`;
  }
  $('#calDays').innerHTML = h;
  const nd = Math.round((w.end - w.start) / 864e5) + 1;
  $('#calSummary').textContent = `${isoDate(w.start).replace(/-/g, '.')} ~ ${isoDate(w.end).replace(/-/g, '.')} · ${nd === 1 ? t('dayTrip') : t('nightsDays', { n: nd - 1, d: nd })}`;
}
$('#calDays').addEventListener('click', (e) => {
  const b = e.target.closest('[data-date]');
  if (!b) return;
  const w = S.wiz;
  const d = parseDate(b.dataset.date);
  if (!w.picking || d < w.start) { w.start = d; w.end = d; w.picking = true; }
  else { w.end = d; w.picking = false; }
  if ((w.end - w.start) / 864e5 > 29) w.end = new Date(w.start.getTime() + 29 * 864e5);
  renderCalendar();
});
$('#calPrev').onclick = () => { const w = S.wiz; w.calM--; if (w.calM < 0) { w.calM = 11; w.calY--; } renderCalendar(); };
$('#calNext').onclick = () => { const w = S.wiz; w.calM++; if (w.calM > 11) { w.calM = 0; w.calY++; } renderCalendar(); };
$('#wizPrev').onclick = () => { S.wiz.step = 1; renderWizard(); };
$('#wizNext').onclick = () => {
  const w = S.wiz;
  if (w.step === 1) { if (!w.region) { toast(t('selectRegionFirst'), 'info'); return; } w.step = 2; renderWizard(); return; }
  const n = Math.round((w.end - w.start) / 864e5) + 1;
  const days = {};
  for (let i = 1; i <= n; i++) days[`day${i}`] = (w.editing && S.trip && S.trip.days[`day${i}`]) || [];
  const region = { name: w.region.name, lat: w.region.lat, lng: w.region.lng };
  if (w.editing && S.trip) Object.assign(S.trip, { region, startDate: isoDate(w.start), endDate: isoDate(w.end), days });
  else S.trip = { region, startDate: isoDate(w.start), endDate: isoDate(w.end), days, shared: false };
  S.tripReadOnly = false;
  S.planDay = 'day1';
  closeModal('wizardModal');
  S.oyPois = null; S.oyKey = '';
  if (S.tab !== 'map') selectTab('map'); else renderMapView();
  scheduleSave();
  toast(t('toast_tripCreated'), 'map');
};

/* ---------------- 장소 검색 (카카오) ---------------- */
const DURATIONS = [30, 60, 90, 120, 180, 240, 360, 0];
function openPlaceModal() {
  if (!S.trip) { toast(t('toast_needTrip'), 'info'); return; }
  const n = totalDays(S.trip);
  $('#placeDay').innerHTML = Array.from({ length: n }, (_, i) => `<option value="day${i + 1}" ${`day${i + 1}` === S.planDay ? 'selected' : ''}>${esc(t('day', { n: i + 1 }))}</option>`).join('');
  $('#placeDuration').innerHTML = DURATIONS.map((d) => `<option value="${d}" ${d === 60 ? 'selected' : ''}>${esc(fmtDur(d))}</option>`).join('');
  $('#placeInput').value = '';
  $('#placeMemo').value = '';
  S.placeSel = null;
  setPlaceType('spot');
  renderPlaceResults(null);
  openModal('placeModal');
  setTimeout(() => $('#placeInput').focus(), 60);
}
function setPlaceType(type) {
  S.placeType = type;
  $('#placeTypeBtns').innerHTML = ['spot', 'food', 'hotel', 'transport'].map((k) => {
    const on = k === type;
    return `<button data-ptype="${k}" class="py-2 rounded-lg flex flex-col items-center gap-0.5 ${on ? 'bg-[#0071E3] text-white font-medium' : 'bg-white border border-black/[0.08]'}">${icon(TYPE_STYLE[k].ic, 'w-4 h-4')}<span class="truncate max-w-full px-0.5">${esc(t('type_' + k))}</span></button>`;
  }).join('');
}
$('#placeTypeBtns').addEventListener('click', (e) => { const b = e.target.closest('[data-ptype]'); if (b) setPlaceType(b.dataset.ptype); });

let placeResults = [];
function renderPlaceResults(list, q) {
  const box = $('#placeResults');
  if (!(S.config && S.config.features.places)) {
    box.innerHTML = `<p class="text-[12px] text-amber-700 p-2 flex items-center gap-1.5">${icon('info', 'w-4 h-4')}${esc(t('placesUnavailable'))}</p>` + (q ? customRow(q) : '');
    return;
  }
  if (list === null) { box.innerHTML = `<p class="text-[12px] text-[#8E8E93] p-2 flex items-center gap-1.5">${icon('search', 'w-4 h-4')}${esc(t('selectPlace'))}</p>`; return; }
  placeResults = list;
  box.innerHTML = (list.length ? list.map((p, i) => {
    const on = S.placeSel && S.placeSel.id === p.id;
    const ty = TYPE_STYLE[p.type] || TYPE_STYLE.spot;
    const dist = p.distance != null ? (p.distance >= 1000 ? `${(p.distance / 1000).toFixed(1)}km` : `${p.distance}m`) : '';
    return `<button data-place="${i}" class="w-full p-2 rounded-xl flex items-center gap-2.5 text-left transition ${on ? 'bg-blue-50 border border-[#0071E3]' : 'bg-white hover:bg-[#F2F2F7] border border-black/[0.03]'}">
      <span class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style="background:${ty.color}14;color:${ty.color}">${icon(ty.ic, 'w-4 h-4')}</span>
      <span class="min-w-0 flex-1"><span class="block text-[12.5px] font-semibold truncate">${esc(p.name)}</span>
      <span class="block text-[10.5px] text-[#8E8E93] truncate">${p.category ? trSpan(p.category.split(' > ').slice(-1)[0]) : ''}${dist ? ' · ' + dist : ''}</span>
      <span class="block text-[10px] text-[#AEAEB2] truncate">${esc(p.address)}</span></span>
      <span class="text-[11px] shrink-0 ${on ? 'text-[#0071E3] font-bold' : 'text-[#8E8E93]'} flex items-center gap-0.5">${on ? icon('check', 'w-3.5 h-3.5', 2.4) + esc(t('selected')) : esc(t('select'))}</span>
    </button>`;
  }).join('') : `<p class="text-[12px] text-[#8E8E93] p-2">${esc(t('noResults'))}</p>`) + (q ? customRow(q) : '');
  translateDom(box);
}
function customRow(q) {
  return `<button data-custom="1" class="w-full mt-1 p-2 rounded-xl bg-[#F2F2F7] hover:bg-[#E5E5EA] text-left text-[11.5px] text-[#3A3A3C] flex items-center gap-1.5">${icon('plus', 'w-3.5 h-3.5')}<span class="truncate">${esc(t('useCustom', { q }))}</span></button>`;
}
$('#placeResults').addEventListener('click', (e) => {
  const b = e.target.closest('[data-place]');
  if (b) {
    S.placeSel = placeResults[Number(b.dataset.place)];
    setPlaceType(S.placeSel.type);
    renderPlaceResults(placeResults, $('#placeInput').value.trim());
    return;
  }
  if (e.target.closest('[data-custom]')) {
    const q = $('#placeInput').value.trim();
    S.placeSel = { id: 'custom', name: q, category: '', address: '', lat: null, lng: null, url: '', phone: '' };
    toast(q, 'note');
  }
});
let placeReq = 0;
$('#placeInput').addEventListener('input', debounce(async () => {
  const q = $('#placeInput').value.trim();
  S.placeSel = null;
  if (!q) { renderPlaceResults(null); return; }
  if (!(S.config && S.config.features.places)) { renderPlaceResults([], q); return; }
  const id = ++placeReq;
  $('#placeSpinner').classList.remove('hidden');
  try {
    const r = await fn('places', { q, lat: S.trip.region.lat, lng: S.trip.region.lng });
    if (id === placeReq) renderPlaceResults(r.places, q);
  } catch (e) {
    if (id === placeReq) { $('#placeResults').innerHTML = `<p class="text-[12px] text-rose-600 p-2">${esc(errText(e))}</p>` + customRow(q); }
  } finally { if (id === placeReq) $('#placeSpinner').classList.add('hidden'); }
}, 300));

$('#btnCommitPlace').onclick = () => {
  const p = S.placeSel;
  if (!p || !p.name) { toast(t('selectPlace'), 'info'); return; }
  const day = $('#placeDay').value;
  const time = $('#placeTime').value || '12:00';
  const item = {
    name: p.name, category: p.category || '', address: p.address || '', type: S.placeType, time,
    duration: Number($('#placeDuration').value), memo: $('#placeMemo').value.trim(),
    lat: p.lat, lng: p.lng, url: p.url || '', phone: p.phone || '',
  };
  (S.trip.days[day] = S.trip.days[day] || []).push(item);
  S.planDay = day;
  closeModal('placeModal');
  scheduleSave();
  renderTripActive();
  toast(t('toast_placeAdded', { name: p.name, day: dayLabel(day), time }), 'plus');
};

/* =====================================================================
   부팅
   ===================================================================== */
function dismissSplash() {
  const sp = $('#splashScreen');
  sp.classList.add('opacity-0', 'pointer-events-none');
  setTimeout(() => { sp.style.display = 'none'; }, 300);
}
$('#splashScreen').onclick = dismissSplash;

/* ---------------- 홈 화면 설치 (PWA) ---------------- */
let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function showInstall(kind) {
  if (isStandalone() || localStorage.getItem('korrier_install_closed')) return;
  $('#installDesc').textContent = t(kind === 'ios' ? 'installDescIos' : 'installDesc');
  $('#btnInstall').classList.toggle('hidden', kind === 'ios');
  $('#installBanner').dataset.kind = kind;
  $('#installBanner').classList.remove('hidden');
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; showInstall('android'); });
window.addEventListener('appinstalled', () => $('#installBanner').classList.add('hidden'));
$('#btnInstall').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  $('#installBanner').classList.add('hidden');
};
$('#btnInstallClose').onclick = () => { localStorage.setItem('korrier_install_closed', '1'); $('#installBanner').classList.add('hidden'); };

async function boot() {
  renderIcons();
  refreshAllText();
  setInterval(updateClock, 1000);
  setInterval(() => { const d = S.trends[`${catKey()}|${S.lang}`]; if (d && S.tab !== 'map') renderMeta(d); }, 30e3);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !isStandalone()) showInstall('ios');

  S.config = {
    googleMapsKey: CFGK.GOOGLE_MAPS_API_KEY || '',
    googleMapId: CFGK.GOOGLE_MAP_ID || 'DEMO_MAP_ID',
    features: { trends: true, ranking: true, places: true, translate: true },
  };
  if (sb) {
    fn('config').then((c) => { S.config.features = c.features; }).catch(() => {});
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setTimeout(() => openAuth('recover'), 0);
      setTimeout(() => handleSession(session), 0);
    });
    const { data } = await sb.auth.getSession();
    if (data && data.session) await handleSession(data.session);
  }
  renderProfileButton();
  setAuto(S.autoMin, false);

  // 로그인 전 기기에 저장된 일정 복원
  if (!S.trip) { try { const loc = JSON.parse(localStorage.getItem(LS.trip) || 'null'); if (loc && loc.region) S.trip = normalizeTrip(loc); } catch {} }

  const shared = new URLSearchParams(location.search).get('trip');
  if (shared && sb && /^[0-9a-f-]{36}$/i.test(shared)) {
    try {
      const rows = must(await sb.rpc('korrier_get_shared_trip', { trip_id: shared }));
      if (!rows || !rows[0]) throw mkErr('not_found');
      const own = S.user && S.savedTrips.find((x) => x.id === rows[0].id);
      S.trip = own ? JSON.parse(JSON.stringify(own)) : normalizeTrip(rows[0]);
      S.tripReadOnly = !own;
      S.sharedOwner = S.trip.ownerNickname;
      S.planDay = 'day1';
      selectTab('map');
    } catch { selectTab('hotplace'); }
  } else selectTab('hotplace');

  // 첫 화면 데이터가 오면(최대 7초) 스플래시를 닫고, 나머지 탭도 미리 검색
  prefetchAll();
  const first = S.loading[`${catKey()}|${S.lang}`];
  await Promise.race([first ? first.catch(() => {}) : Promise.resolve(), new Promise((r) => setTimeout(r, 7000))]);
  dismissSplash();
}
boot();
