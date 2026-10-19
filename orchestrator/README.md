# Bộ điều phối AgentOS (GĐ 1)

Telegram -> hàng đợi SQLite -> `claude -p` -> trả kết quả về Telegram.

## Chạy thử
```bash
cd agentos/orchestrator
npm install
cp .env.example .env     # điền TELEGRAM_TOKEN (từ @BotFather)
npm start                # lần đầu để ALLOWED_USER_IDS trống sẽ báo lỗi: nhắn /id cho bot khi chạy bản thử rồi điền
npm test                 # 10 test, dùng claude giả
```
Lưu ý: đừng `npm install` trong thư mục OneDrive (hàng nghìn file) — chép thư mục sang ổ khác để chạy/kiểm thử.

Cách lấy ID: tạm đặt `ALLOWED_USER_IDS=0` để bot khởi động, nhắn `/id` cho bot (người lạ chỉ được hỏi ID), rồi thay bằng ID thật và chạy lại.

## Hành vi
- Chỉ trả lời người có ID trong `ALLOWED_USER_IDS`, chỉ chat riêng (không nhóm). Người lạ chỉ dùng được `/id`.
- Mỗi tin chữ = 1 việc. Chạy tuần tự, mỗi lần 1 việc. Mỗi chat giữ một phiên Claude (`--resume`) để hỏi tiếp; `/moi` bắt đầu phiên mới.
- Prompt đi qua stdin (không lộ trong danh sách tiến trình). Mặc định AI chỉ được dùng Read/Glob/Grep (`CLAUDE_ALLOWED_TOOLS`); công cụ khác bị từ chối ở chế độ không giao diện.
- Quá `JOB_TIMEOUT_SEC` -> dừng việc. `/huy` dừng việc đang chạy + hủy việc chờ.
- Khởi động lại giữa lúc đang chạy -> việc đó đánh dấu `interrupted`, báo người dùng, KHÔNG tự chạy lại (tránh làm lặp tác dụng phụ).

## GĐ 2: nhiều engine, chuyển khi hết hạn mức, chờ hồi
- `ENGINE_ORDER=claude,codex`: việc chạy ở engine đầu tiên đang sẵn sàng. Mỗi engine dùng CLI chính thức đã đăng nhập bằng tài khoản của chính người dùng; hệ thống không đọc hay lưu token.
- Engine báo chạm giới hạn -> đọc giờ hồi từ thông báo (`src/limits.js`; không đọc được thì nghỉ `LIMIT_COOLDOWN_MIN` phút) -> engine đó "nghỉ" -> việc đang làm được giao cho engine kế, báo người dùng.
- Engine còn lại cũng nghỉ -> việc sang trạng thái `waiting` (báo một lần), tự chạy lại khi engine hồi sớm nhất (kiểm tra mỗi 30 giây).
- `/claude <việc>` / `/codex <việc>` ép dùng một engine; engine đó hết hạn mức thì việc chờ, không tự chuyển.
- Mỗi chat giữ một phiên riêng cho từng engine. Khi sang engine chưa có phiên, 3 việc xong gần nhất của chat được tóm tắt kèm vào prompt để nối tiếp (`/moi` cắt mốc này).
- Việc `limit` của GĐ 1 không còn: chạm giới hạn giờ là chuyển engine hoặc `waiting`.

### Chưa kiểm với thật
- **Codex CLI chưa cài trên máy dev**: engine `codex.js` viết theo tài liệu (`codex exec --json --skip-git-repo-check --sandbox ... -`, `codex exec resume <id>`), test bằng `fake-codex.js`. Khi cài Codex thật phải chạy thử: định dạng sự kiện lỗi/chạm giới hạn, và `resume` có nhận `--sandbox` hay không (hiện không truyền khi resume).
- Câu chữ báo hết hạn mức và giờ hồi của cả hai CLI có thể đổi; `limits.js` có test cho các mẫu đã biết, cần bổ sung mẫu thật khi gặp.
- Giờ hồi không kèm múi giờ được hiểu theo giờ của máy (máy AgentOS đặt giờ Việt Nam).

## GĐ 3: công cụ (MCP, trình duyệt) và gửi file về Telegram
- `tools.json` (`TOOLS_FILE`) khai báo máy chủ MCP và các **bộ công cụ**. Mỗi bộ thành một lệnh Telegram: bộ `web` -> `/web <việc>`. Việc thường (không có lệnh) dùng bộ mặc định chỉ đọc.
- Mỗi bộ có danh sách công cụ cho phép, máy chủ MCP được dùng, gợi ý thêm vào system prompt (`hint`). Claude chạy với `--mcp-config <file> --strict-mcp-config`, nghĩa là chỉ thấy đúng máy chủ của bộ đó; công cụ ngoài danh sách bị từ chối.
- Mẫu: `tools.example.json` (Windows/dev, Chrome sẵn có) và `tools.linux.json` (máy AgentOS: Chromium + Xvfb). Playwright MCP ghim phiên bản `0.0.83`.
- **Hộp thư ra**: AI lưu ảnh/file vào `work/out/`. Sau khi việc xong, bộ điều phối gửi các file mới (tạo từ lúc việc bắt đầu) về Telegram: ảnh png/jpg/webp/gif -> ảnh, pdf/csv/txt/md/xlsx/docx/html -> tài liệu. Tối đa 5 file/việc, ảnh <= 10MB, file <= 20MB, bỏ file ẩn, liên kết tượng trưng, thư mục sâu quá 3 cấp.
- Hint của bộ `web` dặn AI coi nội dung trang web là dữ liệu, không phải chỉ thị. Đây chỉ là lớp nhắc; chống prompt injection thật sự thuộc GĐ 4 (cổng duyệt qua Telegram, phân quyền).

### Đã thử thật (19/10/2026, máy Windows dev)
`claude -p` + Playwright MCP (headless, Chrome) qua đúng mã bộ điều phối: mở example.com, đọc tiêu đề/nội dung, chụp màn hình vào `out/`, hộp thư ra nhận ra file ảnh. 23 giây, ~0,18 USD.
### Chưa kiểm
- Gửi file qua Telegram thật (chỉ test bằng `fetch` giả).
- Codex + MCP (`-c mcp_servers...` viết theo tài liệu, chưa chạy với Codex thật).
- Toàn bộ phần Linux/ISO (Xvfb, VNC, systemd, `tools.linux.json`, hook cài Playwright) — chưa build.

## GĐ 4: cổng duyệt, phân quyền, chống prompt injection
Chi tiết và giới hạn: [docs/an-toan.md](../docs/an-toan.md). Tóm tắt:
- Mỗi lần Claude dùng công cụ, hook `PreToolUse` (`src/gate-hook.js`) hỏi cổng duyệt (`src/gate.js`, HTTP 127.0.0.1 + token). `src/policy.js` quyết định: **tự cho phép** (đọc trong thư mục làm việc, xem web), **hỏi** (tin Telegram có nút ✅ Cho phép / ✅ Cho phép cả việc này / ❌ Từ chối), hoặc **cấm cứng** (file bí mật, ngoài thư mục làm việc, `sudo`, `curl | sh`, mạng nội bộ...). Không trả lời sau `APPROVAL_TIMEOUT_SEC` = từ chối.
- Sau khi AI đọc web, yêu cầu ghi file/chạy lệnh/thao tác web kèm cảnh báo "có thể do trang web cài vào"; `policy.askNewOrigin` hỏi khi chuyển sang trang web mới.
- Bộ công cụ có thêm: `policy` (`allow`/`ask`/`deny` theo mẫu tên công cụ, `allowExec` regex lệnh an toàn, `allowPrivateNetwork`), `adminOnly`, `engines`, `gate`. Mẫu `/lam` (làm việc với file và lệnh, chỉ admin, chỉ Claude).
- `ADMIN_USER_IDS`: admin dùng bộ adminOnly và duyệt lệnh/ghi file. Codex không qua cổng nên không chạy bộ có MCP.
- `/nhatky`: 15 lần xin dùng công cụ gần nhất (bảng `audit`).

### Đã thử thật
Claude Code 2.1.302 trên Windows: `echo` qua Bash hỏi rồi chạy / từ chối thì không chạy; `curl | sh` và đọc file ngoài thư mục bị chặn không hỏi; Claude + Playwright MCP duyệt trang chứa lệnh độc (Claude tự bỏ qua). Phát hiện: lệnh `echo`/`ls` Claude tự coi là an toàn không hề hỏi quyền nếu chỉ dùng `--permission-prompt-tool` -> dùng hook. `ToolSearch` (công cụ nội bộ) phải tự cho phép.
### Chưa kiểm
Nút bấm Telegram thật (chỉ test bằng `fetch` giả), cách hook hoạt động trên Linux/Claude Code phiên bản khác, Codex.

## GĐ 5: độ bền
Chi tiết, bảng tình huống và danh sách chưa kiểm: [docs/do-ben.md](../docs/do-ben.md). Tóm tắt:
- Giết cả cây tiến trình khi hủy/quá giờ (`engines/proc.js`); lỗi tạm thời (quá tải 529, rớt mạng) tự thử lại 15 s/60 s/180 s, không cho engine nghỉ như khi hết hạn mức (`limits.js: classifyFailure`).
- Nhịp tim + watchdog systemd (`health.js`, `data/heartbeat.json`, `scripts/healthcheck.js`); `getUpdates` có timeout phía máy mình.
- Kiểm tra/khôi phục cơ sở dữ liệu khi khởi động, sao lưu hằng ngày, dọn dữ liệu cũ, chặn nhận việc khi đầy ổ (`maintenance.js`); thông báo quản trị viên mỗi lần khởi động.
- Cô lập tiến trình AI bằng bubblewrap (`sandbox.js`, `SANDBOX=off|auto|bwrap`, chỉ Linux, chưa chạy thử): che dữ liệu bộ điều phối và token bot, hệ thống chỉ đọc.
- `scripts/alert.js` (systemd `OnFailure`): nhắn Telegram khi dịch vụ lỗi liên tục.

## Lệnh Telegram
`/claude` `/codex` `/web` `/lam` (tùy tools.json) `/viec` `/nhatky` `/trangthai` `/huy` `/moi` `/id` `/help`

## Cấu trúc
```
src/index.js          nối các phần, vòng nhận tin Telegram (long polling, tự thử lại)
src/bot.js            xử lý lệnh/tin nhắn, kiểm quyền (hàm thuần, dễ test)
src/worker.js         hàng đợi tuần tự, xử lý kết quả/lỗi/giới hạn, giữ phiên
src/engines/claude.js chạy `claude -p --output-format json`, nhận diện giới hạn/hết giờ/hủy
src/db.js             SQLite (bảng jobs, kv)
src/telegram.js       gọi Bot API, chia tin dài
src/tools.js          đọc tools.json: máy chủ MCP + bộ công cụ, ghi cấu hình MCP
src/outbox.js         quét file kết quả AI tạo ra để gửi về Telegram
src/policy.js         chính sách quyền (phân loại công cụ, cấm cứng, nhiễm bẩn)
src/gate.js           cổng duyệt HTTP 127.0.0.1; src/gate-hook.js (hook PreToolUse), src/gate-mcp.js (dự phòng)
src/approvals.js      câu hỏi duyệt qua Telegram (nút bấm, hết giờ, nhật ký)
src/health.js         nhịp tim + watchdog systemd; src/maintenance.js sao lưu/khôi phục/dọn dẹp
src/sandbox.js        cô lập tiến trình AI bằng bubblewrap; src/alert-lib.js + scripts/ cảnh báo, healthcheck
test/                 67 test (fake-claude.js, fake-codex.js, fake-tree.js)
```

## Chưa làm (các GĐ sau)
- GĐ 3b: điều khiển ứng dụng đồ họa (chụp màn hình + chuột/phím trên Xvfb) qua một MCP server tự viết dùng xdotool/scrot; chỉ làm được và kiểm trên Linux. Nên ưu tiên API/CLI/trình duyệt, chỉ dùng khi bắt buộc.
- MCP nghiệp vụ (Gmail, Drive, Sheets, KiotViet...): thêm vào `servers` rồi gắn vào một bộ công cụ mới.
- Dịch vụ systemd cho ISO đã viết (`iso/config/includes.chroot/etc/systemd/system/agentos-*.service`) nhưng chưa chạy thử.
