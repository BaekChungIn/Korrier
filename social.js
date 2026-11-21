/* Korrier — MY스타 · Q&A · 커뮤니티 · 친구 · 설정 (app.js 다음에 로드) */

/* ---------------- 공통 ---------------- */
const MAX_STARS = 10;
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** 처음 좋아한 날을 1일째로 센다 */
function fanDays(since) {
  if (!since) return 1;
  const [y, m, d] = since.split('-').map(Number);
  const a = Date.UTC(y, m - 1, d);
  const n = new Date();
  const b = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.max(1, Math.floor((b - a) / 86400e3) + 1);
}
function fmtDay(iso, opts = { year: 'numeric', month: 'short', day: 'numeric' }) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y) return '';
  return new Intl.DateTimeFormat(langInfo().locale, { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}
function timeAgo(iso) {
  const sec = (Date.now() - Date.parse(iso)) / 1000;
  if (sec < 60) return t('justNow');
  const rtf = new Intl.RelativeTimeFormat(langInfo().locale, { numeric: 'auto' });
  if (sec < 3600) return rtf.format(-Math.round(sec / 60), 'minute');
  if (sec < 86400) return rtf.format(-Math.round(sec / 3600), 'hour');
  if (sec < 86400 * 7) return rtf.format(-Math.round(sec / 86400), 'day');
  return fmtDay(iso, { month: 'short', day: 'numeric' });
}
const fmtNum = (n) => new Intl.NumberFormat(langInfo().locale).format(n || 0);
function starImg(st, cls = 'w-full h-full') {
  return st && st.photo
    ? `<img src="${esc(st.photo)}" alt="" class="${cls} object-cover" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'w-full h-full flex items-center justify-center text-[#E11D74]',innerHTML:icon('heart','w-1/2 h-1/2')}))">`
    : `<span class="w-full h-full flex items-center justify-center text-[#E11D74]">${icon('heart', 'w-1/2 h-1/2')}</span>`;
}
function needLogin() {
  if (S.user) return false;
  toast(t('toast_needLogin'), 'info');
  openAuth('landing');
  return true;
}
const mainStar = () => S.stars.find((x) => x.is_main) || S.stars[0] || null;
const curStar = () => S.stars[Math.min(S.starIdx, S.stars.length - 1)] || null;

/* ---------------- 로그인 상태 연동 ---------------- */
async function loadStars() {
  if (!S.user) { S.stars = []; return; }
  try {
    S.stars = must(await sb.from('korrier_stars').select('*').order('is_main', { ascending: false }).order('created_at'));
  } catch (e) { S.stars = []; }
}
async function onLoginSocial() {
  await loadStars();
  S.starIdx = 0;
  renderUserChrome();
}
function onLogoutSocial() {
  S.stars = []; S.feeds = {}; S.myAnswers = {}; S.starIdx = 0;
  renderUserChrome();
  if (S.tab === 'star') renderStarView();
  if (S.tab === 'community') renderCommunity(true);
}

/** 헤더 오른쪽 위: 대표 스타 + D+N */
function renderUserChrome() {
  const st = mainStar();
  const pill = $('#starPill');
  if (st) {
    $('#starPillImg').innerHTML = starImg(st);
    $('#starPillText').textContent = `D+${fmtNum(fanDays(st.fan_since))}`;
    pill.setAttribute('aria-label', t('daysLoved', { name: st.name, n: fanDays(st.fan_since) }));
    pill.classList.remove('hidden'); pill.classList.add('flex');
  } else { pill.classList.add('hidden'); pill.classList.remove('flex'); }
  if (!$('#settingsScreen').classList.contains('hidden')) renderSettings();
}
$('#starPill').onclick = () => { S.starIdx = Math.max(0, S.stars.indexOf(mainStar())); selectTab('star'); };
$('#btnHome').onclick = () => selectTab(S.user && S.stars.length ? 'star' : 'hotplace');

/* ================= MY스타 탭 ================= */
const SEGS = [
  { key: 'schedule', icon: 'calendar' },
  { key: 'news', icon: 'newspaper' },
  { key: 'photos', icon: 'image' },
  { key: 'qna', icon: 'chat' },
];
const SCH_STYLE = {
  concert: { ic: 'mic', c: '#4F46E5' }, fanmeeting: { ic: 'heart', c: '#E11D74' }, comeback: { ic: 'disc', c: '#0EA5E9' },
  broadcast: { ic: 'tv', c: '#F59E0B' }, event: { ic: 'star', c: '#10B981' }, ticket: { ic: 'ticket', c: '#EF4444' },
  match: { ic: 'ball', c: '#16A34A' }, youtube: { ic: 'play', c: '#DC2626' }, festival: { ic: 'sparkles', c: '#D946EF' },
  fashion: { ic: 'bag', c: '#111827' }, stage: { ic: 'music', c: '#7C3AED' }, release: { ic: 'film', c: '#0891B2' },
  discharge: { ic: 'shield', c: '#2F6B4F' },
};

function renderStarView() {
  const v = $('#starView');
  if (S.tab !== 'star') return;
  if (!S.user) {
    v.innerHTML = `<div class="bg-white rounded-[28px] p-8 text-center border border-black/[0.03]">
      <div class="w-20 h-20 mx-auto rounded-full bg-[#FFF0F6] text-[#E11D74] flex items-center justify-center">${icon('heart', 'w-10 h-10')}</div>
      <h3 class="text-[20px] font-bold mt-5">${esc(t('starEmptyTitle'))}</h3>
      <p class="text-[13px] text-[#8E8E93] mt-2 leading-relaxed">${esc(t('starEmptySub'))}</p>
      <button data-s="login" class="mt-6 w-full py-4 rounded-[18px] bg-[#1B1F27] text-white font-bold text-[15px] active:scale-[0.98] transition">${esc(t('login'))}</button></div>`;
    return;
  }
  if (!S.stars.length) {
    v.innerHTML = `<div class="bg-white rounded-[28px] p-8 text-center border border-black/[0.03]">
      <div class="relative w-24 h-24 mx-auto"><span class="absolute inset-0 rounded-full bg-[#FFE4EF] animate-ping opacity-40"></span>
      <span class="relative w-24 h-24 rounded-full bg-gradient-to-br from-[#FF8FB8] to-[#E11D74] text-white flex items-center justify-center">${icon('heart', 'w-11 h-11')}</span></div>
      <h3 class="text-[21px] font-bold mt-6">${esc(t('starEmptyTitle'))}</h3>
      <p class="text-[13px] text-[#8E8E93] mt-2 leading-relaxed">${esc(t('starEmptySub'))}</p>
      <button data-s="add" class="mt-6 w-full py-4 rounded-[18px] bg-[#E11D74] text-white font-bold text-[15px] flex items-center justify-center gap-2 active:scale-[0.98] transition">${icon('plus', 'w-5 h-5', 2.2)}${esc(t('starRegister'))}</button></div>`;
    return;
  }
  const st = curStar();
  const days = fanDays(st.fan_since);
  const chips = S.stars.map((x, i) => `<button data-s="pick" data-i="${i}" class="shrink-0 flex flex-col items-center gap-1 w-[60px]">
      <span class="w-[52px] h-[52px] rounded-full overflow-hidden bg-white p-[2px] ${x === st ? 'ring-2 ring-[#E11D74]' : 'ring-1 ring-black/[0.06] opacity-70'}"><span class="block w-full h-full rounded-full overflow-hidden bg-[#FFF0F6]">${starImg(x)}</span></span>
      <span class="text-[11px] truncate max-w-full ${x === st ? 'font-bold text-[#1D1D1F]' : 'text-[#8E8E93]'}">${esc(x.name)}</span></button>`).join('')
    + (S.stars.length < MAX_STARS ? `<button data-s="add" class="shrink-0 flex flex-col items-center gap-1 w-[60px]"><span class="w-[52px] h-[52px] rounded-full border-2 border-dashed border-[#D1D1D6] text-[#8E8E93] flex items-center justify-center">${icon('plus', 'w-5 h-5')}</span><span class="text-[11px] text-[#8E8E93]">${esc(t('addFriend'))}</span></button>` : '');
  v.innerHTML = `
    <div class="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1.5 py-1.5">${chips}</div>
    <div class="relative overflow-hidden rounded-[30px] p-5 pb-6 text-white bg-gradient-to-br from-[#FF7EB3] via-[#E11D74] to-[#7C3AED] shadow-[0_14px_34px_rgba(225,29,116,0.28)]">
      <span class="absolute -right-10 -top-10 w-40 h-40 rounded-full bg-white/10"></span>
      <span class="absolute -left-8 -bottom-12 w-36 h-36 rounded-full bg-white/10"></span>
      <div class="relative flex justify-end">
        <span class="px-3 py-1.5 rounded-full bg-white/20 backdrop-blur text-[12px] font-bold flex items-center gap-1">${icon('heart', 'w-3.5 h-3.5')}${esc(t('daysLoved', { name: st.name, n: fmtNum(days) }))}</span>
      </div>
      <div class="relative flex flex-col items-center text-center mt-3">
        <span class="w-28 h-28 rounded-full overflow-hidden bg-white/30 ring-4 ring-white/70 shadow-xl">${starImg(st)}</span>
        <h2 class="text-[28px] font-black tracking-tight mt-3 leading-tight">${esc(st.name)}</h2>
        ${st.sub ? `<p class="text-[12px] text-white/80">${trSpan(st.sub)}</p>` : ''}
        <p class="text-[44px] font-black leading-none mt-3 tabular-nums">D+${fmtNum(days)}</p>
        <p class="text-[12px] text-white/85 mt-2 flex items-center gap-1.5">${icon('calendar', 'w-3.5 h-3.5')}${esc(t('fanSince', { date: fmtDay(st.fan_since) }))}<span id="starFans"></span></p>
      </div>
    </div>
    <div class="grid grid-cols-4 gap-1 p-1 bg-[#E9E9EE] rounded-2xl">
      ${SEGS.map((sg) => `<button data-s="seg" data-k="${sg.key}" class="py-2 rounded-xl text-[13px] flex items-center justify-center gap-1 transition ${S.starSeg === sg.key ? 'bg-white text-[#E11D74] font-bold shadow-sm' : 'text-[#6E6E73]'}">${icon(sg.icon, 'w-4 h-4')}${esc(t('seg_' + sg.key))}</button>`).join('')}
    </div>
    <div id="starSegBody" class="space-y-3"></div>`;
  loadStarStats(st.name);
  translateDom(v);
  renderStarSeg();
}
async function loadStarStats(name) {
  try {
    const r = must(await sb.rpc('korrier_star_stats', { p_star: name }));
    const row = r && r[0];
    if (row && curStar() && curStar().name === name && $('#starFans')) $('#starFans').textContent = ` · ${t('fansCount', { n: fmtNum(row.fans) })}`;
  } catch {}
}

function renderStarSeg() {
  const body = $('#starSegBody');
  if (!body) return;
  const st = curStar();
  if (S.starSeg === 'qna') { renderQna(st); return; }
  const key = `${st.name}|${S.lang}`;
  const feed = S.feeds[key];
  if (!feed || feed.loading) {
    if (feed && feed.error) {
      body.innerHTML = `<div class="bg-white rounded-[24px] p-6 text-center"><p class="text-[13px] text-[#8E8E93]">${esc(errText(feed.error))}</p><button data-s="retry" class="mt-3 px-5 py-2 rounded-full bg-[#F2F2F7] text-[13px] font-semibold">${esc(t('retry'))}</button></div>`;
    } else {
      body.innerHTML = `<div class="bg-white rounded-[24px] p-8 flex flex-col items-center text-center gap-3"><span class="w-8 h-8 rounded-full border-[3px] border-[#FFD1E3] border-t-[#E11D74] animate-spin"></span><p class="text-[13px] text-[#8E8E93]">${esc(t('feedLoading'))}</p></div>`;
      if (!feed) loadFeed(st.name);
    }
    return;
  }
  if (S.starSeg === 'schedule') body.innerHTML = scheduleHtml(feed, st);
  else if (S.starSeg === 'news') body.innerHTML = newsHtml(feed);
  else body.innerHTML = photosHtml(feed);
}
async function loadFeed(name, force) {
  const lang = S.lang;
  const key = `${name}|${lang}`;
  const prev = S.feeds[key];
  if (!prev || prev.error) S.feeds[key] = { loading: true };
  try {
    const st = S.stars.find((x) => x.name === name);
    const d = await fn('star_feed', { name, lang, force: !!force, sub: (st && st.sub) || '' });
    S.feeds[key] = d;
    // 등록할 때 직업(축구선수 등)이 비어 있었으면 서버가 찾은 걸로 채워서 저장
    if (st && !st.sub && d.sub && typeof d.sub === 'string') {
      st.sub = d.sub.slice(0, 60);
      sb.from('korrier_stars').update({ sub: st.sub }).eq('id', st.id).then(() => {}, () => {});
    }
    if (d.refreshing) setTimeout(() => { if (S.feeds[key] === d) loadFeed(name); }, 45e3);
  } catch (e) {
    S.feeds[key] = prev && !prev.loading && !prev.error ? prev : { error: e };
    if ((e.status === 429 || e.status === 504 || e.code === 'ai_busy') && !(prev && prev.retried > 4)) {
      S.feeds[key] = { loading: true, retried: ((prev && prev.retried) || 0) + 1 };
      setTimeout(() => loadFeed(name), 20000);
    }
  }
  if (S.tab === 'star' && curStar() && curStar().name === name && S.lang === lang) renderStarSeg();
}

function scheduleHtml(feed, st) {
  const today = todayStr();
  const list = (feed.schedule || []).filter((x) => (x.endDate || x.date) >= today);
  // 날짜별로 묶어서 한눈에 (리마인·블립 스타일)
  const days = new Map();
  list.forEach((x) => { const d = x.date < today ? today : x.date; if (!days.has(d)) days.set(d, []); days.get(d).push(x); });
  const wk = (d) => fmtDay(d, { weekday: 'short' });
  const items = [...days.entries()].map(([d, arr]) => {
    const diff = Math.round((Date.parse(d) - Date.parse(today)) / 86400e3);
    const isToday = diff <= 0;
    const rows = arr.sort((a, b) => (a.time || '99').localeCompare(b.time || '99')).map((x) => {
      const sty = SCH_STYLE[x.type] || SCH_STYLE.event;
      const tag = x.link ? 'a' : 'div';
      const href = x.link ? ` href="${esc(safeUrl(x.link))}" target="_blank" rel="noopener noreferrer"` : '';
      const isMatch = x.type === 'match';
      const logos = isMatch && Array.isArray(x.logos) && x.logos.filter(Boolean).length === 2
        ? `<span class="flex items-center -space-x-1.5 shrink-0 self-center">${x.logos.map((l) => `<span class="w-8 h-8 rounded-full bg-white border border-black/[0.06] flex items-center justify-center overflow-hidden"><img src="${esc(safeUrl(l))}" alt="" class="w-6 h-6 object-contain" referrerpolicy="no-referrer" onerror="this.parentNode.remove()"></span>`).join('')}</span>` : '';
      return `<${tag}${href} class="flex items-start gap-3 px-4 py-3 active:bg-black/[0.03]">
        <span class="w-12 shrink-0 text-[14px] font-bold tabular-nums pt-[1px] leading-tight" style="color:${sty.c}">${esc(x.time || t(isMatch ? 'timeTBD' : 'allDay'))}</span>
        <span class="min-w-0 flex-1">
          <span class="block text-[15px] font-bold leading-snug">${esc(x.title)}</span>
          <span class="block text-[12px] text-[#8E8E93] mt-0.5 truncate"><span class="inline-flex items-center gap-0.5 align-middle" style="color:${sty.c}">${icon(sty.ic, 'w-3 h-3')}${esc(t('sch_' + x.type))}</span>${x.comp ? ` · ${esc(x.comp)}` : ''}${x.place ? ` · ${esc(x.place)}` : ''}${x.endDate ? ` · ~${esc(fmtDay(x.endDate, { month: 'short', day: 'numeric' }))}` : ''}</span>
        </span>${logos}
      </${tag}>`;
    }).join('<div class="h-px bg-black/[0.05] mx-4"></div>');
    return `<div class="bg-white rounded-[22px] border border-black/[0.03] overflow-hidden">
      <div class="flex items-center gap-2 px-4 pt-3.5 pb-1.5">
        <span class="text-[15px] font-black">${esc(fmtDay(d, { month: 'long', day: 'numeric' }))}</span>
        <span class="text-[13px] text-[#8E8E93] font-semibold">${esc(wk(d))}</span>
        <span class="ml-auto px-2.5 py-0.5 rounded-full text-[11px] font-bold ${isToday ? 'bg-[#E11D74] text-white' : 'bg-[#F2F2F7] text-[#6E6E73]'}">${esc(isToday ? t('today') : `D-${diff}`)}</span>
      </div>${rows}</div>`;
  });
  // 군 복무 중이면 맨 위에 전역 카드
  const ms = feed.status && feed.status.type === 'military' && feed.status.until >= today ? feed.status : null;
  const milHtml = ms ? `<div class="rounded-[22px] p-4 bg-gradient-to-br from-[#24473A] to-[#3B7358] text-white flex items-center gap-3.5 shadow-[0_8px_22px_rgba(36,71,58,0.25)]">
      <span class="w-12 h-12 rounded-2xl bg-white/15 flex items-center justify-center shrink-0">${icon('shield', 'w-6 h-6')}</span>
      <span class="min-w-0 flex-1"><span class="block text-[15px] font-black truncate">${esc(t('milServing'))}${ms.unit ? ` · ${esc(ms.unit)}` : ''}</span>
        <span class="block text-[12px] text-white/80 mt-0.5">${esc(t('milUntil', { date: fmtDay(ms.until, { year: 'numeric', month: 'long', day: 'numeric' }) }))}</span></span>
      <span class="text-[22px] font-black tabular-nums shrink-0">D-${Math.max(0, Math.round((Date.parse(ms.until) - Date.parse(today)) / 86400e3))}</span>
    </div>` : '';
  const basis = feed.basis || [];
  const note = [basis.includes('espn') ? t('noteEspn') : '', basis.includes('kopis') ? t('noteKopis') : '', t('scheduleNote')].filter(Boolean).join(' · ');
  const dg = feed.diag || {};
  const espnMiss = dg.athlete && !basis.includes('espn') ? `<p class="text-[11px] text-[#C2410C] px-2 mt-2 flex items-start gap-1">${icon('info', 'w-3.5 h-3.5 shrink-0 mt-[1px]')}<span>${esc(t('espnFail'))} <span class="text-[#AEAEB2]">(${esc(String(dg.sports || '').slice(0, 60))})</span></span></p>` : '';
  const head = milHtml + `<div class="flex items-center justify-between px-1">
      <span class="text-[13px] font-bold text-[#3A3A3C]">${esc(t('schCount', { n: list.length }))}</span>
      <button data-s="refreshFeed" class="flex items-center gap-1 text-[12px] font-semibold text-[#E11D74] px-3 py-1.5 rounded-full bg-[#FFF0F6]">${icon('refresh', 'w-3.5 h-3.5')}${esc(t('refreshNow'))}</button>
    </div>`;
  const con = trendData('concert');
  const norm = (s) => String(s || '').replace(/\s/g, '').toLowerCase();
  const related = con ? con.items.filter((it) => [it.title, it.koreanName, it.keyword].some((v) => v && (norm(v).includes(norm(st.name)) || norm(st.name).includes(norm(v)) && norm(v).length > 1))) : [];
  const relHtml = related.length ? `<p class="text-[12px] font-bold text-[#8E8E93] px-1 pt-2 flex items-center gap-1">${icon('ticket', 'w-3.5 h-3.5')}${esc(t('relatedConcerts'))}</p>`
    + related.map((it) => `<button data-s="concert" data-id="${esc(it.id)}" class="w-full text-left flex items-center gap-3 bg-white rounded-[22px] p-3 border border-black/[0.03]">
        <span class="w-12 h-12 rounded-2xl overflow-hidden bg-[#EAF2FF] shrink-0">${it.image ? `<img src="${esc(it.image.thumb || it.image.url || '')}" class="w-full h-full object-cover" alt="" referrerpolicy="no-referrer">` : ''}</span>
        <span class="min-w-0 flex-1"><span class="block text-[14px] font-bold truncate">${esc(it.title)}</span><span class="block text-[12px] text-[#8E8E93] truncate">${esc(it.subtitle || '')}</span></span>
        <span class="text-[11px] font-bold text-[#2563EB] shrink-0 max-w-[96px] text-right leading-tight">${esc(concertDateText(it))}</span></button>`).join('') : '';
  return head + (items.length ? items.join('') : `<div class="bg-white rounded-[24px] p-7 text-center"><span class="inline-flex w-12 h-12 rounded-full bg-[#F2F2F7] text-[#8E8E93] items-center justify-center">${icon('calendar', 'w-6 h-6')}</span><p class="text-[13px] text-[#8E8E93] mt-3">${esc(t('noSchedule'))}</p></div>`)
    + relHtml
    + `<p class="text-[11px] text-[#AEAEB2] px-2 leading-relaxed flex gap-1">${icon('info', 'w-3.5 h-3.5 shrink-0 mt-[1px]')}<span>${esc(note)} · ${esc(t('updated', { t: timeAgo(feed.updatedAt) }))}</span></p>` + espnMiss;
}
function newsHtml(feed) {
  if (!(feed.news || []).length) return `<div class="bg-white rounded-[24px] p-7 text-center text-[13px] text-[#8E8E93]">${esc(t('noNews'))}</div>`;
  return `<div class="bg-white rounded-[24px] border border-black/[0.03] divide-y divide-black/[0.05] overflow-hidden">${feed.news.map((n) => `
    <a href="${esc(safeUrl(n.link))}" target="_blank" rel="noopener noreferrer" class="block px-4 py-3.5 active:bg-black/[0.03]">
      <p class="text-[14.5px] font-semibold leading-snug">${esc(n.title)}</p>
      ${n.desc ? `<p class="text-[12px] text-[#8E8E93] mt-1 line-clamp-2">${esc(n.desc)}</p>` : ''}
      <p class="text-[11px] text-[#AEAEB2] mt-1 flex items-center gap-1">${icon('newspaper', 'w-3 h-3')}${esc(fmtDay(n.date))}</p>
    </a>`).join('')}</div>`;
}
function photosHtml(feed) {
  if (!(feed.photos || []).length) return `<div class="bg-white rounded-[24px] p-7 text-center text-[13px] text-[#8E8E93]">${esc(t('noNews'))}</div>`;
  return `<div class="grid grid-cols-3 gap-1.5">${feed.photos.map((p) => `
    <a href="${esc(safeUrl(p.full || p.thumb))}" target="_blank" rel="noopener noreferrer" class="aspect-square rounded-2xl overflow-hidden bg-[#F2F2F7]"><img src="${esc(p.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" class="w-full h-full object-cover" onerror="this.parentNode.remove()"></a>`).join('')}</div>
    <p class="text-[11px] text-[#AEAEB2] px-2">${esc(t('imageCredit'))}</p>`;
}

/* ---------- Q&A ---------- */
S.myAnswers = {};
async function loadQuestions() {
  if (S.questions) return S.questions;
  S.questions = must(await sb.from('korrier_questions').select('id,ord,text').eq('active', true).order('ord').order('id'));
  return S.questions;
}
async function renderQna(st) {
  const body = $('#starSegBody');
  body.innerHTML = `<div class="bg-white rounded-[24px] p-8 flex justify-center"><span class="w-7 h-7 rounded-full border-[3px] border-[#FFD1E3] border-t-[#E11D74] animate-spin"></span></div>`;
  let qs, mine;
  try {
    [qs, mine] = await Promise.all([
      loadQuestions(),
      sb.from('korrier_star_answers').select('question_id,answer').eq('star_name', st.name).then(must),
    ]);
  } catch (e) { body.innerHTML = `<div class="bg-white rounded-[24px] p-6 text-center text-[13px] text-[#8E8E93]">${esc(errText(e))}</div>`; return; }
  if (S.starSeg !== 'qna' || curStar() !== st) return;
  const map = {};
  mine.forEach((a) => { map[a.question_id] = a.answer; });
  S.myAnswers[st.name] = map;
  if (!qs.length) { body.innerHTML = `<div class="bg-white rounded-[24px] p-7 text-center text-[13px] text-[#8E8E93]">${esc(t('noQuestions'))}</div>`; return; }
  const done = qs.filter((q) => map[q.id]).length;
  body.innerHTML = `
    <div class="flex items-center justify-between px-1">
      <p class="text-[12px] text-[#8E8E93] flex-1 pr-3">${esc(t('qnaIntro'))}</p>
      <span class="shrink-0 px-3 py-1 rounded-full bg-[#FFF0F6] text-[#E11D74] text-[12px] font-bold">${esc(t('qnaProgress', { a: done, b: qs.length }))}</span>
    </div>
    <div class="h-1.5 bg-[#E9E9EE] rounded-full overflow-hidden mx-1"><div class="h-full bg-[#E11D74] rounded-full transition-all" style="width:${(done / qs.length) * 100}%"></div></div>
    ${qs.map((q, i) => qCardHtml(q, i, map[q.id])).join('')}`;
  translateDom(body);
}
function qCardHtml(q, i, ans) {
  return `<div class="bg-white rounded-[26px] p-5 border border-black/[0.03]" data-q="${q.id}">
    <div class="flex items-center gap-2"><span class="px-2.5 py-1 rounded-full bg-[#1B1F27] text-white text-[11px] font-bold">Q${i + 1}</span>${ans ? `<span class="text-[#34C759]">${icon('check', 'w-4 h-4', 2.4)}</span>` : ''}</div>
    <p class="text-[18px] font-bold leading-snug mt-3">${trSpan(q.text)}</p>
    ${ans ? `<div class="mt-3 rounded-2xl bg-[#FFF5F9] px-4 py-3">
        <p class="text-[11px] font-bold text-[#E11D74] mb-1">${esc(t('me'))}</p>
        <p class="text-[14px] leading-relaxed whitespace-pre-wrap break-words">${esc(ans)}</p></div>
      <div class="flex gap-2 mt-3">
        <button data-s="qedit" class="px-4 py-2.5 rounded-xl bg-[#F2F2F7] text-[13px] font-semibold flex items-center gap-1">${icon('pencil', 'w-3.5 h-3.5')}${esc(t('edit'))}</button>
        <button data-s="qothers" class="flex-1 py-2.5 rounded-xl bg-[#E11D74] text-white text-[13px] font-bold flex items-center justify-center gap-1">${icon('users', 'w-4 h-4')}${esc(t('othersAnswers'))}</button>
      </div><div class="q-others mt-3 space-y-2"></div>`
    : qEditorHtml('')}
  </div>`;
}
const qEditorHtml = (val) => `<textarea maxlength="1000" rows="3" class="q-input mt-3 w-full px-4 py-3 rounded-2xl bg-[#F2F2F7] text-[14px] leading-relaxed outline-none focus:bg-white focus:ring-2 focus:ring-[#E11D74]/40 resize-none" placeholder="${esc(t('answerPh'))}">${esc(val)}</textarea>
  <div class="flex items-center gap-2 mt-2"><span class="flex-1 text-[11px] text-[#AEAEB2] flex items-center gap-1">${icon('lock', 'w-3 h-3')}${esc(t('qnaIntro'))}</span>
  <button data-s="qsave" class="px-5 py-2.5 rounded-xl bg-[#1B1F27] text-white text-[13px] font-bold">${esc(t('answerSave'))}</button></div>`;

async function saveAnswer(card) {
  const st = curStar();
  const qid = Number(card.dataset.q);
  const val = card.querySelector('.q-input').value.trim();
  if (!val) { toast(t('err_body_required'), 'alert'); return; }
  try {
    must(await sb.from('korrier_star_answers').upsert({ user_id: S.user.id, star_name: st.name, question_id: qid, answer: val }, { onConflict: 'user_id,star_name,question_id' }));
    toast(t('toast_starSaved'), 'check');
    await renderQna(st);
    const again = $(`#starSegBody [data-q="${qid}"]`);
    if (again) showOthers(again);
  } catch (e) { toastErr(e); }
}
async function showOthers(card) {
  const box = card.querySelector('.q-others');
  if (!box) return;
  if (box.dataset.open) { box.innerHTML = ''; delete box.dataset.open; return; }
  box.dataset.open = '1';
  box.innerHTML = `<div class="flex justify-center py-3"><span class="w-6 h-6 rounded-full border-[3px] border-[#FFD1E3] border-t-[#E11D74] animate-spin"></span></div>`;
  try {
    const rows = must(await sb.rpc('korrier_fan_answers', { p_star: curStar().name, p_question: Number(card.dataset.q) })).filter((r) => !r.is_mine);
    box.innerHTML = rows.length ? rows.map((r) => `<div class="rounded-2xl bg-[#F7F7F9] px-4 py-3">
        <p class="text-[11px] font-bold text-[#6E6E73] flex items-center gap-1">${icon('user', 'w-3 h-3')}${esc(r.nickname)}<span class="font-normal text-[#AEAEB2] ml-auto">${esc(timeAgo(r.created_at))}</span></p>
        <p class="text-[14px] leading-relaxed mt-1 whitespace-pre-wrap break-words">${esc(r.answer)}</p></div>`).join('')
      : `<p class="text-center text-[12px] text-[#8E8E93] py-2">${esc(t('noOthers'))}</p>`;
  } catch (e) { box.innerHTML = `<p class="text-center text-[12px] text-rose-500 py-2">${esc(errText(e))}</p>`; }
}

$('#starView').addEventListener('click', (e) => {
  const b = e.target.closest('[data-s]');
  if (!b) return;
  const a = b.dataset.s;
  if (a === 'login') openAuth('landing');
  else if (a === 'add') openStarModal();
  else if (a === 'pick') { S.starIdx = Number(b.dataset.i); renderStarView(); }
  else if (a === 'seg') { S.starSeg = b.dataset.k; renderStarView(); }
  else if (a === 'refreshFeed') { const st = curStar(); b.disabled = true; b.classList.add('opacity-50'); toast(t('feedLoading'), 'refresh'); loadFeed(st.name, true); }
  else if (a === 'retry') { const st = curStar(); delete S.feeds[`${st.name}|${S.lang}`]; renderStarSeg(); }
  else if (a === 'concert') { const con = trendData('concert'); const it = con && con.items.find((x) => x.id === b.dataset.id); if (it) openDetail(it); }
  else if (a === 'qsave') saveAnswer(b.closest('[data-q]'));
  else if (a === 'qothers') showOthers(b.closest('[data-q]'));
  else if (a === 'qedit') {
    const card = b.closest('[data-q]');
    const cur = (S.myAnswers[curStar().name] || {})[card.dataset.q] || '';
    const head = card.querySelector('p.text-\\[18px\\]');
    [...card.children].forEach((ch) => { if (ch !== card.firstElementChild && ch !== head) ch.remove(); });
    card.insertAdjacentHTML('beforeend', qEditorHtml(cur));
    card.querySelector('.q-input').focus();
  }
});

/* ================= 스타 등록 ================= */
S.reg = null;
function openStarModal() {
  if (needLogin()) return;
  if (S.stars.length >= MAX_STARS) { toast(t('err_star_limit'), 'alert'); return; }
  S.reg = { step: 'search', q: '', results: null, loading: false, pick: null, photos: null, photo: '', since: todayStr() };
  showScreen('starModal');
  renderStarModal();
  setTimeout(() => { const i = $('#starQ'); if (i) i.focus(); }, 80);
}
$('#starModalBack').onclick = () => {
  const r = S.reg;
  if (!r || r.step === 'search') { hideScreen('starModal'); return; }
  r.step = r.step === 'date' ? 'photo' : 'search';
  renderStarModal();
};
function renderStarModal() {
  const r = S.reg;
  const body = $('#starModalBody');
  const dots = ['search', 'photo', 'date'].map((s) => `<span class="h-1.5 rounded-full transition-all ${s === r.step ? 'w-6 bg-[#E11D74]' : 'w-1.5 bg-[#D1D1D6]'}"></span>`).join('');
  const head = `<div class="flex justify-center gap-1.5 mb-5">${dots}</div>`;
  if (r.step === 'search') {
    const list = r.loading
      ? `<div class="flex justify-center py-10"><span class="w-8 h-8 rounded-full border-[3px] border-[#FFD1E3] border-t-[#E11D74] animate-spin"></span></div>`
      : r.error ? `<p class="text-center text-[13px] text-rose-500 py-8">${esc(errText(r.error))}</p>`
      : r.results && !r.results.length ? `<p class="text-center text-[13px] text-[#8E8E93] py-8">${esc(t('noResults'))}</p>`
      : (r.results || []).map((x, i) => `<button data-r="pick" data-i="${i}" class="w-full flex items-center gap-3 p-3 rounded-[20px] hover:bg-[#F7F7F9] active:bg-[#FFF0F6] text-left">
          <span class="w-14 h-14 rounded-full overflow-hidden bg-[#FFF0F6] shrink-0">${starImg(x)}</span>
          <span class="min-w-0 flex-1"><span class="block text-[16px] font-bold truncate">${esc(x.name)}${x.sub ? ` <span class="text-[12px] font-medium text-[#8E8E93]">${trSpan(x.sub)}</span>` : ''}</span>
          <span class="block text-[12px] text-[#8E8E93] line-clamp-2">${esc(x.desc || '')}</span></span>
          ${icon('chevR', 'w-4 h-4 text-[#C7C7CC] shrink-0')}</button>`).join('');
    body.innerHTML = `${head}
      <h2 class="text-[26px] font-black tracking-tight">${esc(t('starRegister'))}</h2>
      <p class="text-[13px] text-[#8E8E93] mt-1">${esc(t('starSearchHint'))}</p>
      <form id="starSearchForm" class="flex gap-2 mt-5">
        <div class="relative flex-1"><span class="absolute left-4 top-1/2 -translate-y-1/2 text-[#8E8E93]">${icon('search', 'w-5 h-5')}</span>
        <input id="starQ" value="${esc(r.q)}" maxlength="40" enterkeyhint="search" class="w-full pl-11 pr-3 py-4 rounded-[18px] bg-[#F2F2F7] text-[16px] outline-none focus:bg-white focus:ring-2 focus:ring-[#E11D74]/40" placeholder="${esc(t('starSearchPh'))}"></div>
        <button class="px-5 rounded-[18px] bg-[#E11D74] text-white font-bold text-[15px] shrink-0">${esc(t('searchBtn'))}</button>
      </form>
      <div class="mt-4 space-y-1">${list}</div>`;
    translateDom(body);
    $('#starSearchForm').onsubmit = (e) => { e.preventDefault(); searchStar($('#starQ').value.trim()); };
  } else if (r.step === 'photo') {
    const opts = [];
    if (r.pick.photo) opts.push(r.pick.photo);
    (r.photos || []).forEach((p) => { if (!opts.includes(p.thumb)) opts.push(p.thumb); });
    if (r.photo && !opts.includes(r.photo)) opts.unshift(r.photo);
    body.innerHTML = `${head}
      <div class="flex flex-col items-center text-center">
        <span class="w-28 h-28 rounded-full overflow-hidden bg-[#FFF0F6] ring-4 ring-[#FFD1E3]">${starImg({ photo: r.photo })}</span>
        <h2 class="text-[24px] font-black mt-3">${esc(r.pick.name)}</h2>
        <p class="text-[13px] text-[#8E8E93] mt-1">${esc(t('pickPhoto'))}</p>
      </div>
      <div class="grid grid-cols-4 gap-2 mt-5">
        <button data-r="upload" class="aspect-square rounded-full border-2 border-dashed border-[#D1D1D6] text-[#8E8E93] flex flex-col items-center justify-center gap-0.5">${icon('camera', 'w-5 h-5')}<span class="text-[10px]">${esc(t('uploadPhoto'))}</span></button>
        ${opts.map((u) => `<button data-r="photo" data-u="${esc(u)}" class="aspect-square rounded-full overflow-hidden bg-[#F2F2F7] ${u === r.photo ? 'ring-[3px] ring-[#E11D74] ring-offset-2' : ''}"><img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" class="w-full h-full object-cover" onerror="this.parentNode.remove()"></button>`).join('')}
        ${r.photos ? '' : `<span class="aspect-square rounded-full bg-[#F2F2F7] animate-pulse"></span><span class="aspect-square rounded-full bg-[#F2F2F7] animate-pulse"></span>`}
      </div>
      <input id="starPhotoInput" type="file" accept="image/*" class="hidden">
      <button data-r="next" class="mt-6 w-full py-4 rounded-[18px] bg-[#1B1F27] text-white font-bold text-[16px] disabled:opacity-40" ${r.photo ? '' : 'disabled'}>${esc(t('next'))}</button>`;
    $('#starPhotoInput').onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try { r.photo = await resizeImage(f, 320); renderStarModal(); } catch { toast(t('err_generic'), 'alert'); }
    };
  } else {
    body.innerHTML = `${head}
      <div class="flex flex-col items-center text-center">
        <span class="w-24 h-24 rounded-full overflow-hidden bg-[#FFF0F6] ring-4 ring-[#FFD1E3]">${starImg({ photo: r.photo })}</span>
        <h2 class="text-[26px] font-black tracking-tight mt-5">${esc(t('whenStarted'))}</h2>
        <p class="text-[13px] text-[#8E8E93] mt-1">${esc(r.pick.name)}</p>
      </div>
      <label class="block mt-6 relative">
        <input id="starSince" type="date" value="${esc(r.since)}" max="${todayStr()}" min="1990-01-01" class="w-full px-5 py-4 rounded-[18px] bg-[#F2F2F7] text-[18px] font-bold text-center outline-none focus:ring-2 focus:ring-[#E11D74]/40 appearance-none">
      </label>
      <p id="sincePreview" class="text-center text-[14px] font-bold text-[#E11D74] mt-3">${esc(t('fanDay', { n: fmtNum(fanDays(r.since)) }))}</p>
      <button data-r="save" class="mt-6 w-full py-4 rounded-[18px] bg-[#E11D74] text-white font-bold text-[16px] flex items-center justify-center gap-2 active:scale-[0.98] transition">${icon('heart', 'w-5 h-5')}${esc(t('register'))}</button>`;
    $('#starSince').oninput = (e) => {
      const v = e.target.value;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v <= todayStr()) { r.since = v; $('#sincePreview').textContent = t('fanDay', { n: fmtNum(fanDays(v)) }); }
    };
  }
}
async function searchStar(q) {
  const r = S.reg;
  if (!q) return;
  r.q = q; r.loading = true; r.error = null;
  renderStarModal();
  try {
    const d = await fn('star_search', { q });
    if (S.reg !== r) return;
    r.results = d.results || [];
  } catch (e) { r.error = e; r.results = null; }
  r.loading = false;
  if (S.reg === r && r.step === 'search') renderStarModal();
}
async function loadStarPhotos(r) {
  try { const d = await fn('star_photos', { name: r.pick.name }); r.photos = d.photos || []; } catch { r.photos = []; }
  if (S.reg === r && r.step === 'photo') renderStarModal();
}
$('#starModalBody').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-r]');
  const r = S.reg;
  if (!b || !r) return;
  const a = b.dataset.r;
  if (a === 'pick') {
    const x = r.results[Number(b.dataset.i)];
    if (S.stars.some((s) => s.name === x.name)) { toast(t('err_star_exists'), 'alert'); return; }
    r.pick = x; r.photo = x.photo || ''; r.photos = null; r.step = 'photo';
    renderStarModal();
    loadStarPhotos(r);
  } else if (a === 'photo') { r.photo = b.dataset.u; renderStarModal(); }
  else if (a === 'upload') $('#starPhotoInput').click();
  else if (a === 'next') { r.step = 'date'; renderStarModal(); }
  else if (a === 'save') {
    b.disabled = true;
    try {
      const row = must(await sb.from('korrier_stars').insert({
        user_id: S.user.id, name: r.pick.name, sub: (r.pick.sub || '').slice(0, 60), photo: r.photo || null,
        fan_since: r.since, is_main: S.stars.length === 0,
      }).select().single());
      S.stars.push(row);
      S.starIdx = S.stars.length - 1;
      S.starSeg = 'schedule';
      hideScreen('starModal');
      renderUserChrome();
      playFanAnimation(row);
    } catch (err) {
      b.disabled = false;
      toast(err.code === '23505' ? t('err_star_exists') : errText(err), 'alert');
    }
  }
});

/* ---------- 팬 등록 애니메이션 (토스 스타일) ---------- */
function playFanAnimation(st) {
  const el = $('#fanAnim');
  const days = fanDays(st.fan_since);
  const colors = ['#E11D74', '#FF7EB3', '#7C3AED', '#F59E0B', '#0EA5E9', '#34C759'];
  const confetti = Array.from({ length: 18 }, (_, i) => {
    const ang = (i / 18) * Math.PI * 2;
    const dist = 110 + (i % 3) * 28;
    return `<span class="fan-bit" style="--x:${Math.cos(ang) * dist}px;--y:${Math.sin(ang) * dist}px;background:${colors[i % colors.length]};animation-delay:${0.25 + (i % 4) * 0.03}s;${i % 2 ? 'border-radius:2px' : ''}"></span>`;
  }).join('');
  el.innerHTML = `
    <div class="relative w-[150px] h-[150px] flex items-center justify-center">
      <span class="fan-ring absolute inset-0 rounded-full border-4 border-[#FF7EB3]"></span>
      <span class="absolute inset-0 flex items-center justify-center">${confetti}</span>
      <span class="fan-pop relative w-[150px] h-[150px] rounded-full overflow-hidden bg-[#FFF0F6] ring-[6px] ring-white shadow-[0_18px_40px_rgba(225,29,116,0.35)]">${starImg(st)}</span>
      <span class="fan-pop absolute -bottom-1 -right-1 w-11 h-11 rounded-full bg-[#E11D74] text-white flex items-center justify-center ring-4 ring-white" style="animation-delay:.55s">${icon('heart', 'w-5 h-5')}</span>
    </div>
    <h2 class="fade-up text-[30px] font-black tracking-tight mt-8" style="animation-delay:.6s">${esc(st.name)}</h2>
    <p class="fade-up text-[17px] font-semibold text-[#3A3A3C] mt-2" style="animation-delay:.85s">${esc(t('fanBecame', { name: st.name }))}</p>
    <p class="fade-up text-[15px] font-bold text-[#E11D74] mt-4 px-4 py-2 rounded-full bg-[#FFF0F6]" style="animation-delay:1.1s" id="fanDayText">${esc(t('fanDay', { n: 1 }))}</p>
    <button id="fanDone" class="fade-up absolute left-6 right-6 py-4 rounded-[18px] bg-[#1B1F27] text-white font-bold text-[16px]" style="animation-delay:1.6s;bottom:calc(28px + env(safe-area-inset-bottom))">${esc(t('startBtn'))}</button>`;
  showScreen('fanAnim');
  if (navigator.vibrate) try { navigator.vibrate([20, 40, 30]); } catch {}
  // 1일째부터 실제 일수까지 숫자가 올라가는 효과
  const start = performance.now() + 1150;
  const dur = Math.min(1600, 500 + days * 4);
  const tick = (now) => {
    const p = Math.max(0, Math.min(1, (now - start) / dur));
    const val = Math.max(1, Math.round(1 + (days - 1) * (1 - Math.pow(1 - p, 3))));
    const tx = $('#fanDayText');
    if (!tx || el.classList.contains('hidden')) return;
    tx.textContent = t('fanDay', { n: fmtNum(val) });
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  $('#fanDone').onclick = () => { hideScreen('fanAnim'); el.innerHTML = ''; selectTab('star'); };
}

/* ================= 설정 ================= */
$('#btnSettings').onclick = () => { renderSettings(); $('#setAccountBox').classList.add('hidden'); showScreen('settingsScreen'); };
function renderSettings() {
  const u = S.user;
  $('#setProfile').innerHTML = u
    ? `<span class="w-16 h-16 rounded-full overflow-hidden bg-[#E2E8F0] flex items-center justify-center text-slate-400 shrink-0">${avatarHtml(u, 'w-8 h-8')}</span>
       <span class="min-w-0 flex-1"><span class="block text-[19px] font-bold truncate">${esc(u.nickname)}</span><span class="block text-[13px] text-[#8E8E93] truncate">${esc(u.email || '')}</span></span>
       <button data-set="profile" class="px-4 py-2 rounded-full bg-[#F2F2F7] text-[14px] font-semibold shrink-0">${esc(t('manage'))}</button>`
    : `<span class="w-16 h-16 rounded-full bg-[#F2F2F7] flex items-center justify-center text-[#8E8E93] shrink-0">${icon('user', 'w-8 h-8')}</span>
       <span class="min-w-0 flex-1 text-[14px] text-[#6E6E73]">${esc(t('loginPrompt'))}</span>
       <button data-set="login" class="px-4 py-2 rounded-full bg-[#1B1F27] text-white text-[14px] font-semibold shrink-0">${esc(t('login'))}</button>`;
  $('#setNickVal').textContent = u ? u.nickname : '';
  const ms = mainStar();
  $('#setStarVal').textContent = ms ? `${ms.name} D+${fanDays(ms.fan_since)}` : '';
  $('#setLangVal').textContent = langInfo().label;
  $('#serverVer').textContent = `서버 ${(S.config && S.config.serverVersion) || '확인 중'}`;
  const cc = (u && u.country) || localStorage.getItem('korrier_country') || '';
  $('#setCountryVal').textContent = cc ? countryName(cc) : '';
  $('#setCountry').innerHTML = countryOptions(cc, !cc);
  $('#btnLogout').classList.toggle('hidden', !u);
  const lb = $('#setLangBox');
  if (lb) lb.innerHTML = langListHtml();
}
const langListHtml = () => LANGS.map((l) => `<button data-lang="${l.code}" class="w-full text-left px-14 py-3 text-[15px] flex items-center gap-2">${esc(l.label)}<span class="ml-auto text-[#2563EB]">${l.code === S.lang ? icon('check', 'w-4 h-4', 2.4) : ''}</span></button>`).join('');
$('#settingsScreen').addEventListener('click', (e) => {
  const lang = e.target.closest('#setLangBox [data-lang]');
  if (lang) { changeLanguage(lang.dataset.lang); renderSettings(); return; }
  const b = e.target.closest('[data-set]');
  if (!b) return;
  const a = b.dataset.set;
  if (a === 'login') { openAuth('landing'); return; }
  if (a === 'lang') {
    const ex = $('#setLangBox');
    if (ex) { ex.remove(); return; }
    b.insertAdjacentHTML('afterend', `<div id="setLangBox" class="bg-[#FAFAFC]">${langListHtml()}</div>`);
    return;
  }
  if (needLogin()) return;
  if (a === 'profile') openProfile();
  else if (a === 'stars') openStarManage();
  else if (a === 'account') { $('#setAccountBox').classList.toggle('hidden'); resetDeleteBtn(); }
});

$('#setCountry').onchange = async (e) => {
  const cc = e.target.value;
  if (!COUNTRIES[cc]) return;
  localStorage.setItem('korrier_country', cc);
  if (S.user) {
    S.user.country = cc;
    await sb.from('korrier_profiles').update({ country: cc }).eq('id', S.user.id);
  }
  const lang = COUNTRIES[cc];
  if (lang !== S.lang) changeLanguage(lang);
  renderSettings();
};

/* ---------- MY스타 관리 ---------- */
function openStarManage() { renderStarManage(); showScreen('starManageScreen'); }
function renderStarManage() {
  const list = $('#starManageList');
  list.innerHTML = S.stars.map((st) => `
    <div class="bg-white rounded-[24px] p-4 border border-black/[0.03]" data-sid="${st.id}">
      <div class="flex items-center gap-3">
        <span class="w-14 h-14 rounded-full overflow-hidden bg-[#FFF0F6] shrink-0">${starImg(st)}</span>
        <div class="min-w-0 flex-1">
          <p class="text-[16px] font-bold truncate flex items-center gap-1.5">${esc(st.name)}${st.is_main ? `<span class="px-2 py-0.5 rounded-full bg-[#FFF0F6] text-[#E11D74] text-[10px] font-bold flex items-center gap-0.5">${icon('crown', 'w-3 h-3')}${esc(t('mainStar'))}</span>` : ''}</p>
          <p class="text-[12px] text-[#E11D74] font-semibold">${esc(t('daysLoved', { name: st.name, n: fmtNum(fanDays(st.fan_since)) }))}</p>
        </div>
      </div>
      <label class="flex items-center gap-2 mt-3 bg-[#F7F7F9] rounded-2xl px-4 py-2.5">
        <span class="text-[13px] text-[#6E6E73] flex-1 flex items-center gap-1.5">${icon('calendar', 'w-4 h-4')}${esc(t('fanSinceLabel'))}</span>
        <input type="date" data-m="since" value="${esc(st.fan_since)}" max="${todayStr()}" min="1990-01-01" class="bg-transparent text-[14px] font-bold text-right outline-none">
      </label>
      <div class="grid grid-cols-2 gap-2 mt-2">
        <button data-m="main" class="py-2.5 rounded-xl text-[13px] font-semibold flex items-center justify-center gap-1 ${st.is_main ? 'bg-[#F2F2F7] text-[#AEAEB2]' : 'bg-[#FFF0F6] text-[#E11D74]'}" ${st.is_main ? 'disabled' : ''}>${icon('crown', 'w-4 h-4')}${esc(t('setMain'))}</button>
        <button data-m="remove" class="py-2.5 rounded-xl bg-rose-50 text-rose-600 text-[13px] font-semibold">${esc(t('removeStar'))}</button>
      </div>
    </div>`).join('')
    + (S.stars.length < MAX_STARS ? `<button data-m="add" class="w-full py-4 rounded-[22px] border-2 border-dashed border-[#D1D1D6] text-[#6E6E73] font-semibold text-[15px] flex items-center justify-center gap-2">${icon('plus', 'w-5 h-5')}${esc(t('starRegister'))}</button>` : '');
}
$('#starManageList').addEventListener('change', async (e) => {
  const inp = e.target.closest('[data-m="since"]');
  if (!inp) return;
  const st = S.stars.find((x) => x.id === inp.closest('[data-sid]').dataset.sid);
  const v = inp.value;
  if (!st || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v > todayStr()) { inp.value = st ? st.fan_since : ''; return; }
  try {
    must(await sb.from('korrier_stars').update({ fan_since: v }).eq('id', st.id));
    st.fan_since = v;
    renderStarManage(); renderUserChrome();
    if (S.tab === 'star') renderStarView();
    toast(t('toast_starSaved'), 'check');
  } catch (err) { toastErr(err); }
});
$('#starManageList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-m]');
  if (!b || b.dataset.m === 'since') return;
  if (b.dataset.m === 'add') { openStarModal(); return; }
  const st = S.stars.find((x) => x.id === b.closest('[data-sid]').dataset.sid);
  if (!st) return;
  try {
    if (b.dataset.m === 'main') {
      must(await sb.from('korrier_stars').update({ is_main: false }).eq('user_id', S.user.id).neq('id', st.id));
      must(await sb.from('korrier_stars').update({ is_main: true }).eq('id', st.id));
      S.stars.forEach((x) => { x.is_main = x === st; });
      S.stars.sort((a, c) => (c.is_main - a.is_main));
    } else if (b.dataset.m === 'remove') {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = t('confirmAgain'); setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = t('removeStar'); } }, 4000); return; }
      must(await sb.from('korrier_stars').delete().eq('id', st.id));
      S.stars = S.stars.filter((x) => x !== st);
      if (st.is_main && S.stars[0]) { S.stars[0].is_main = true; await sb.from('korrier_stars').update({ is_main: true }).eq('id', S.stars[0].id); }
      toast(t('toast_starRemoved'), 'check');
    }
    S.starIdx = 0;
    renderStarManage(); renderUserChrome();
    if (S.tab === 'star') renderStarView();
  } catch (err) { toastErr(err); }
});
// 스타 등록 화면이 관리 화면 위에 뜨도록, 등록 후 관리 목록 갱신
const _fanDone = playFanAnimation;
playFanAnimation = function (st) { if (!$('#starManageScreen').classList.contains('hidden')) renderStarManage(); _fanDone(st); };

/* ================= 친구 ================= */
$('#btnFriends').onclick = () => { if (needLogin()) return; showScreen('friendsScreen'); renderFriends(); };
async function renderFriends() {
  const body = $('#friendsBody');
  const code = S.user.friend_code || '';
  const top = `<div class="bg-gradient-to-br from-[#1E3A8A] to-[#2563EB] text-white rounded-[26px] p-5">
      <p class="text-[12px] text-white/75 font-semibold">${esc(t('myFriendCode'))}</p>
      <div class="flex items-center gap-3 mt-1"><span class="text-[30px] font-black tracking-[0.18em] flex-1">${esc(code || '—')}</span>
      <button data-f="copy" class="w-11 h-11 rounded-full bg-white/20 flex items-center justify-center">${icon('copy', 'w-5 h-5')}</button>
      <button data-f="share" class="w-11 h-11 rounded-full bg-white/20 flex items-center justify-center">${icon('share', 'w-5 h-5')}</button></div>
      <p class="text-[12px] text-white/75 mt-2">${esc(t('friendCodeHint'))}</p></div>
    <form id="friendAddForm" class="flex gap-2">
      <input id="friendCodeInput" maxlength="8" autocapitalize="characters" autocomplete="off" class="flex-1 min-w-0 px-4 py-3.5 rounded-[18px] bg-white border border-black/[0.06] text-[16px] font-bold tracking-[0.15em] uppercase outline-none focus:ring-2 focus:ring-[#2563EB]/40" placeholder="${esc(t('addFriendPh'))}">
      <button class="px-5 rounded-[18px] bg-[#1B1F27] text-white font-bold text-[15px] flex items-center gap-1 shrink-0">${icon('userPlus', 'w-5 h-5')}${esc(t('addFriend'))}</button>
    </form>`;
  body.innerHTML = top + `<div id="friendList" class="flex justify-center py-6"><span class="w-7 h-7 rounded-full border-[3px] border-[#DBEAFE] border-t-[#2563EB] animate-spin"></span></div>`;
  $('#friendAddForm').onsubmit = async (e) => {
    e.preventDefault();
    const c = $('#friendCodeInput').value.trim().toUpperCase();
    if (c.length < 4) return;
    try {
      const r = must(await sb.rpc('korrier_add_friend', { p_code: c }));
      toast(t('fr_' + r), r === 'requested' || r === 'accepted' ? 'check' : 'info');
      if (r === 'requested' || r === 'accepted') { $('#friendCodeInput').value = ''; loadFriendList(); }
    } catch (err) { toastErr(err); }
  };
  if (!code) { // 예전에 만든 프로필이면 친구코드를 다시 읽어 옴
    try { const p = must(await sb.from('korrier_profiles').select('friend_code').eq('id', S.user.id).single()); S.user.friend_code = p.friend_code || ''; if (S.user.friend_code) return renderFriends(); } catch {}
  }
  loadFriendList();
}
async function loadFriendList() {
  const box = $('#friendList');
  if (!box) return;
  let rows;
  try { rows = must(await sb.rpc('korrier_friends')); } catch (e) { box.innerHTML = `<p class="text-[13px] text-rose-500">${esc(errText(e))}</p>`; return; }
  const incoming = rows.filter((r) => r.incoming);
  const rest = rows.filter((r) => !r.incoming);
  const row = (r) => `<div class="flex items-center gap-3 px-4 py-3" data-fid="${r.id}">
      <span class="w-12 h-12 rounded-full overflow-hidden bg-[#E2E8F0] text-slate-400 flex items-center justify-center shrink-0">${r.photo ? `<img src="${esc(r.photo)}" class="w-full h-full object-cover" alt="">` : icon('user', 'w-6 h-6')}</span>
      <div class="min-w-0 flex-1">
        <p class="text-[15px] font-bold truncate">${esc(r.nickname)}</p>
        ${r.star_name ? `<p class="text-[12px] text-[#E11D74] font-semibold flex items-center gap-1 truncate"><span class="w-4 h-4 rounded-full overflow-hidden bg-[#FFF0F6] shrink-0">${starImg({ photo: r.star_photo })}</span>${esc(t('daysLoved', { name: r.star_name, n: fmtNum(fanDays(r.fan_since)) }))}</p>` : `<p class="text-[12px] text-[#AEAEB2]">${esc(t('noStarYet'))}</p>`}
      </div>
      ${r.incoming ? `<button data-f="accept" class="px-3.5 py-2 rounded-full bg-[#2563EB] text-white text-[13px] font-bold">${esc(t('accept'))}</button>` : r.status === 'pending' ? `<span class="text-[12px] text-[#8E8E93]">${esc(t('pending'))}</span>` : ''}
      <button data-f="remove" class="w-8 h-8 rounded-full bg-[#F2F2F7] text-[#8E8E93] flex items-center justify-center">${icon('close', 'w-4 h-4')}</button>
    </div>`;
  box.className = 'space-y-4';
  box.innerHTML = (incoming.length ? `<div><p class="text-[13px] font-bold text-[#6E6E73] px-1 mb-2">${esc(t('friendRequests'))} ${incoming.length}</p><div class="bg-white rounded-[24px] divide-y divide-black/[0.05]">${incoming.map(row).join('')}</div></div>` : '')
    + `<div><p class="text-[13px] font-bold text-[#6E6E73] px-1 mb-2">${esc(t('myFriends'))} ${rest.filter((r) => r.status === 'accepted').length}</p>`
    + (rest.length ? `<div class="bg-white rounded-[24px] divide-y divide-black/[0.05]">${rest.map(row).join('')}</div>` : `<div class="bg-white rounded-[24px] p-8 text-center"><span class="inline-flex w-14 h-14 rounded-full bg-[#F2F2F7] text-[#8E8E93] items-center justify-center">${icon('users', 'w-7 h-7')}</span><p class="text-[13px] text-[#8E8E93] mt-3">${esc(t('noFriends'))}</p></div>`)
    + '</div>';
}
$('#friendsBody').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  const a = b.dataset.f;
  const code = S.user && S.user.friend_code;
  if (a === 'copy' && code) { try { await navigator.clipboard.writeText(code); toast(t('toast_copied'), 'copy'); } catch { toast(code, 'copy'); } return; }
  if (a === 'share' && code) {
    const text = `Korrier ${t('myFriendCode')}: ${code}\n${appUrl()}`;
    if (navigator.share) navigator.share({ text }).catch(() => {}); else { try { await navigator.clipboard.writeText(text); toast(t('toast_copied'), 'copy'); } catch {} }
    return;
  }
  const id = b.closest('[data-fid]') && b.closest('[data-fid]').dataset.fid;
  if (!id) return;
  try {
    if (a === 'accept') { must(await sb.rpc('korrier_accept_friend', { p_id: id })); toast(t('fr_accepted'), 'check'); }
    else if (a === 'remove') {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.classList.add('bg-rose-500', 'text-white'); setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.classList.remove('bg-rose-500', 'text-white'); } }, 3000); return; }
      must(await sb.rpc('korrier_remove_friend', { p_id: id }));
    }
    loadFriendList();
  } catch (err) { toastErr(err); }
});

/* ================= 커뮤니티 ================= */
const POST_CATS = ['free', 'question', 'review', 'info', 'goods', 'together'];
const CAT_COLOR = { free: '#2563EB', question: '#F59E0B', review: '#E11D74', info: '#0F766E', goods: '#7C3AED', together: '#EA580C' };
const PAGE = 20;
function commCats() { return ['all', 'hot', ...(S.user && S.stars.length ? ['mystar'] : []), ...POST_CATS]; }
async function renderCommunity(reset) {
  const v = $('#communityView');
  const c = S.community;
  if (!commCats().includes(c.cat)) c.cat = 'all';
  if (reset) { c.posts = []; c.offset = 0; c.done = false; }
  v.innerHTML = `
    <div class="px-1 pt-1">
      <h3 class="text-[26px] font-bold tracking-tight">${esc(t('nav_community'))}</h3>
      <p class="text-[12px] text-[#8E8E93] mt-0.5">${esc(t('communitySub'))}</p>
    </div>
    <div class="flex gap-1.5 overflow-x-auto no-scrollbar -mx-4 px-4 py-1">
      ${commCats().map((k) => `<button data-c="cat" data-k="${k}" class="shrink-0 px-4 py-2 rounded-full text-[13px] font-semibold border transition ${c.cat === k ? 'bg-[#1B1F27] text-white border-[#1B1F27]' : 'bg-white text-[#3A3A3C] border-black/[0.06]'}">${k === 'hot' ? icon('flame', 'w-3.5 h-3.5 inline -mt-0.5 mr-0.5') : ''}${esc(t('cat_' + k))}</button>`).join('')}
    </div>
    <div id="postList" class="space-y-2.5"></div>
    <div id="postMore" class="pb-6"></div>`;
  drawPosts();
  if (reset || !c.posts.length) await loadPosts();
}
async function loadPosts() {
  const c = S.community;
  if (c.loading || c.done) return;
  if (!sb) { $('#postList').innerHTML = `<div class="bg-white rounded-[24px] p-6 text-center text-[13px] text-[#8E8E93]">${esc(t('setupNeeded'))}</div>`; return; }
  c.loading = true;
  const cat = c.cat;
  drawPosts();
  try {
    const rows = must(await sb.rpc('korrier_list_posts', { p_category: cat, p_sort: 'new', p_star: null, p_limit: PAGE, p_offset: c.offset }));
    if (cat !== c.cat) return;
    c.posts.push(...rows.filter((r) => !c.posts.some((p) => p.id === r.id)));
    c.offset += rows.length;
    c.done = rows.length < PAGE;
    c.error = null;
  } catch (e) { c.error = e; }
  finally { if (cat === c.cat) { c.loading = false; if (S.tab === 'community') drawPosts(); } }
}
function postCardHtml(p) {
  const col = CAT_COLOR[p.category] || '#2563EB';
  return `<button data-c="open" data-id="${p.id}" class="w-full text-left bg-white rounded-[22px] p-4 border border-black/[0.03] active:scale-[0.99] transition">
    <div class="flex items-center gap-1.5 text-[11px] font-bold">
      <span class="px-2 py-0.5 rounded-full" style="background:${col}14;color:${col}">${esc(t('cat_' + p.category))}</span>
      ${p.star_name ? `<span class="px-2 py-0.5 rounded-full bg-[#FFF0F6] text-[#E11D74] flex items-center gap-0.5">${icon('heart', 'w-3 h-3')}${esc(p.star_name)}</span>` : ''}
      <span class="ml-auto font-normal text-[#AEAEB2]">${esc(timeAgo(p.created_at))}</span>
    </div>
    <p class="text-[16px] font-bold mt-2 leading-snug line-clamp-1">${esc(p.title)}</p>
    <p class="text-[13px] text-[#6E6E73] mt-1 leading-relaxed line-clamp-2">${esc(p.excerpt)}</p>
    <div class="flex items-center gap-3 mt-2.5 text-[12px] text-[#8E8E93]">
      <span class="flex items-center gap-1 min-w-0 truncate">${icon('user', 'w-3.5 h-3.5')}${esc(p.anonymous ? t('anonymous') : p.author)}</span>
      <span class="ml-auto flex items-center gap-1">${icon('heart', 'w-3.5 h-3.5')}${fmtNum(p.like_count)}</span>
      <span class="flex items-center gap-1">${icon('chat', 'w-3.5 h-3.5')}${fmtNum(p.comment_count)}</span>
      <span class="flex items-center gap-1">${icon('eye', 'w-3.5 h-3.5')}${fmtNum(p.view_count)}</span>
    </div></button>`;
}
function drawPosts() {
  const c = S.community;
  const list = $('#postList');
  if (!list) return;
  if (c.error && !c.posts.length) list.innerHTML = `<div class="bg-white rounded-[24px] p-6 text-center"><p class="text-[13px] text-[#8E8E93]">${esc(errText(c.error))}</p><button data-c="retry" class="mt-3 px-5 py-2 rounded-full bg-[#F2F2F7] text-[13px] font-semibold">${esc(t('retry'))}</button></div>`;
  else if (!c.posts.length && !c.loading) list.innerHTML = `<div class="bg-white rounded-[24px] p-10 text-center"><span class="inline-flex w-14 h-14 rounded-full bg-[#F2F2F7] text-[#8E8E93] items-center justify-center">${icon('pencil', 'w-7 h-7')}</span><p class="text-[13px] text-[#8E8E93] mt-3">${esc(t('noPosts'))}</p></div>`;
  else list.innerHTML = c.posts.map(postCardHtml).join('');
  $('#postMore').innerHTML = c.loading
    ? `<div class="flex justify-center py-3"><span class="w-7 h-7 rounded-full border-[3px] border-[#E5E5EA] border-t-[#1B1F27] animate-spin"></span></div>`
    : !c.done && c.posts.length ? `<button data-c="more" class="w-full py-3.5 rounded-[18px] bg-white border border-black/[0.05] text-[14px] font-semibold flex items-center justify-center gap-1">${esc(t('more'))}${icon('chevD', 'w-4 h-4')}</button>` : '';
}
$('#communityView').addEventListener('click', (e) => {
  const b = e.target.closest('[data-c]');
  if (!b) return;
  const a = b.dataset.c;
  if (a === 'cat') { S.community.cat = b.dataset.k; renderCommunity(true); }
  else if (a === 'more') loadPosts();
  else if (a === 'retry') renderCommunity(true);
  else if (a === 'open') openPost(b.dataset.id);
});

/* ---------- 글쓰기 ---------- */
S.compose = { cat: 'free', star: '' };
$('#btnWrite').onclick = () => {
  if (needLogin()) return;
  const c = S.compose;
  c.cat = POST_CATS.includes(S.community.cat) ? S.community.cat : 'free';
  c.star = S.community.cat === 'mystar' && mainStar() ? mainStar().name : '';
  $('#postTitle').value = ''; $('#postBody').value = '';
  $('#postAnon').checked = true;
  renderCompose();
  showScreen('postModal');
};
function renderCompose() {
  const c = S.compose;
  $('#postCats').innerHTML = POST_CATS.map((k) => `<button data-pc="${k}" class="px-4 py-2 rounded-full text-[13px] font-semibold border ${c.cat === k ? 'text-white' : 'bg-white text-[#3A3A3C] border-black/[0.08]'}" style="${c.cat === k ? `background:${CAT_COLOR[k]};border-color:${CAT_COLOR[k]}` : ''}">${esc(t('cat_' + k))}</button>`).join('');
  $('#postStars').innerHTML = ['', ...S.stars.map((s) => s.name)].map((n) => `<button data-ps="${esc(n)}" class="px-3 py-1.5 rounded-full text-[13px] border flex items-center gap-1 ${c.star === n ? 'bg-[#FFF0F6] border-[#E11D74] text-[#E11D74] font-bold' : 'bg-white border-black/[0.08] text-[#6E6E73]'}">${n ? icon('heart', 'w-3.5 h-3.5') : ''}${esc(n || t('noStarTag'))}</button>`).join('');
}
$('#postModal').addEventListener('click', (e) => {
  const pc = e.target.closest('[data-pc]');
  if (pc) { S.compose.cat = pc.dataset.pc; renderCompose(); return; }
  const ps = e.target.closest('[data-ps]');
  if (ps) { S.compose.star = ps.dataset.ps; renderCompose(); }
});
$('#btnPostSubmit').onclick = async () => {
  const title = $('#postTitle').value.trim();
  const body = $('#postBody').value.trim();
  if (!title) { toast(t('err_title_required'), 'alert'); return; }
  if (!body) { toast(t('err_body_required'), 'alert'); return; }
  const btn = $('#btnPostSubmit');
  btn.disabled = true;
  try {
    const id = must(await sb.rpc('korrier_create_post', { p_category: S.compose.cat, p_star: S.compose.star || null, p_title: title, p_body: body, p_anonymous: $('#postAnon').checked }));
    hideScreen('postModal');
    toast(t('toast_posted'), 'check');
    S.community.cat = POST_CATS.includes(S.community.cat) && S.community.cat !== S.compose.cat ? S.compose.cat : S.community.cat;
    if (S.tab === 'community') await renderCommunity(true);
    openPost(id);
  } catch (e) { toast(/too_many/.test(e.message) ? t('err_too_many_requests') : errText(e), 'alert'); }
  finally { btn.disabled = false; }
};

/* ---------- 글 보기 (하단 시트 재사용) ---------- */
S.postOpen = null;
async function openPost(id) {
  closeDetail();
  S.postOpen = { id, post: null, comments: [], tr: null, showTr: false };
  $('#detailBody').innerHTML = `<div class="flex justify-center py-16"><span class="w-8 h-8 rounded-full border-[3px] border-[#E5E5EA] border-t-[#1B1F27] animate-spin"></span></div>`;
  $('#sheetBackdrop').classList.remove('hidden');
  const sh = $('#detailSheet');
  sh.classList.remove('hidden'); sh.classList.add('flex', 'sheet-enter');
  try {
    const [p, cm] = await Promise.all([sb.rpc('korrier_open_post', { p_id: id }).then(must), sb.rpc('korrier_list_comments', { p_post: id }).then(must)]);
    if (!S.postOpen || S.postOpen.id !== id) return;
    if (!p || !p[0]) throw mkErr('not_found');
    S.postOpen.post = p[0];
    S.postOpen.comments = cm;
    const local = S.community.posts.find((x) => x.id === id);
    if (local) { local.view_count = p[0].view_count; local.like_count = p[0].like_count; local.comment_count = p[0].comment_count; }
    renderPost();
  } catch (e) {
    $('#detailBody').innerHTML = `<p class="text-center text-[13px] text-[#8E8E93] py-12">${esc(errText(e))}</p>`;
  }
}
function closePost() { S.postOpen = null; closeDetail(); if (S.tab === 'community') drawPosts(); }
$('#sheetBackdrop').onclick = () => (S.postOpen ? closePost() : closeDetail());
$('#sheetHandle').onclick = () => (S.postOpen ? closePost() : closeDetail());

function renderPost() {
  const o = S.postOpen;
  if (!o || !o.post) return;
  const p = o.post;
  const col = CAT_COLOR[p.category] || '#2563EB';
  const title = o.showTr && o.tr ? o.tr[0] : p.title;
  const body = o.showTr && o.tr ? o.tr[1] : p.body;
  const canTr = S.config && S.config.features.translate;
  let anonN = 0;
  const anonMap = {};
  const who = (c) => {
    if (c.is_writer) return `<span class="text-[#2563EB]">${esc(t('writer'))}</span>`;
    if (!c.anonymous) return esc(c.author);
    const k = c.is_mine ? 'me' : c.id;
    if (!anonMap[k]) anonMap[k] = ++anonN;
    return `${esc(t('anonymous'))}${anonMap[k]}`;
  };
  $('#detailBody').innerHTML = `
    <div class="flex items-center gap-1.5 text-[11px] font-bold">
      <span class="px-2 py-0.5 rounded-full" style="background:${col}14;color:${col}">${esc(t('cat_' + p.category))}</span>
      ${p.star_name ? `<span class="px-2 py-0.5 rounded-full bg-[#FFF0F6] text-[#E11D74] flex items-center gap-0.5">${icon('heart', 'w-3 h-3')}${esc(p.star_name)}</span>` : ''}
      ${p.is_mine ? `<button data-p="delete" class="ml-auto px-2.5 py-1 rounded-full bg-rose-50 text-rose-600 flex items-center gap-1">${icon('trash', 'w-3.5 h-3.5')}${esc(t('delete'))}</button>` : ''}
    </div>
    <h3 class="text-[22px] font-bold leading-snug">${esc(title)}</h3>
    <div class="flex items-center gap-2 text-[12px] text-[#8E8E93]">
      <span class="w-7 h-7 rounded-full bg-[#F2F2F7] flex items-center justify-center">${icon('user', 'w-4 h-4')}</span>
      <span class="font-semibold text-[#3A3A3C]">${esc(p.anonymous ? t('anonymous') : p.author)}</span>
      <span>${esc(timeAgo(p.created_at))}</span>
      <span class="ml-auto flex items-center gap-1">${icon('eye', 'w-3.5 h-3.5')}${fmtNum(p.view_count)}</span>
    </div>
    <p class="text-[15.5px] leading-[1.75] whitespace-pre-wrap break-words">${esc(body)}</p>
    <div class="flex items-center gap-2">
      <button data-p="like" class="px-4 py-2.5 rounded-full border text-[14px] font-bold flex items-center gap-1.5 ${p.liked ? 'bg-[#FFF0F6] border-[#E11D74] text-[#E11D74]' : 'bg-white border-black/[0.08] text-[#3A3A3C]'}">${icon('heart', 'w-4 h-4', p.liked ? 2.6 : 1.8)}${fmtNum(p.like_count)}</button>
      ${canTr ? `<button data-p="tr" class="px-4 py-2.5 rounded-full bg-[#F2F2F7] text-[13px] font-semibold flex items-center gap-1.5">${icon('globe', 'w-4 h-4')}${esc(o.showTr ? t('showOriginal') : t('showTranslation'))}</button>` : ''}
    </div>
    <div class="h-px bg-black/[0.06]"></div>
    <p class="text-[14px] font-bold">${esc(t('commentsN', { n: fmtNum(o.comments.length) }))}</p>
    <div class="space-y-3">${o.comments.length ? o.comments.map((c) => `
      <div class="flex gap-2.5" data-cid="${c.id}">
        <span class="w-8 h-8 rounded-full bg-[#F2F2F7] text-[#8E8E93] flex items-center justify-center shrink-0">${icon('user', 'w-4 h-4')}</span>
        <div class="min-w-0 flex-1">
          <p class="text-[12px] font-bold flex items-center gap-2">${who(c)}<span class="font-normal text-[#AEAEB2]">${esc(timeAgo(c.created_at))}</span>${c.is_mine ? `<button data-p="cdel" class="ml-auto text-[#AEAEB2]">${icon('trash', 'w-3.5 h-3.5')}</button>` : ''}</p>
          <p class="text-[14px] leading-relaxed mt-0.5 whitespace-pre-wrap break-words">${esc(c.body)}</p>
        </div></div>`).join('') : `<p class="text-[13px] text-[#AEAEB2] text-center py-3">${esc(t('noComments'))}</p>`}</div>
    <form id="commentForm" class="sticky bottom-0 bg-white pt-2 flex items-end gap-2">
      <label class="shrink-0 flex flex-col items-center text-[10px] text-[#8E8E93] gap-0.5 pb-1"><input id="commentAnon" type="checkbox" checked class="w-4 h-4 accent-[#1E3A8A]">${esc(t('anonymous'))}</label>
      <textarea id="commentInput" rows="1" maxlength="500" class="flex-1 min-w-0 px-4 py-3 rounded-[18px] bg-[#F2F2F7] text-[14px] outline-none resize-none max-h-28" placeholder="${esc(t('commentPh'))}"></textarea>
      <button class="w-11 h-11 rounded-full bg-[#1E3A8A] text-white flex items-center justify-center shrink-0">${icon('send', 'w-5 h-5')}</button>
    </form>`;
  $('#commentForm').onsubmit = async (e) => {
    e.preventDefault();
    if (needLogin()) return;
    const txt = $('#commentInput').value.trim();
    if (!txt) return;
    try {
      must(await sb.rpc('korrier_add_comment', { p_post: p.id, p_body: txt, p_anonymous: $('#commentAnon').checked }));
      o.comments = must(await sb.rpc('korrier_list_comments', { p_post: p.id }));
      p.comment_count = o.comments.length;
      const local = S.community.posts.find((x) => x.id === p.id);
      if (local) local.comment_count = p.comment_count;
      renderPost();
      $('#detailBody').scrollTop = $('#detailBody').scrollHeight;
    } catch (err) { toast(/too_many/.test(err.message) ? t('err_too_many_requests') : errText(err), 'alert'); }
  };
  $('#commentInput').oninput = (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(112, e.target.scrollHeight) + 'px'; };
}
$('#detailBody').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-p]');
  const o = S.postOpen;
  if (!b || !o || !o.post) return;
  const p = o.post;
  const a = b.dataset.p;
  try {
    if (a === 'like') {
      if (needLogin()) return;
      const r = must(await sb.rpc('korrier_toggle_like', { p_post: p.id }))[0];
      p.liked = r.liked; p.like_count = r.like_count;
      const local = S.community.posts.find((x) => x.id === p.id);
      if (local) local.like_count = r.like_count;
      renderPost();
    } else if (a === 'tr') {
      if (o.showTr) { o.showTr = false; renderPost(); return; }
      if (needLogin()) return;
      if (!o.tr || o.trLang !== S.lang) {
        b.disabled = true; b.classList.add('opacity-60');
        const r = await fn('translate', { texts: [p.title, p.body], lang: S.lang, long: true });
        o.tr = r.texts; o.trLang = S.lang;
      }
      o.showTr = true; renderPost();
    } else if (a === 'delete') {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.lastChild.textContent = t('confirmAgain'); return; }
      must(await sb.rpc('korrier_delete_post', { p_id: p.id }));
      S.community.posts = S.community.posts.filter((x) => x.id !== p.id);
      toast(t('toast_deleted'), 'check');
      closePost();
    } else if (a === 'cdel') {
      const id = b.closest('[data-cid]').dataset.cid;
      must(await sb.rpc('korrier_delete_comment', { p_id: id }));
      o.comments = o.comments.filter((c) => c.id !== id);
      p.comment_count = o.comments.length;
      renderPost();
    }
  } catch (err) { toastErr(err); b.disabled = false; b.classList.remove('opacity-60'); }
});

/* ---------- 언어 변경 시 열린 글 다시 그리기 ---------- */
const _rerender = rerenderCurrent;
rerenderCurrent = function () { _rerender(); if (S.postOpen && S.postOpen.post) { S.postOpen.showTr = false; renderPost(); } renderUserChrome(); };

boot();
