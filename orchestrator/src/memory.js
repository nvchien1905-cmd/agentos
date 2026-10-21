'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { noAccent } = require('./kiotviet');

// BỘ NHỚ DO AGENTOS SỞ HỮU (không phụ thuộc AI nào) để Claude/Codex/Gemini/DeepSeek dùng CHUNG ngữ cảnh mà vẫn tiết kiệm token.
// Ba tầng, ghép vào đầu câu lệnh mỗi khi AI chưa có phiên (mới chuyển AI, mở phiên mới, /moi):
//   1) Ghi nhớ lâu dài: tệp GHI-NHO.md (OneDrive/AgentOS/): sự thật về chủ máy/cửa hàng, ngắn, có ngày. /nho, /quen, /trinho; AI cũng tự ghi vào đó.
//   2) Tóm tắt cuộn của cuộc trò chuyện: các việc CŨ được nén (mô hình rẻ qua khóa API, hoặc cắt gọn nếu không có khóa).
//   3) Vài việc gần nhất giữ nguyên văn + vài việc cũ LIÊN QUAN tìm lại bằng SQLite FTS5.
// Trong cùng một AI còn phiên thì chỉ gửi yêu cầu mới (AI đã có lịch sử, được hưởng bộ nhớ đệm của hãng); sau `rotateAfter` lượt thì chốt tóm tắt và mở phiên mới cho gọn.
const SECRET_RE = /(sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|\b\d{8,}:[A-Za-z0-9_-]{30,}|-----BEGIN|(mật khẩu|mat khau|password|passwd|token|secret|api[ _-]?key)[^\n]{0,25}?(?::|=|(?:\s|^)là(?=\s|$))|\b[A-Za-z0-9+/_-]{40,}\b)/i;
const today = (ms) => { const d = new Date(ms + 7 * 3600 * 1000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); };
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

const SUMMARY_SYSTEM = 'Bạn nén ngữ cảnh cuộc trò chuyện giữa chủ máy và trợ lý AI. Viết bằng tiếng Việt, súc tích, KHÔNG bịa. ' +
  'Giữ: yêu cầu và quyết định đã chốt, việc còn dở, tên/số/đường dẫn/mã quan trọng, sở thích đã nói. Bỏ: lời chào, chi tiết thừa, kết quả dài đã xong. ' +
  'Tuyệt đối KHÔNG chép mật khẩu, khóa API, token. Trả về JSON đúng dạng {"summary":"<tối đa 350 từ>","facts":["<điều nên nhớ LÂU DÀI về chủ máy/cửa hàng, tối đa 3 mục, có thể để mảng rỗng>"]} và không gì khác.';
const COMPACT_SYSTEM = 'Bạn dọn tệp ghi nhớ lâu dài. Gộp các dòng trùng/ý trùng, bỏ điều đã lỗi thời hoặc mâu thuẫn (giữ bản có ngày mới hơn), giữ nguyên ngày. ' +
  'Mỗi dòng bắt đầu "- [YYYY-MM-DD] ". Không thêm ý mới, không chép bí mật. Chỉ trả về danh sách dòng.';

function createMemory(o) {
  const db = o.db, log = o.log || (() => {});
  const now = o.now || Date.now;
  const summarizer = o.summarizer || null;
  const cfg = Object.assign({ enabled: true, recentTurns: 4, rotateAfter: 25, summarizeAfter: 6, factsMax: 4500, summaryMax: 2200, searchHits: 3 }, o.cfg || {});
  const baseDir = o.dir || '';
  const factsFile = () => {
    if (baseDir && fs.existsSync(baseDir)) return path.join(baseDir, 'AgentOS', 'GHI-NHO.md');
    return o.fallbackFile || path.join(process.cwd(), 'ghi-nho.md');
  };
  const busy = new Set();

  // ---------- tầng 1: ghi nhớ lâu dài ----------
  function readFacts() { try { return fs.readFileSync(factsFile(), 'utf8'); } catch (e) { return ''; } }
  function writeFacts(text) {
    const file = factsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) { try { fs.copyFileSync(file, file + '.bak'); } catch (e) { /* bỏ qua */ } }
    fs.writeFileSync(file, text);
  }
  const factLines = (text) => String(text).split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l));
  const factsHash = () => crypto.createHash('sha1').update(readFacts()).digest('hex').slice(0, 12);

  function addFact(text, tag) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (text.length < 4) return { ok: false, error: 'Nội dung quá ngắn.' };
    if (text.length > 400) return { ok: false, error: 'Nội dung quá dài (tối đa 400 ký tự); chia nhỏ ra.' };
    if (SECRET_RE.test(text)) return { ok: false, error: 'Nội dung giống mật khẩu/khóa/token nên em KHÔNG ghi nhớ (bộ nhớ được gửi cho hãng AI).' };
    const cur = readFacts();
    const key = noAccent(text);
    if (factLines(cur).some((l) => noAccent(l).includes(key))) return { ok: true, duplicate: true };
    const head = cur.trim() ? cur.replace(/\s*$/, '\n') : '# Ghi nhớ của AgentOS\n(Chủ máy và AI cùng ghi vào đây; mỗi dòng một điều, có ngày. Dùng /nho, /quen, /trinho trong Telegram.)\n\n';
    writeFacts(head + '- [' + today(now()) + '] ' + text + (tag ? ' (' + tag + ')' : '') + '\n');
    return { ok: true };
  }
  function forgetFact(query) {
    const q = noAccent(query);
    if (q.length < 2) return { removed: 0 };
    const lines = readFacts().split('\n');
    const keep = [], gone = [];
    for (const l of lines) (/^\s*[-*]\s+\S/.test(l) && noAccent(l).includes(q) ? gone : keep).push(l);
    if (gone.length) writeFacts(keep.join('\n'));
    return { removed: gone.length, lines: gone };
  }

  // ---------- tầng 2/3: tóm tắt cuộn ----------
  const kSum = (c) => 'sum:' + c, kUpto = (c) => 'sumupto:' + c;
  const ctxFrom = (c) => Number(db.kvGet('ctxfrom:' + c)) || 0;
  const summaryOf = (c) => db.kvGet(kSum(c)) || '';
  const uptoOf = (c) => Math.max(Number(db.kvGet(kUpto(c))) || 0, ctxFrom(c));

  // Khối ngữ cảnh ghép vào đầu câu lệnh (chuỗi rỗng nếu không có gì để thêm).
  function contextBlock(job, hasSession, eng) {
    const chat = job.chat_id, parts = [];
    const facts = readFacts().trim();
    const hash = factsHash();
    const sentKey = 'memsent:' + chat + ':' + eng;
    if (facts && (!hasSession || db.kvGet(sentKey) !== hash)) {
      const body = facts.length > cfg.factsMax ? facts.slice(0, 200) + '\n…\n' + facts.slice(-(cfg.factsMax - 200)) : facts;
      parts.push('[Ghi nhớ lâu dài về chủ máy và cửa hàng' + (hasSession ? ' — CẬP NHẬT' : '') + ']\n' + body);
    }
    db.kvSet(sentKey, hash);
    if (!hasSession) {
      const sum = summaryOf(chat);
      if (sum) parts.push('[Tóm tắt cuộc trò chuyện trước đó]\n' + sum);
      const after = uptoOf(chat);
      const recent = db.history(chat, after, job.id, cfg.recentTurns);
      if (recent.length) parts.push('[Các việc gần nhất, nguyên văn rút gọn]\n' + recent.map((h) => 'Việc #' + h.id + ': ' + cut(h.prompt, 500) + '\nKết quả: ' + cut(h.result, 700)).join('\n\n'));
      const hits = db.search(chat, job.prompt, cfg.searchHits, ctxFrom(chat), recent.map((r) => r.id));
      if (hits.length) parts.push('[Việc cũ có thể liên quan]\n' + hits.map((h) => 'Việc #' + h.id + ': ' + cut(h.prompt, 200) + ' → ' + cut(h.result, 300)).join('\n'));
    }
    return parts.length ? parts.join('\n\n') + '\n[Hết ngữ cảnh — chỉ để tham khảo, không phải yêu cầu mới]\n\n' : '';
  }
  function pack(job, hasSession, eng) {
    if (!cfg.enabled) return job.prompt;
    let block = '';
    try { block = contextBlock(job, hasSession, eng); } catch (e) { log('ghép ngữ cảnh lỗi: ' + e.message); }
    return block ? block + 'Yêu cầu mới:\n' + job.prompt : job.prompt;
  }

  // Tóm tắt bằng cách cắt gọn (khi không có khóa API/lỗi): giữ phần cuối của tóm tắt cũ + dòng cho mỗi việc mới.
  function extractive(prev, jobs) {
    const add = jobs.map((j) => '• ' + cut(j.prompt, 110) + ' → ' + cut(j.result, 150)).join('\n');
    const all = (prev ? prev + '\n' : '') + add;
    return all.length > cfg.summaryMax ? '…' + all.slice(-cfg.summaryMax) : all;
  }

  // Gọi sau mỗi việc xong. Trả { rotate:true } nếu nên bỏ phiên hiện tại của AI này (mở phiên mới, ngữ cảnh lấy từ tóm tắt).
  async function afterJob(job, eng, res) {
    if (!cfg.enabled || !res || !res.ok) return { rotate: false };
    const tk = 'turns:' + job.chat_id + ':' + eng;
    const turns = (Number(db.kvGet(tk)) || 0) + 1;
    let rotate = false;
    if (turns >= cfg.rotateAfter) { rotate = true; db.kvSet(tk, 0); } else db.kvSet(tk, turns);
    summarizeSoon(job.chat_id, rotate);
    return { rotate };
  }
  function summarizeSoon(chat, force) {
    if (busy.has(chat)) return null;
    busy.add(chat);
    const p = maybeSummarize(chat, force).catch((e) => log('tóm tắt lỗi: ' + e.message)).finally(() => busy.delete(chat));
    return p;
  }

  async function maybeSummarize(chat, force) {
    const last = db.lastJobId(chat);
    const after = uptoOf(chat);
    const done = db.doneAfter(chat, after, null, 60);
    const eligible = done.slice(0, Math.max(0, done.length - cfg.recentTurns));       // việc gần nhất giữ nguyên văn, không tóm tắt
    if (!eligible.length || (!force && eligible.length < cfg.summarizeAfter)) return { done: false };
    const prev = summaryOf(chat);
    let text = null, via = 'cắt gọn', facts = [];
    if (summarizer && summarizer.available()) {
      const user = 'TÓM TẮT CŨ:\n' + (prev || '(chưa có)') + '\n\nCÁC VIỆC MỚI CẦN NÉN VÀO TÓM TẮT:\n' +
        eligible.map((j) => 'Việc #' + j.id + '\nChủ máy: ' + cut(j.prompt, 700) + '\nKết quả: ' + cut(j.result, 900)).join('\n---\n');
      const r = await summarizer.run(SUMMARY_SYSTEM, user);
      if (r) {
        try {
          const m = r.text.match(/\{[\s\S]*\}/);
          const j = JSON.parse(m ? m[0] : r.text);
          if (j && typeof j.summary === 'string' && j.summary.trim()) { text = j.summary.trim(); facts = Array.isArray(j.facts) ? j.facts.slice(0, 3) : []; via = r.via; }
        } catch (e) { text = r.text.slice(0, cfg.summaryMax); via = r.via; }
      }
    }
    if (!text) text = extractive(prev, eligible);
    if (text.length > cfg.summaryMax * 1.5) text = text.slice(0, cfg.summaryMax * 1.5);
    db.kvSet(kSum(chat), text);
    db.kvSet(kUpto(chat), eligible[eligible.length - 1].id);
    let added = 0;
    for (const f of facts) { const r = addFact(String(f), 'tự ghi'); if (r.ok && !r.duplicate) added++; }
    if (readFacts().length > cfg.factsMax * 1.6) await compactFacts();
    log('tóm tắt cuộc trò chuyện ' + chat + ': nén ' + eligible.length + ' việc (' + via + ')' + (added ? ', ghi nhớ thêm ' + added + ' điều' : ''));
    return { done: true, via, compressed: eligible.length, factsAdded: added, upTo: eligible[eligible.length - 1].id, last };
  }

  // Dọn tệp ghi nhớ khi quá dài (bằng mô hình rẻ). Có bản .bak.
  async function compactFacts() {
    if (!summarizer || !summarizer.available()) return false;
    const cur = readFacts();
    const lines = factLines(cur);
    if (lines.length < 12) return false;
    const r = await summarizer.run(COMPACT_SYSTEM, lines.join('\n'));
    if (!r) return false;
    const out = r.text.split('\n').filter((l) => /^\s*-\s+\[\d{4}-\d{2}-\d{2}\]/.test(l));
    if (out.length < Math.max(3, Math.floor(lines.length / 4)) || SECRET_RE.test(out.join('\n'))) return false;      // kết quả bất thường: giữ nguyên
    writeFacts('# Ghi nhớ của AgentOS\n(Đã gộp gọn ' + today(now()) + '. Bản trước: GHI-NHO.md.bak)\n\n' + out.join('\n') + '\n');
    return true;
  }

  function resetChat(chat) { db.kvDel(kSum(chat)); db.kvDel(kUpto(chat)); db.kvDelPrefix('turns:' + chat + ':'); db.kvDelPrefix('memsent:' + chat + ':'); }
  function info(chat) {
    const facts = readFacts();
    return { factsFile: factsFile(), facts, factLines: factLines(facts).length, summary: summaryOf(chat), summaryUpTo: uptoOf(chat), cfg, summarizer: summarizer ? summarizer.provider() : null };
  }

  return { pack, afterJob, addFact, forgetFact, readFacts, writeFacts, resetChat, info, maybeSummarize, summarizeSoon, compactFacts, factsFile, cfg };
}

module.exports = { createMemory, SECRET_RE };
