'use strict';
const { noAccent } = require('./kiotviet');

// NHẮN TIN BÌNH THƯỜNG, BOT TỰ LÀM việc trên màn hình máy (chủ máy không phải gõ lệnh):
//   "em mở Chrome cho anh đăng nhập" / "mở facebook anh đăng nhập" / "mở ra anh đăng nhập"  → mở trình duyệt CỦA BOT trên màn hình máy (hồ sơ riêng của bot) + chụp màn hình gửi lại
//   "xong" / "anh đăng nhập xong rồi" / "đã đăng nhập"                                       → đóng trình duyệt đó và LÀM TIẾP việc đang dở
//   "mở zalo" / "mở chrome" / "đóng chrome"                                                  → mở/đóng ứng dụng
//   "chụp màn hình" / "cho anh xem màn hình"                                                 → gửi ảnh màn hình
// Chỉ nhận câu NGẮN, đúng dạng ra lệnh; câu dài hay câu hỏi đi tiếp cho AI. Chỉ chủ máy. Không đụng tới việc nguy hiểm (khóa/tắt/khởi động lại máy vẫn phải gõ lệnh).
const MAX_LEN = 90;
const norm = (s) => noAccent(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const VERB_OPEN = /^(?:\w+ ){0,3}(?:mo|bat|khoi dong|chay|mo lai|mo giup) /;
const APPS = [[/\bzalo\b/, 'zalo'], [/\brustdesk\b/, 'rustdesk'], [/\bdeepseek\b/, 'deepseek'], [/\bchatgpt\b/, 'chatgpt'], [/\bclaude web\b/, 'claudeweb']];

// Trả null (không phải việc này) hoặc { kind: 'open'|'close'|'screen'|'done', app?, strong? }
function intent(raw) {
  const t = norm(raw);
  if (!t || t.length > MAX_LEN || /\?$/.test(String(raw).trim())) return null;
  // xong đăng nhập (strong = nói rõ "đăng nhập": làm ngay cả khi bot chưa mở trình duyệt)
  if (/^(?:em |anh )?(?:da |vua )?dang nhap (?:xong|roi)(?: roi)?(?: nhe| nha| em| do)?$/.test(t) || /^anh (?:da |vua )?dang nhap$/.test(t) || /^(?:da |vua )?dang nhap$/.test(t)) return { kind: 'done', strong: true };
  if (/^(?:ok )?(?:xong|roi|xong roi|da xong|ok xong|ok roi)(?: anh| em| nhe| nha| do)?$/.test(t) || /^(?:em )?(?:lam|tiep tuc|lam tiep)(?: tiep| di| nhe| nha)*$/.test(t) && /tiep/.test(t)) return { kind: 'done', strong: false };
  if (/^(?:\w+ ){0,3}(?:chup|xem|cho xem|gui|cho anh xem|cho a xem) (?:lai )?man hinh(?: may)?(?: di| nhe| nha| em| cho anh)*$/.test(t) || /^man hinh (?:may )?(?:dang |the nao|ra sao)/.test(t)) return { kind: 'screen' };
  if (/\b(?:roi|sau do|va|lay|doc|kiem tra|gui|tra cuu)\b/.test(t)) return null;      // câu có việc đi kèm ("mở chrome rồi vào kiotviet lấy doanh số...") là việc cho AI
  const cl = /^(?:\w+ ){0,3}dong (?:lai )?(?:cua so |ung dung )?(chrome|trinh duyet|webbot|zalo|rustdesk|deepseek|chatgpt|facebook)(?: cua bot| cua em)?(?: di| nhe| nha| giup| luon)?$/.exec(t);
  if (cl) { const w = cl[1]; return { kind: 'close', app: /^(trinh duyet|webbot|facebook)$/.test(w) ? 'webbot' : w }; }
  if (VERB_OPEN.test(t + ' ')) {
    for (const [re, app] of APPS) if (re.test(t)) return { kind: 'open', app };
    const login = /\bdang nhap\b/.test(t), browser = /\b(chrome|trinh duyet|web|webbot|facebook|fb|messenger|kiotviet)\b/.test(t);
    if (login && (browser || /^(?:\w+ ){0,3}mo (?:ra |len |giup |cho )?(?:anh |a )?dang nhap/.test(t))) return { kind: 'open', app: 'webbot' };
    if (browser && /\b(facebook|fb|messenger)\b/.test(t)) return { kind: 'open', app: 'webbot' };
    if (/\b(chrome|trinh duyet)\b/.test(t)) return { kind: 'open', app: 'chrome' };
  }
  return null;
}

const CONTINUE_PROMPT = 'Chủ máy báo ĐÃ ĐĂNG NHẬP xong trên trình duyệt của bạn (hồ sơ trình duyệt riêng của bot này; trình duyệt đã được đóng lại). Hãy kiểm tra xem đã vào được trang cần dùng chưa rồi TIẾP TỤC việc đang làm dở trước đó trong cuộc trò chuyện này, làm hết việc và báo kết quả. Vẫn KHÔNG tự nhập mật khẩu.';

// o: { quick, isAdmin, submit(chatId, prompt), audit(summary), sleep(ms), now() }
function createNaturalDesk(o) {
  const quick = o.quick, wait = new Map();
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now || Date.now;
  const WAIT_MS = 3 * 3600 * 1000;
  const waiting = (chatId) => { const w = wait.get(String(chatId)); return !!(w && now() - w < WAIT_MS); };

  // Trả null nếu không phải việc này; còn lại trả Promise<string|{text,files}>
  function tryHandle(chatId, uid, text) {
    if (!quick || !o.isAdmin(uid)) return null;
    const it = intent(text); if (!it) return null;
    const ctx = { chatId, uid };
    const audit = (what) => { try { o.audit && o.audit(what, text); } catch (e) { /* nhật ký lỗi không chặn việc */ } };
    if (it.kind === 'done') {
      if (!it.strong && !waiting(chatId)) return null;                // "xong" trơn chỉ hiểu là xong đăng nhập khi bot đang chờ chủ máy đăng nhập
      wait.delete(String(chatId)); audit('đăng nhập xong → đóng trình duyệt, làm tiếp');
      return (async () => { try { await quick.run('dong', 'webbot', ctx); } catch (e) { /* đã đóng */ } return o.submit(chatId, CONTINUE_PROMPT) || '👍 Em đóng trình duyệt và làm tiếp ngay.'; })();
    }
    if (it.kind === 'screen') { audit('chụp màn hình'); return quick.run('manhinh', '', ctx); }
    if (it.kind === 'close') {
      audit('đóng ' + it.app); if (it.app === 'webbot') wait.delete(String(chatId));
      return quick.run('dong', it.app, ctx);
    }
    audit('mở ' + it.app);
    return (async () => {
      const r = await quick.run('mo', it.app, ctx);
      if (!/^✅/.test(typeof r === 'string' ? r : (r && r.text) || '')) return r;                 // lỗi (màn hình khóa, không có ai đăng nhập...): báo nguyên văn
      if (it.app === 'webbot') wait.set(String(chatId), now());
      await sleep(3500);
      let shot = null; try { shot = await quick.run('manhinh', '', ctx); } catch (e) { shot = null; }
      const msg = it.app === 'webbot'
        ? '✅ Em đã mở trình duyệt của em trên màn hình máy (hồ sơ riêng của bot này). Anh đăng nhập trang cần dùng; xong anh chỉ cần nhắn "xong", em đóng lại và làm tiếp. (Em không bao giờ tự nhập mật khẩu.)'
        : '✅ Em đã mở ' + it.app + ' trên màn hình máy.';
      return shot && typeof shot === 'object' && shot.files ? { text: msg, files: shot.files } : msg;
    })();
  }
  return { tryHandle, waiting, intent, CONTINUE_PROMPT };
}

module.exports = { intent, createNaturalDesk, CONTINUE_PROMPT };
