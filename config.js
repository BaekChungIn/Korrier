/* =====================================================================
   Korrier 설정 — 이 파일만 내 값으로 바꾸면 됩니다.
   여기 들어가는 값은 모두 "공개돼도 되는" 키입니다. (GitHub에 올려도 OK)
   비밀 키(Gemini, 네이버, 카카오 REST)는 절대 여기 넣지 말고
   Supabase > Edge Functions > Secrets 에 넣으세요.
   ===================================================================== */
window.KORRIER_CONFIG = {
  // Supabase > Project Settings > API (짬타이거와 같은 프로젝트 값)
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-OR-PUBLISHABLE-KEY',

  // 배포한 Edge Function 이름
  FUNCTION_NAME: 'korrier-api',

  // Google Maps Platform > Maps JavaScript API 키 (HTTP 리퍼러를 내 GitHub Pages 주소로 제한)
  GOOGLE_MAPS_API_KEY: '',
  GOOGLE_MAP_ID: 'DEMO_MAP_ID',
};
