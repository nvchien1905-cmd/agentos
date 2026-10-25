'use strict';

// Tiến trình trực tiếp của AI (như màn hình Claude Code): đọc luồng sự kiện của CLI, đổi thành các "bước" ngắn gọn cho tin trạng thái trên Telegram.
// Bước: { kind: 'tool' | 'text', name?, input?, text? }  ->  nhãn một dòng bằng describe().

// Đọc theo dòng từ các mảnh dữ liệu stdout
function lineReader(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { try { onLine(line); } catch (e) { /* bỏ qua dòng lỗi */ } } }
      if (buf.length > 4 * 1024 * 1024) buf = '';            // dòng quá khổng lồ (kết quả công cụ): bỏ, không giữ trong bộ nhớ
    },
    flush() { if (buf.trim()) { try { onLine(buf); } catch (e) { /* bỏ qua */ } } buf = ''; },
  };
}

// Che thứ giống khóa/token trong lệnh trước khi hiện lên Telegram
const SECRET = /(sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|\b\d{8,}:[A-Za-z0-9_-]{30,}|(password|passwd|token|secret|api[_-]?key)=\S+)/gi;
const clean = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').replace(SECRET, '***').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = (p) => { p = String(p || ''); const parts = p.split('/').filter(Boolean); return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : p; };

// Nhãn một dòng cho một bước
function describe(step) {
  if (!step) return '';
  if (step.kind === 'text') return '💬 ' + clean(step.text, 110);
  const n = String(step.name || ''), i = step.input || {};
  if (n === 'Bash') return '▶️ ' + clean(i.description || i.command, 90);
  if (n === 'Read') return '📖 Đọc ' + base(i.file_path || i.path);
  if (n === 'Write') return '📝 Tạo ' + base(i.file_path || i.path);
  if (n === 'Edit' || n === 'MultiEdit' || n === 'NotebookEdit') return '✏️ Sửa ' + base(i.file_path || i.path || i.notebook_path);
  if (n === 'Glob' || n === 'Grep') return '🔍 Tìm ' + clean(i.pattern || i.query, 70);
  if (n === 'WebFetch') return '🌐 Mở ' + clean(i.url, 80);
  if (n === 'WebSearch') return '🌐 Tìm web: ' + clean(i.query, 70);
  if (n === 'Task' || n === 'Agent') return '🤖 ' + clean(i.description || 'Giao việc phụ', 80);
  if (n === 'TodoWrite' || n === 'ExitPlanMode') return '';
  if (/^mcp__/.test(n)) return '🔌 ' + clean(n.replace(/^mcp__/, '').replace(/__/g, ' › '), 70);
  return '🔧 ' + clean(n, 40);
}

// Claude Code `--output-format stream-json`: {type:'assistant', message:{content:[{type:'text'|'tool_use',...}]}}
function fromClaude(ev, emit) {
  if (!ev || ev.type !== 'assistant' || !ev.message || !Array.isArray(ev.message.content)) return;
  for (const b of ev.message.content) {
    if (b && b.type === 'tool_use') emit({ kind: 'tool', name: b.name, input: b.input });
    else if (b && b.type === 'text' && String(b.text || '').trim()) emit({ kind: 'text', text: b.text });
  }
}

// Codex `exec --json`: item.started/completed với item.type = command_execution | file_change | web_search | mcp_tool_call | agent_message
function fromCodex(ev, emit) {
  if (!ev || !ev.item) return;
  const it = ev.item;
  if (ev.type === 'item.started') {
    if (it.type === 'command_execution') emit({ kind: 'tool', name: 'Bash', input: { command: it.command } });
    else if (it.type === 'web_search') emit({ kind: 'tool', name: 'WebSearch', input: { query: it.query } });
    else if (it.type === 'mcp_tool_call') emit({ kind: 'tool', name: 'mcp__' + (it.server || '') + '__' + (it.tool || '') });
  } else if (ev.type === 'item.completed') {
    if (it.type === 'file_change') emit({ kind: 'tool', name: 'Edit', input: { file_path: (it.changes && it.changes[0] && it.changes[0].path) || '' } });
    else if (it.type === 'agent_message' && String(it.text || '').trim()) emit({ kind: 'text', text: it.text });
  }
}

module.exports = { lineReader, describe, fromClaude, fromCodex, clean };
