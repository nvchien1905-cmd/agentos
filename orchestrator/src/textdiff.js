'use strict';

// So sánh hai bản văn bản theo DÒNG (để màn hình "Việc AI" cho xem AI đã đổi gì trong tệp, như khung diff của Claude Code).
// Trả { rows: [{ t: 'ctx'|'add'|'del'|'skip', text, a, b }], add, del, truncated }: a/b là số dòng bản cũ/mới; 'skip' = N dòng không đổi được gộp lại (text = "N dòng không đổi").
// Giới hạn: tối đa ~4 triệu ô so sánh (n×m) — lớn hơn thì cắt phần giống nhau ở đầu/cuối rồi so phần giữa; vẫn quá lớn thì báo "truncated".
const MAX_CELLS = 4000000;
const CONTEXT = 3;

function splitLines(s) {
  const t = String(s == null ? '' : s).replace(/\r\n/g, '\n');
  if (t === '') return [];
  const a = t.split('\n');
  if (a[a.length - 1] === '') a.pop();
  return a;
}

function diffLines(oldText, newText, opts) {
  const ctx = (opts && opts.context) != null ? opts.context : CONTEXT;
  const A = splitLines(oldText), B = splitLines(newText);
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const a = A.slice(s, ea), b = B.slice(s, eb);
  let ops = [], truncated = false;                              // ops của PHẦN GIỮA: 'd' xóa, 'a' thêm, 'c' giữ
  if (!a.length || !b.length) { for (const x of a) ops.push(['d', x]); for (const x of b) ops.push(['a', x]); }
  else if (a.length * b.length > MAX_CELLS) { truncated = true; for (const x of a) ops.push(['d', x]); for (const x of b) ops.push(['a', x]); }
  else {
    const n = a.length, m = b.length, w = m + 1, L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push(['c', a[i]]); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) ops.push(['d', a[i++]]);
      else ops.push(['a', b[j++]]);
    }
    while (i < n) ops.push(['d', a[i++]]);
    while (j < m) ops.push(['a', b[j++]]);
  }
  const all = [];
  for (let k = 0; k < s; k++) all.push(['c', A[k]]);
  all.push(...ops);
  for (let k = ea; k < A.length; k++) all.push(['c', A[k]]);
  // đánh số dòng + gộp đoạn không đổi dài
  let la = 0, lb = 0, add = 0, del = 0;
  const num = all.map((o) => {
    if (o[0] === 'c') { la++; lb++; return { t: 'ctx', text: o[1], a: la, b: lb }; }
    if (o[0] === 'd') { la++; del++; return { t: 'del', text: o[1], a: la, b: null }; }
    lb++; add++; return { t: 'add', text: o[1], a: null, b: lb };
  });
  const rows = [];
  for (let k = 0; k < num.length;) {
    if (num[k].t !== 'ctx') { rows.push(num[k]); k++; continue; }
    let e = k; while (e < num.length && num[e].t === 'ctx') e++;
    const run = e - k, head = k === 0 ? 0 : ctx, tail = e === num.length ? 0 : ctx;
    if (run <= head + tail + 1) { for (let q = k; q < e; q++) rows.push(num[q]); }
    else {
      for (let q = k; q < k + head; q++) rows.push(num[q]);
      rows.push({ t: 'skip', text: (run - head - tail) + ' dòng không đổi', a: null, b: null });
      for (let q = e - tail; q < e; q++) rows.push(num[q]);
    }
    k = e;
  }
  return { rows, add, del, truncated };
}

// Có phải văn bản (không phải nhị phân)? Kiểm 8 KB đầu: không có byte 0 và gần như là UTF-8 hợp lệ.
function looksText(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

module.exports = { diffLines, splitLines, looksText, MAX_CELLS };
