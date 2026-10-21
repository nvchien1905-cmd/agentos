'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// ẢNH, VIDEO, TÀI LIỆU gửi qua Telegram. Bot tải về thư mục `inbox` trong thư mục làm việc của AI rồi đưa ĐƯỜNG DẪN vào câu lệnh:
//   - Ảnh/ảnh trong album: AI xem bằng công cụ đọc ảnh (Claude: Read; Codex: -i; Gemini: @tệp). DeepSeek (chỉ chữ) bị loại khỏi việc có ảnh.
//   - Video: trích tối đa 6 khung hình (ffmpeg) + nhận dạng lời nói trong video (faster-whisper trên máy) -> AI nào cũng "hiểu" được video.
//   - Tài liệu (PDF, Word, Excel...): lưu tệp, AI đọc bằng công cụ có sẵn (pdftotext, LibreOffice...).
// Telegram Bot API chỉ cho bot tải tệp tới 20 MB: lớn hơn thì báo rõ cách gửi qua OneDrive.
const MAX_BYTES = 20 * 1024 * 1024;
const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'application/pdf': 'pdf' };
const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i;
const VID_EXT = /\.(mp4|mov|webm|mkv|avi|m4v|3gp)$/i;
const sanitize = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 60) || 'tep';

// Danh sách tệp đính kèm của một tin nhắn: [{ id, kind: 'image'|'video'|'doc', name, size, mime }]
function listAttachments(msg) {
  const out = [];
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const best = msg.photo.slice().sort((a, b) => (b.file_size || b.width * b.height || 0) - (a.file_size || a.width * a.height || 0))[0];
    out.push({ id: best.file_id, kind: 'image', name: 'anh.jpg', size: best.file_size || 0, mime: 'image/jpeg' });
  }
  for (const key of ['video', 'video_note', 'animation']) {
    const v = msg[key];
    if (v && v.file_id) out.push({ id: v.file_id, kind: 'video', name: v.file_name || key + '.mp4', size: v.file_size || 0, mime: v.mime_type || 'video/mp4', duration: v.duration || 0 });
  }
  const d = msg.document;
  if (d && d.file_id) {
    const mime = d.mime_type || '';
    out.push({ id: d.file_id, kind: /^image\//.test(mime) ? 'image' : /^video\//.test(mime) ? 'video' : 'doc', name: d.file_name || 'tep', size: d.file_size || 0, mime });
  }
  return out;
}
const hasAttachment = (msg) => !!msg && listAttachments(msg).length > 0;

const defaultRun = (cmd, args, ms) => new Promise((resolve) => {
  cp.execFile(cmd, args, { timeout: ms || 120000, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out || ''), err: String(errOut || ''), missing: !!(err && err.code === 'ENOENT') }));
});

function createMedia(o) {
  const tg = o.tg, dir = o.dir, log = o.log || (() => {});
  const run = o.run || defaultRun;
  const voice = o.voice || null;
  const now = o.now || Date.now;
  const frames = o.maxFrames || 6;

  const stamp = () => { const d = new Date(now() + 7 * 3600 * 1000); const p = (n) => String(n).padStart(2, '0'); return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + '-' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()); };

  async function probe(file) {
    const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'default=nw=1', file], 30000);
    if (r.code !== 0) return null;
    const get = (k) => { const m = r.out.match(new RegExp(k + '=([0-9.]+)')); return m ? Number(m[1]) : 0; };
    return { duration: get('duration'), width: get('width'), height: get('height') };
  }

  // Video -> khung hình + lời nói. Mọi bước đều "mềm": thiếu ffmpeg hoặc lỗi thì vẫn đưa tệp gốc cho AI.
  async function describeVideo(file, base) {
    const info = { frames: [], transcript: '', duration: 0, size: '' };
    const p = await probe(file);
    if (!p) return info;
    info.duration = p.duration; info.size = p.width && p.height ? p.width + 'x' + p.height : '';
    const n = Math.min(frames, Math.max(2, Math.ceil((p.duration || 10) / 10)));
    const fdir = base + '-khung';
    fs.mkdirSync(fdir, { recursive: true });
    const every = Math.max(0.5, (p.duration || 10) / n);
    const f = await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', 'fps=1/' + every.toFixed(2) + ",scale='min(768,iw)':-2", '-frames:v', String(n), path.join(fdir, 'khung-%02d.jpg')], 180000);
    if (f.code === 0) info.frames = fs.readdirSync(fdir).filter((x) => /\.jpg$/.test(x)).sort().map((x) => path.join(fdir, x));
    if (voice && voice.transcribePath) {
      const wav = base + '-loi.wav';
      const a = await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-t', '600', wav], 180000);
      if (a.code === 0 && fs.existsSync(wav) && fs.statSync(wav).size > 4000) {
        const t = await voice.transcribePath(wav);
        if (t.ok) info.transcript = t.text.slice(0, 3000);
        fs.rm(wav, { force: true }, () => {});
      }
    }
    return info;
  }

  // Tải và mô tả các tệp của một hoặc nhiều tin nhắn (album). Trả { block, files, errors } — block là đoạn chữ gắn vào câu lệnh.
  async function prepare(msgs) {
    fs.mkdirSync(dir, { recursive: true });
    const lines = [], files = [], errors = [];
    let n = 0;
    for (const msg of msgs) {
      for (const a of listAttachments(msg)) {
        n++;
        if (a.size && a.size > MAX_BYTES) { errors.push('"' + a.name + '" nặng ' + Math.round(a.size / 1048576) + ' MB: Telegram chỉ cho bot tải tệp tới 20 MB. Gửi bản nhẹ hơn, hoặc bỏ tệp vào OneDrive rồi nhắn đường dẫn.'); continue; }
        const ext = (path.extname(a.name).slice(1) || EXT_BY_MIME[a.mime] || (a.kind === 'image' ? 'jpg' : a.kind === 'video' ? 'mp4' : 'bin')).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'bin';
        const base = path.join(dir, stamp() + '-' + msg.message_id + '-' + n);
        const dest = base + '.' + ext;
        try { await tg.downloadFile(a.id, dest); } catch (e) { errors.push('Không tải được "' + a.name + '": ' + e.message); continue; }
        files.push({ path: dest, kind: a.kind, name: a.name });
        if (a.kind === 'image' || IMG_EXT.test(dest)) lines.push('- Ảnh: ' + dest);
        else if (a.kind === 'video' || VID_EXT.test(dest)) {
          const v = await describeVideo(dest, base).catch((e) => { log('xử lý video lỗi: ' + e.message); return { frames: [], transcript: '', duration: 0, size: '' }; });
          let t = '- Video: ' + dest + (v.duration ? ' (dài ' + Math.round(v.duration) + ' giây' + (v.size ? ', ' + v.size : '') + ')' : '');
          if (v.frames.length) t += '\n  Khung hình trích đều theo thời gian (xem từng ảnh): ' + v.frames.join(', ');
          if (v.transcript) t += '\n  Lời nói trong video (máy tự nhận dạng, có thể sai): "' + v.transcript.replace(/\s+/g, ' ') + '"';
          else if (v.frames.length) t += '\n  (Không có lời nói hoặc không nhận dạng được.)';
          lines.push(t);
        } else lines.push('- Tài liệu "' + a.name + '": ' + dest);
      }
    }
    const block = lines.length ? '[Tệp đính kèm — đã lưu trên máy. Hãy xem ảnh/khung hình bằng công cụ đọc ảnh/tệp rồi làm theo yêu cầu]\n' + lines.join('\n') : '';
    return { block, files, errors };
  }

  return { prepare, listAttachments };
}

// Đường dẫn ảnh trong câu lệnh (để Codex nhận bằng -i, Gemini bằng @)
function imagePaths(text) {
  const out = [];
  const re = /(\/[^\s,"']+\/inbox\/[^\s,"']+\.(?:jpe?g|png|webp|gif|bmp))/gi;
  let m; while ((m = re.exec(String(text || '')))) if (!out.includes(m[1])) out.push(m[1]);
  return out.slice(0, 10);
}

module.exports = { createMedia, listAttachments, hasAttachment, imagePaths, MAX_BYTES };
