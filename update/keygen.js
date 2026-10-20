#!/usr/bin/env node
'use strict';
// Tạo cặp khóa ký bản cập nhật (Ed25519). Khóa RIÊNG ghi vào đường dẫn bạn chỉ định (quyền chỉ chủ đọc), KHÔNG đưa lên GitHub, nên sao lưu nơi an toàn.
// Khóa CÔNG KHAI in ra và ghi vào update/public-key.pem (đưa vào ISO tại /etc/agentos/update-pubkey.pem).
//   node update/keygen.js C:\duong-dan\agentos-update-private.pem
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const out = process.argv[2];
if (!out) { console.error('Dùng: node update/keygen.js <khóa-riêng.pem>'); process.exit(2); }
if (fs.existsSync(out)) { console.error('Đã có ' + out + ' — không ghi đè (mất khóa cũ là máy khách không cập nhật được nữa).'); process.exit(1); }
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const pub = publicKey.export({ type: 'spki', format: 'pem' });
fs.writeFileSync(path.join(__dirname, 'public-key.pem'), pub);
console.log('Khóa riêng: ' + out + '\nKhóa công khai (đã ghi update/public-key.pem):\n' + pub);
