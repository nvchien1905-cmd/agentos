'use strict';
// Giả lập lệnh đăng nhập của hãng. Tham số: <kiểu> ...
//   claude-token : in link (có mã màu ANSI), chờ người dùng dán mã, rồi in token  (giống `claude setup-token`)
//   codex-device : in link + mã dùng một lần, chờ rồi thoát 0                      (giống `codex login --device-auth`)
//   fail         : thoát mã 3
const kind = process.argv[2];
const ESC = '\u001b';
if (kind === 'claude-token') {
  process.stdout.write(ESC + '[1mVisit this URL to sign in:' + ESC + '[0m\r\nhttps://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz\r\nPaste code here if prompted > ');
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    if (buf.includes('\n')) {
      const code = buf.split('\n')[0].trim();
      if (code === 'MA-DUNG') process.stdout.write('\r\nLogin successful. Your OAuth token (valid 1 year):\r\n' + ESC + '[32msk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWx_yz-0123456789' + ESC + '[0m\r\n');
      else process.stdout.write('\r\nInvalid code\r\n');
      setTimeout(() => process.exit(code === 'MA-DUNG' ? 0 : 1), 50);
    }
  });
} else if (kind === 'codex-device') {
  process.stdout.write('To sign in, open https://auth.openai.com/codex/device and enter code:\n\n    ABCD-1234\n\nWaiting for confirmation...\n');
  setTimeout(() => process.exit(0), 300);
} else if (kind === 'long') {
  process.stdout.write('https://example.test/x\n');
  setTimeout(() => {}, 60000);
} else {
  process.stderr.write('lỗi giả lập\n');
  process.exit(3);
}
