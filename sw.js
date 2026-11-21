/* Korrier 서비스 워커 — 앱 화면은 오프라인에서도 열리고, 새 버전은 온라인일 때 바로 반영 */
const VERSION = 'korrier-v3.5.1';
const SHELL = ['./', './index.html', './app.js', './social.js', './i18n.js', './icons.js', './config.js', './logo.svg', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
const CDN = ['cdn.jsdelivr.net', 'unpkg.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 같은 출처(앱 파일): 네트워크 우선, 실패 시 캐시
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))));
    return;
  }
  // CDN 라이브러리: 캐시 우선 + 백그라운드 갱신 (Supabase/구글 지도/API 호출은 캐시하지 않음)
  if (CDN.includes(url.hostname)) {
    e.respondWith(caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
