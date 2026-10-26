'use strict';
const fs = require('fs');
const path = require('path');

// Lệnh /duan trên Telegram + tiện ích gắn việc vào dự án (bot.js gọi). Tách riêng để dễ thử.
const na = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').trim();
const ENGINES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', deepseekapi: 'DeepSeek (API)' };

function createProjectCommands(o) {
  const { db, projects, isAdmin, memory } = o;
  const engines = o.engines || (() => Object.keys(ENGINES));

  // Dự án đang chọn của cuộc trò chuyện này (chỉ khi người đó được dùng)
  function current(chatId, uid) {
    const p = projects.active(chatId);
    return p && projects.canUse(uid == null ? chatId : uid, p, isAdmin) ? p : null;
  }
  const label = (p) => '📁 ' + p.name;
  const usable = (uid) => projects.list().filter((p) => projects.canUse(uid, p, isAdmin));

  function help(uid) {
    const adm = isAdmin(uid);
    return '📁 DỰ ÁN — mỗi dự án có thư mục tệp, chỉ dẫn, sổ tay và lịch sử riêng; AI nào (Claude/Codex/Gemini/DeepSeek) cũng dùng chung dữ liệu dự án, hết hạn mức thì tự chuyển AI khác.\n' +
      '/duan — danh sách · /duan <tên> — vào dự án · /duan thoat — về chế độ chung\n' +
      '#<tên-dự-án> <việc> — hỏi một lần trong dự án mà không đổi chỗ đang đứng\n' +
      '/duan chidan — xem chỉ dẫn · /duan tep — xem tệp' +
      (adm ? '\n/duan moi <tên> — tạo dự án · /duan chidan <văn bản> (thay) hoặc /duan chidan them <dòng> · /duan ai <claude|codex|gemini|deepseekapi|tudong>\n' +
        '/duan luutru [tên] · /duan hienlai <tên> · /duan xoa <tên> co (vào thùng rác 30 ngày) · /duan giao <ID Telegram> · /duan bogiao <ID>' : '');
  }

  function listText(chatId, uid) {
    const cur = current(chatId, uid), list = usable(uid);
    if (!list.length) return 'Chưa có dự án nào' + (isAdmin(uid) ? '. Tạo bằng /duan moi <tên>, ví dụ /duan moi Kế toán 2026.' : ' dành cho bạn. Nhờ chủ máy gán.') + '\n\n' + help(uid);
    return '📁 Dự án' + (cur ? ' (đang ở: ' + cur.name + ')' : ' (đang ở chế độ chung)') + ':\n' +
      list.map((p) => (cur && cur.id === p.id ? '▶️ ' : '• ') + p.name + (p.engine ? ' [' + (ENGINES[p.engine] || p.engine) + ']' : '') + ' — ' + projects.usage(p.id).docs + ' tài liệu, ' + projects.usage(p.id).results + ' kết quả').join('\n') +
      '\n\nVào dự án: /duan <tên> · Thoát: /duan thoat · Hướng dẫn: /duan tro-giup';
  }

  // Trả chuỗi trả lời. arg = phần sau "/duan"
  async function run(chatId, uid, arg) {
    arg = String(arg || '').trim();
    const adm = isAdmin(uid);
    if (!arg) return listText(chatId, uid);
    const m = arg.match(/^(\S+)\s*([\s\S]*)$/), sub = na(m[1]), rest = (m[2] || '').trim();
    const need = () => (adm ? null : 'Lệnh này chỉ dành cho chủ máy.');
    const target = (name) => {
      const p = name ? projects.get(name) : current(chatId, uid);
      if (!p) return { err: name ? 'Không có dự án "' + name + '". Gõ /duan để xem danh sách.' : 'Bạn chưa vào dự án nào. Gõ /duan <tên> trước, hoặc ghi rõ tên dự án.' };
      return { p };
    };
    switch (sub) {
      case 'tro-giup': case 'trogiup': case 'help': return help(uid);
      case 'thoat': case 'ra': case 'chung': projects.setActive(chatId, null); return '↩️ Đã về chế độ chung (không còn trong dự án nào).';
      case 'moi': case 'tao': {
        const e = need(); if (e) return e;
        let p; try { p = projects.create(rest, uid); } catch (x) { return '⚠️ ' + x.message; }
        projects.setActive(chatId, p.id);
        return '✅ Đã tạo ' + label(p) + ' và đang ở trong dự án này.\nThư mục: ' + p.dir + '\nViết chỉ dẫn cho AI: /duan chidan <nội dung> (hoặc sửa tệp CHI-DAN.md trong thư mục dự án). Tệp/ảnh anh gửi vào đây sẽ tự lưu vào TAI-LIEU.';
      }
      case 'chidan': {
        const t = target(''); if (t.err) return t.err;
        if (!rest) { const x = projects.instructions(t.p.id); return label(t.p) + ' — chỉ dẫn:\n' + (x || '(chưa có. Đặt bằng /duan chidan <nội dung>)'); }
        const e = need(); if (e) return e;
        const add = na(rest.split(/\s+/)[0]) === 'them' && rest.split(/\s+/).length > 1;
        try {
          if (add) { const cur = projects.rawInstructions(t.p.id).replace(/\s+$/, ''); projects.setInstructions(t.p.id, cur + '\n- ' + rest.replace(/^\S+\s+/, '') + '\n'); }
          else projects.setInstructions(t.p.id, '# Chỉ dẫn dự án: ' + t.p.name + '\n\n' + rest + '\n');
        } catch (x) { return '⚠️ ' + x.message; }
        return '✅ Đã ' + (add ? 'thêm vào' : 'đặt') + ' chỉ dẫn của ' + label(t.p) + '. Mọi AI sẽ dùng chỉ dẫn này từ việc kế tiếp.';
      }
      case 'tep': case 'files': {
        const t = target(rest); if (t.err) return t.err;
        const sec = (d) => projects.files(t.p.id, d).slice(0, 15).map((f) => '  ' + (f.dir ? '📂 ' : '· ') + f.name).join('\n') || '  (trống)';
        return label(t.p) + '\nTAI-LIEU:\n' + sec('TAI-LIEU') + '\nKET-QUA:\n' + sec('KET-QUA') + '\nThư mục: ' + t.p.dir;
      }
      case 'ai': {
        const e = need(); if (e) return e;
        const t = target(''); if (t.err) return t.err;
        const k = na(rest);
        if (!k) return 'AI ưu tiên của ' + label(t.p) + ': ' + (t.p.engine ? (ENGINES[t.p.engine] || t.p.engine) : 'tự chọn (mặc định)') + '. Đặt: /duan ai <' + engines().join('|') + '|tudong>. Hết hạn mức thì vẫn tự chuyển AI khác.';
        if (['tudong', 'auto', 'mac-dinh'].includes(k)) { projects.setEngine(t.p.id, null); return '✅ ' + label(t.p) + ': tự chọn AI.'; }
        if (!engines().includes(k)) return '⚠️ AI "' + rest + '" chưa bật trên máy. Có: ' + engines().join(', ') + '.';
        projects.setEngine(t.p.id, k); return '✅ ' + label(t.p) + ' ưu tiên ' + ENGINES[k] + ' (hết hạn mức thì tự chuyển sang AI khác, dùng chung dữ liệu dự án).';
      }
      case 'luutru': {
        const e = need(); if (e) return e; const t = target(rest); if (t.err) return t.err;
        projects.archive(t.p.id, true); if (projects.active(chatId) === null) { /* active() đã tự bỏ */ }
        return '🗄️ Đã cất ' + label(t.p) + ' (không hiện trong danh sách; tệp vẫn giữ). Lấy lại: /duan hienlai ' + t.p.name;
      }
      case 'hienlai': {
        const e = need(); if (e) return e;
        const p = projects.list({ all: true }).find((x) => x.id === projects.slugify(rest) || x.name.toLowerCase() === rest.toLowerCase());
        if (!p) return 'Không thấy dự án "' + rest + '".'; projects.archive(p.id, false); return '✅ Đã hiện lại ' + label(p) + '.';
      }
      case 'xoa': {
        const e = need(); if (e) return e;
        const w = rest.split(/\s+/), conf = na(w[w.length - 1]) === 'co';
        const name = conf ? w.slice(0, -1).join(' ') : rest; const t = target(name); if (t.err) return t.err;
        if (!conf) return '⚠️ Xóa ' + label(t.p) + '? Cả thư mục sẽ chuyển vào thùng rác (giữ ' + projects.TRASH_DAYS + ' ngày rồi xóa hẳn). Gõ: /duan xoa ' + t.p.name + ' co';
        projects.remove(t.p.id); return '🗑️ Đã chuyển ' + label(t.p) + ' vào thùng rác (' + projects.TRASH_DAYS + ' ngày).';
      }
      case 'giao': case 'bogiao': {
        const e = need(); if (e) return e;
        const id = (rest.match(/\d{3,}/) || [])[0]; if (!id) return 'Cách dùng: /duan ' + sub + ' <ID Telegram> (người đó gõ /id để biết ID).';
        const t = target(rest.replace(id, '').trim()); if (t.err) return t.err;
        const set = new Set(t.p.users); if (sub === 'giao') set.add(id); else set.delete(id);
        projects.setUsers(t.p.id, [...set]);
        return sub === 'giao' ? '✅ ' + id + ' được dùng ' + label(t.p) + '. Họ gõ /duan ' + t.p.name + ' để vào (việc của họ vẫn ở chế độ bảo vệ).' : '✅ Đã gỡ ' + id + ' khỏi ' + label(t.p) + '.';
      }
      default: {
        let p = projects.get(arg);
        if (p && p.archived) p = null;
        if (!p) { const arch = projects.list({ all: true }).find((x) => x.archived && (x.id === projects.slugify(arg) || x.name.toLowerCase() === arg.toLowerCase())); return arch ? '🗄️ "' + arch.name + '" đang được cất. Chủ máy gõ /duan hienlai ' + arch.name + ' để dùng lại.' : 'Không có dự án "' + arg + '". Gõ /duan để xem danh sách.'; }
        if (!projects.canUse(uid, p, isAdmin)) return 'Bạn chưa được gán dự án này. Nhờ chủ máy gõ /duan giao ' + uid + '.';
        projects.setActive(chatId, p.id);
        const ins = projects.instructions(p.id);
        return '📁 Đã vào dự án "' + p.name + '". Việc anh nhắn từ giờ nằm trong dự án này (thư mục, chỉ dẫn, sổ tay, lịch sử riêng).' + (p.engine ? '\nAI ưu tiên: ' + (ENGINES[p.engine] || p.engine) + '.' : '') + (ins ? '' : '\nChưa có chỉ dẫn: /duan chidan <nội dung>.') + '\nThoát: /duan thoat.';
      }
    }
  }

  // Tệp gửi lúc đang ở dự án: chép vào TAI-LIEU và đổi đường dẫn trong câu lệnh sang bản trong dự án
  function adoptFiles(chatId, uid, prepared) {
    const p = current(chatId, uid); if (!p || !prepared || !prepared.files || !prepared.files.length) return prepared;
    let block = prepared.block;
    try {
      projects.ensureDirs(p);
      const dest = path.join(p.dir, 'TAI-LIEU');
      for (const f of prepared.files) {
        const to = path.join(dest, path.basename(f.path));
        try { fs.copyFileSync(f.path, to); block = block.split(f.path).join(to); } catch (e) { /* giữ đường dẫn cũ */ }
      }
    } catch (e) { /* bỏ qua: vẫn dùng bản trong hộp thư nhận */ }
    return Object.assign({}, prepared, { block: block + '\n[Tệp đã được lưu vào TAI-LIEU của dự án "' + p.name + '"]' });
  }

  return { run, current, help, listText, adoptFiles, na };
}

module.exports = { createProjectCommands };
