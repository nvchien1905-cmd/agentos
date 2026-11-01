'use strict';
// Nạp bằng `node -r fake-graph.js ...` để thay fetch toàn cục bằng Graph API giả (chỉ dùng cho test công cụ dòng lệnh).
global.fetch = async (url) => {
  const u = new URL(url);
  if (u.pathname.endsWith('/me') && u.searchParams.get('access_token').startsWith('EAAGgood')) return { ok: true, status: 200, json: async () => ({ id: 'P9', name: 'Trang Thử' }) };
  return { ok: false, status: 400, json: async () => ({ error: { code: 190, message: 'Invalid OAuth access token.' } }) };
};
