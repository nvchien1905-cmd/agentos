# Độ bền của AgentOS (GĐ 5)

Mục tiêu: mini PC treo trong cửa hàng nhiều tuần không ai chạm vào; mất điện, rớt mạng, AI treo hay trình duyệt rò bộ nhớ
đều tự phục hồi, và khi không tự phục hồi được thì chủ cửa hàng biết qua Telegram.

## Những gì đã làm

### Trong bộ điều phối (đã có test, chạy được trên Windows dev)
| Tình huống | Cách xử lý |
|---|---|
| Hủy / quá giờ một việc | Giết **cả cây tiến trình** (claude + máy chủ MCP + trình duyệt + bash con): Linux giết cả nhóm tiến trình, Windows `taskkill /T`. Tiến trình chính thoát bình thường thì dọn tiến trình mồ côi trong nhóm (Linux). |
| AI quá tải (529), rớt mạng, 5xx | Phân loại là lỗi **tạm thời**, tự thử lại sau 15 s, 60 s, 180 s (báo người dùng một lần). KHÔNG cho engine nghỉ cả giờ như khi hết hạn mức. `/huy` hủy ngay cả lúc đang chờ thử lại. |
| Kết nối Telegram treo ngầm | `getUpdates` có giới hạn thời gian phía máy mình (35 s + 15 s) nên vòng nhận tin không đứng. |
| Bộ điều phối treo (db lỗi, vòng nhận tin đứng) | Nhịp tim mỗi 10 s ghi `data/heartbeat.json` và báo `WATCHDOG=1` cho systemd. Không khỏe thì **không báo** → systemd khởi động lại sau `WatchdogSec`. Mất mạng không tính là không khỏe (khởi động lại không chữa được mạng). `node scripts/healthcheck.js` kiểm tra từ ngoài (exit 0/1). |
| Mất điện giữa lúc ghi, đĩa lỗi | Mỗi lần khởi động chạy `PRAGMA quick_check`. Hỏng thì **giữ file hỏng** (`*.corrupt-<giờ>`), khôi phục bản sao lưu hằng ngày còn tốt gần nhất, không có thì tạo mới; báo quản trị viên. |
| Sao lưu | Mỗi ngày một bản (`VACUUM INTO`, nhất quán dù đang ghi) ở `data/backups/`, giữ 7 bản, quyền 600. |
| Dữ liệu phình mãi | Mỗi 6 giờ: xóa việc xong > 90 ngày, nhật ký duyệt > 180 ngày, file kết quả (ảnh chụp...) > 14 ngày. Việc đang chờ/chạy không bao giờ bị xóa. |
| Đầy ổ đĩa | Không nhận việc khi còn dưới `MIN_FREE_MB` (báo người dùng); nhắc quản trị viên khi khởi động nếu ổ sắp đầy. |
| Máy vừa khởi động lại (mất điện khi không ai ở đó) | Nhắn quản trị viên mỗi lần khởi động: giờ, việc bị ngắt, cảnh báo ổ đĩa/sandbox/cơ sở dữ liệu. Việc đang chạy dở được đánh dấu `interrupted`, KHÔNG tự chạy lại (có thể đã gây tác dụng phụ). |

### Cô lập tiến trình AI (`src/sandbox.js`, chỉ Linux, chưa chạy thử)
bubblewrap bọc `claude`/`codex` và mọi tiến trình con. Trong sandbox:
- hệ thống ở chế độ **chỉ đọc**, ghi được vào home của người dùng `agentos`, thư mục làm việc, hồ sơ trình duyệt;
- **không thấy** thư mục dữ liệu của bộ điều phối (cơ sở dữ liệu, nhật ký duyệt, sao lưu, heartbeat), `/etc/agentos` (token bot Telegram) và `.env`;
- PID/IPC/hostname riêng, `/tmp` riêng, tự chết khi bộ điều phối chết; **vẫn dùng chung mạng** (cần gọi API, duyệt web, nói chuyện với cổng duyệt 127.0.0.1).

`SANDBOX=off` (mặc định khi dev) | `auto` (dùng nếu bwrap chạy được, không thì chạy KHÔNG cô lập và báo quản trị viên) | `bwrap` (bắt buộc, không dùng được thì việc báo lỗi). Máy AgentOS dùng `auto`. Lúc khởi động bộ điều phối tự thử `bwrap … /bin/true`.

Giới hạn: file đăng nhập của chính CLI (`~/.claude`) nằm trong home nên tiến trình AI đọc được; cổng duyệt chặn đường dẫn đó nhưng sandbox không che được.

### Hệ điều hành (`iso/config/includes.chroot/etc/…`, chưa build/chạy thử)
- `agentos-orchestrator.service`: `Type=notify`, `WatchdogSec=90`, `Restart=always`, `KillMode=control-group`, giới hạn `MemoryMax=6G`/`TasksMax`, gia cố (`ProtectSystem=strict`, `NoNewPrivileges`...), chạy bằng người dùng `agentos` không đặc quyền. Lỗi liên tục tới khi systemd bỏ cuộc (15 lần/10 phút) → `agentos-alert@.service` nhắn Telegram cho quản trị viên.
- Chống ngủ: `logind.conf.d` (bỏ qua idle, nắp máy, phím), `sleep.conf.d` (cấm suspend/hibernate), cộng việc mask `sleep.target` ở hook ISO.
- `system.conf.d`: `RuntimeWatchdogSec=60`; có watchdog phần cứng thì máy treo cứng sẽ tự khởi động lại. `sysctl`: `kernel.panic=10`, `panic_on_oops`.
- `journald`: nhật ký bền qua lần khởi động nhưng tối đa 300 MB / 30 ngày.

## Việc phần cứng/BIOS (không tự động hóa được; ghi vào quy trình cài mini PC)
1. BIOS: **Restore on AC Power Loss = Power On** (mất điện có lại thì máy tự bật). Đây là điều kiện sống còn của "treo máy".
2. Bật NTP, đặt múi giờ `Asia/Ho_Chi_Minh` (giờ hết hạn mức và lịch phụ thuộc đồng hồ).
3. UPS nhỏ cho mini PC và modem (mất điện thoáng qua là gián đoạn mạng).
4. SSD: ghi nhiều (Chromium, nhật ký) → dùng SSD có độ bền tốt, theo dõi `smartctl`.
5. Mạng: dây LAN thay Wi-Fi nếu được; đặt modem tự khởi động lại theo lịch nếu hay treo.

## Chưa làm / chưa kiểm
- **Tất cả phần Linux/systemd/bwrap chưa chạy thử** (máy dev là Windows): unit, watchdog, sandbox, `ProtectSystem=strict` có thể cần chỉnh khi chạy thật (đặc biệt: Chromium trong bwrap cần `/dev/shm`, user namespace không đặc quyền phải bật). `SANDBOX=auto` + thông báo khởi động để lỗi không âm thầm.
- Giới hạn tài nguyên theo từng việc (hiện chỉ giới hạn cả dịch vụ); không tự dọn cache Chromium; chưa có cảnh báo SMART/nhiệt độ.
- Telegram thật chưa thử; chưa thử chạy nhiều ngày liên tục (cần máy Linux thật + soak test, GĐ 7).
