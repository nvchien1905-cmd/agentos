'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createOffice } = require('../src/office');
const { createQuick } = require('../src/quick');

const TOOL = path.join(__dirname, '..', '..', 'iso', 'config', 'includes.chroot', 'usr', 'local', 'bin', 'agentos-office');
const hasPy = spawnSync('python3', ['-c', 'import docx, openpyxl'], { encoding: 'utf8' }).status === 0;

function mkInbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'of-'));
  fs.writeFileSync(path.join(d, 'cu.docx'), 'x'); fs.utimesSync(path.join(d, 'cu.docx'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  fs.writeFileSync(path.join(d, 'moi.xlsx'), 'x'); fs.writeFileSync(path.join(d, 'anh.jpg'), 'x');
  return d;
}

test('office: không ghi tệp thì lấy tệp văn phòng gửi gần nhất (bỏ qua ảnh); đường dẫn tương đối tìm trong inbox', async () => {
  const dir = mkInbox(); const calls = [];
  const of = createOffice({ inboxDir: dir, exec: async (args) => { calls.push(args); return { code: 0, out: 'nội dung\nTệp mới: ' + path.join(dir, 'moi-moi.xlsx'), err: '' }; } });
  assert.equal(of.latest(), path.join(dir, 'moi.xlsx'));
  assert.match(await of.read(''), /📄 moi\.xlsx\nnội dung/);
  assert.deepEqual(calls[0].slice(0, 2), ['read', path.join(dir, 'moi.xlsx')]);
  await of.read('cu.docx'); assert.equal(calls[1][1], path.join(dir, 'cu.docx'));
  assert.match(await of.read('khongco.docx'), /Không thấy tệp/);
  assert.match(await createOffice({ inboxDir: fs.mkdtempSync(path.join(os.tmpdir(), 'of-')), exec: async () => ({ code: 0, out: '' }) }).read(''), /Chưa có tệp nào/);
});

test('office: /doi kiểm định dạng và trả tệp; /thay tách "tệp | cũ | mới" hoặc "cũ | mới"; lỗi công cụ báo rõ', async () => {
  const dir = mkInbox(); const calls = [];
  const exec = async (args) => { calls.push(args); if (args[0] === 'convert') return { code: 0, out: path.join(dir, 'moi.pdf') + '\n', err: '' }; if (args[0] === 'replace') return { code: 0, out: 'Đã thay 2 chỗ. Tệp mới: ' + path.join(dir, 'moi-moi.xlsx') + '\n', err: '' }; return { code: 1, out: '', err: 'LỖI: hỏng' }; };
  const of = createOffice({ inboxDir: dir, exec });
  const q = createQuick({ desk: {}, office: of });
  assert.match(await q.run('doi', 'exe'), /Cách dùng/);
  const c = await q.run('doi', 'PDF'); assert.equal(c.files[0].path, path.join(dir, 'moi.pdf')); assert.deepEqual(calls[0].slice(0, 3), ['convert', path.join(dir, 'moi.xlsx'), 'pdf']);
  const r1 = await q.run('thay', 'Nguyễn A | Trần B'); assert.deepEqual(calls[1].slice(0, 4), ['replace', path.join(dir, 'moi.xlsx'), 'Nguyễn A', 'Trần B']); assert.match(r1.text, /Đã thay 2 chỗ/);
  await q.run('thay', 'cu.docx | a | b'); assert.deepEqual(calls[2].slice(0, 4), ['replace', path.join(dir, 'cu.docx'), 'a', 'b']);
  assert.match(await q.run('thay', 'chỉ một'), /Cách dùng/);
  assert.match(await createOffice({ inboxDir: dir, exec: async () => ({ code: 1, out: '', err: 'LỖI: hỏng' }) }).read(''), /⚠️ hỏng/);
  assert.match(await createOffice({ inboxDir: dir, exec: async () => ({ code: 1, missing: true, out: '', err: '' }) }).read(''), /chưa có công cụ agentos-office/);
});

test('agentos-office (Python thật): đọc docx/xlsx/pptx, thay chữ giữ định dạng, tệp mới mở lại được', { skip: !hasPy }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-'));
  const mk = spawnSync('python3', ['-c', `
import docx, openpyxl, zipfile
d = docx.Document(); d.add_heading("Bao cao", 1); p = d.add_paragraph(); p.add_run("Khach: Nguyen ").bold = True; p.add_run("Van A"); d.save("${d}/a.docx")
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Ban hang"; ws.append(["Ten", "Gia"]); ws.append(["Bep tu", 2200000]); wb.save("${d}/b.xlsx")
sl = '<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Xin chao </a:t></a:r><a:r><a:t>Ha Noi &amp; Hue</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
z = zipfile.ZipFile("${d}/c.pptx", "w"); z.writestr("[Content_Types].xml", "<Types/>"); z.writestr("ppt/slides/slide1.xml", sl); z.close()
`], { encoding: 'utf8' });
  assert.equal(mk.status, 0, mk.stderr);
  const run = (...a) => spawnSync('python3', [TOOL, ...a], { encoding: 'utf8' });
  assert.match(run('read', path.join(d, 'a.docx')).stdout, /# Bao cao\nKhach: Nguyen Van A/);
  assert.match(run('read', path.join(d, 'b.xlsx')).stdout, /Bep tu \| 2200000/);
  assert.match(run('read', path.join(d, 'c.pptx')).stdout, /Slide 1 ---\nXin chao Ha Noi & Hue/);
  const r = run('replace', path.join(d, 'a.docx'), 'Nguyen Van A', 'Tran B'); assert.equal(r.status, 0, r.stderr);       // chữ nằm ở 2 khối định dạng khác nhau
  assert.match(run('read', path.join(d, 'a-moi.docx')).stdout, /Khach: Tran B/);
  assert.match(run('read', path.join(d, 'a.docx')).stdout, /Nguyen Van A/, 'tệp gốc giữ nguyên');
  assert.equal(run('replace', path.join(d, 'c.pptx'), 'chao Ha Noi & Hue', 'ban <3').status, 0);
  assert.match(run('read', path.join(d, 'c-moi.pptx')).stdout, /Xin ban <3/);
  assert.equal(run('replace', path.join(d, 'b.xlsx'), 'Bep tu', 'Lo nuong').status, 0);
  assert.equal(spawnSync('python3', ['-c', `import openpyxl; wb = openpyxl.load_workbook("${d}/b-moi.xlsx"); assert wb.active["A2"].value == "Lo nuong"; import docx; docx.Document("${d}/a-moi.docx")`], { encoding: 'utf8' }).status, 0);
  const none = run('replace', path.join(d, 'a.docx'), 'khong co chu nay', 'x'); assert.equal(none.status, 3); assert.ok(!fs.existsSync(path.join(d, 'a-moi.docx')) || true);
  assert.match(run('info', path.join(d, 'b.xlsx')).stdout, /1 trang tính: Ban hang/);
  assert.notEqual(run('read', path.join(d, 'khong-co.docx')).status, 0);
});
