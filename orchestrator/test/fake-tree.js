'use strict';
// Tiến trình cha sinh một tiến trình cháu (ghi pid ra file) rồi cả hai chạy lâu. Dùng thử việc giết cả cây tiến trình.
// Tham số: <file-pid> [exit]   "exit": cha thoát ngay, để lại cháu mồ côi.
const { spawn } = require('child_process');
spawn(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(function () {}, 60000)", process.argv[2]], { stdio: 'ignore' });
if (process.argv[3] === 'exit') setTimeout(() => process.exit(0), 700);
else setTimeout(() => {}, 60000);
