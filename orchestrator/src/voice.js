'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { noAccent } = require('./kiotviet');

// TIN NHẮN THOẠI: tải file âm thanh Telegram -> nhận dạng giọng nói NGAY TRÊN MÁY (faster-whisper, không gửi âm thanh ra ngoài)
// -> coi như chủ máy vừa gõ chữ đó. Lần đầu dùng máy tự tải mô hình (~500MB) nên chờ vài phút.
// Giọng nói KHÔNG được dùng cho lệnh nguy hiểm (/tatmay, /khoimay, /toanquyen...): chỉ gõ chữ mới làm được.
const STT_BIN = '/usr/local/bin/agentos-stt';

// Nói đúng cụm quen thuộc thì chạy lệnh nhanh (khỏi qua AI). Không khớp -> để AI hiểu như tin chữ bình thường.
function spoken(text) {
  const a = noAccent(text);
  let m;
  if ((m = a.match(/^(?:bao cao |xem )?doanh so(?: (hom nay|hom qua|tuan(?: nay)?|thang(?: nay)?))?$/))) return '/doanhso' + (m[1] ? ' ' + m[1] : '');
  if ((m = a.match(/^(?:xem )?ton(?: kho)? (.{2,60})$/))) return '/ton ' + m[1];
  if (/^(chup |xem )?man hinh( may)?$/.test(a)) return '/manhinh';
  if (/^(xem )?cua so( dang mo)?$/.test(a)) return '/cuaso';
  if (/^khoa (man hinh|may)$/.test(a)) return '/khoamay';
  if (/^(bao cao|chay bao cao)( ngay)?$/.test(a)) return '/baocao';
  if (/^(trang thai|xem trang thai)$/.test(a)) return '/trangthai';
  return null;
}

function createVoice(o) {
  o = o || {};
  const tg = o.tg, log = o.log || (() => {});
  const bin = o.bin || STT_BIN;
  const tmpDir = o.tmpDir || os.tmpdir();
  const timeoutMs = o.timeoutMs || 15 * 60 * 1000;      // lần đầu còn phải tải mô hình
  const run = o.run || ((file) => new Promise((resolve) => {
    cp.execFile(bin, [file], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: Object.assign({}, process.env, { HF_HOME: process.env.STT_CACHE || '/var/lib/agentos/whisper' }) },
      (err, out, errOut) => resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, out: String(out || ''), err: String(errOut || '') }));
  }));

  async function transcribe(fileId) {
    const dest = path.join(tmpDir, 'voice-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.ogg');
    try {
      await tg.downloadFile(fileId, dest);
      const r = await run(dest);
      if (r.code !== 0) {
        log('nhận dạng giọng nói lỗi: ' + (r.err || r.out).slice(0, 300));
        const hint = /Cannot reach|ConnectionError|LocalEntryNotFound|offline|resolve|urlopen|HTTPSConnection/i.test(r.err) ? ' (lần đầu máy cần mạng để tải mô hình nhận dạng)' : '';
        return { ok: false, error: 'Không nghe được tin nhắn thoại' + hint + '.' };
      }
      const text = r.out.trim();
      if (!text) return { ok: false, error: 'Không nghe rõ nội dung, anh nói lại hoặc gõ chữ giúp em.' };
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: 'Không xử lý được tin nhắn thoại: ' + e.message };
    } finally { fs.rm(dest, { force: true }, () => {}); }
  }
  return { transcribe, spoken };
}

module.exports = { createVoice, spoken };
