'use strict';
const fs = require('fs');
const path = require('path');

// BÀI HỌC CHỦ MÁY DẠY BOT (bảng điều khiển bot → nút "Dạy bot"): một tệp lessons.json trong thư mục dữ liệu của chính bot
// ({lessons:[{id, text, at, fromJob}]}). Trang Cài đặt (root) ghi, bot chỉ ĐỌC; mỗi việc mới đọc lại tệp nên bài học có hiệu lực ngay từ lệnh kế tiếp.
// Bài học là lời dặn của CHỦ MÁY nên được đưa vào đầu lời nhắc như hướng dẫn; tối đa 30 bài, mỗi bài ≤ 600 ký tự.
const MAX_LESSONS = 30, MAX_TEXT = 600;

function createLessons(o) {
  const file = o.file, log = o.log || (() => {});
  let cache = { m: -1, list: [] };
  function list() {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs === cache.m) return cache.list;
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const l = (Array.isArray(j.lessons) ? j.lessons : []).filter((x) => x && typeof x.text === 'string' && x.text.trim()).slice(-MAX_LESSONS);
      cache = { m: st.mtimeMs, list: l };
      return l;
    } catch (e) { return []; }
  }
  return {
    list,
    text() {
      const l = list(); if (!l.length) return '';
      return '[Chủ máy đã dạy bạn các điều sau, hãy làm theo cho mọi việc về sau]\n' + l.map((x, i) => (i + 1) + '. ' + x.text.trim().slice(0, MAX_TEXT)).join('\n') + '\n[Hết phần chủ máy dạy]';
    },
  };
}

module.exports = { createLessons, MAX_LESSONS, MAX_TEXT };
