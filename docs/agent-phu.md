# Nhiều bot Telegram: bot quản lý + các bot thường (`/daily`, `/giao`)

Mọi bot đều là **bot thường** (có token, ID được nhắn, chế độ Bảo vệ/Toàn quyền và quyền hạn riêng, chỉnh ở **Cài đặt → Bot Telegram**). Một bot được đánh dấu **⭐ Quản lý**: nó vừa tự làm việc như các bot khác, vừa tạo/điều khiển các bot còn lại và **giao việc** cho chúng. Bot thường làm việc tách hẳn nhau và tách khỏi bot quản lý. (Trong mã gọi bot thường là "agent".)

## Giao việc (bot quản lý → bot thường)
Nhắn cho bot quản lý: `giao cho bot Bán hàng làm: lập báo cáo doanh số hôm nay` (hoặc `/giao a1 lập báo cáo…`, `@tên_bot`, mã `a1`). Bot quản lý đặt việc vào hộp thư nội bộ trên máy (Telegram không cho bot nhắn thẳng cho bot khác), bot thường nhận trong vài giây, làm như thể anh nhắn trực tiếp (anh cũng thấy nó làm trong khung chat với bot đó nếu đã bấm Start), xong thì **bot quản lý báo lại kết quả cho anh**.
- Bot thường chỉ nhận việc từ ID nằm trong danh sách "Người được phép" của nó; ID khác bị từ chối và báo lại.
- Câu bắt đầu bằng "giao hàng…" không bị hiểu nhầm là giao việc (phải có "giao việc/giao cho/bot", hoặc dùng mã `a1`/`@tên_bot`).
- Hộp thư ở `/var/lib/agentos-agents/.mail/<mã>/in|out`, quyền do root đặt: bot này không vào được hộp thư của bot khác. Nội dung hộp thư coi là dữ liệu không tin cậy.

## Dùng
1. Ở @BotFather gõ `/newbot`, đặt tên, chép **token**.
2. Trên bot quản lý: `/daily them <token> [tên agent]` (bot tự xóa tin chứa token). Hoặc `/menu` → "🤖 Agent".
3. Mở bot mới trên Telegram và nhắn việc như bình thường. Mặc định chỉ ID của chủ máy được nhắn.

| Lệnh (chỉ chủ máy, trên bot quản lý) | Việc |
|---|---|
| `/daily` | Danh sách + nút ⏸ dừng · 🔄 khởi động lại · 📜 nhật ký · 🗑 xóa |
| `/daily them <token> [tên]` | Thêm agent |
| `/daily dung\|chay\|khoidong <agent>` | Tạm dừng / chạy lại / khởi động lại |
| `/daily nhatky <agent> [số dòng]` | Xem nhật ký (token được che) |
| `/daily gioihan <agent> <RAM MB> [CPU %]` | Mặc định RAM 1536 MB, CPU 100% (1 nhân). RAM 256–16384, CPU 25–1600 |
| `/daily chu <agent> <ID,ID>` | Những ID Telegram được nhắn cho agent |
| `/daily ten <agent> <tên>` | Đổi tên |
| `/daily xoa <agent>` | Xóa (hỏi lại). Dữ liệu GIỮ ở `/var/lib/agentos-agents/.da-xoa-<mã>-<giờ>` |

`<agent>` là mã (`a1`), số (`1`), tên hoặc `@tên_bot`. Tối đa 12 agent trên một máy.

## "Độc lập" nghĩa là gì (mức chắc)
Mỗi agent có:
- **tài khoản hệ thống riêng** `agentos-aN`, mặc định không có sudo (chủ máy có thể cấp riêng từng bot ở Cài đặt → Bot Telegram → "Quyền quản trị máy (sudo)": tệp `/etc/sudoers.d/91-agentos-agent-aN`, bot đó gỡ cô lập và đọc được dữ liệu mọi bot khác), thư mục riêng `/var/lib/agentos-agents/aN` (quyền 700);
- **dịch vụ systemd riêng** `agentos-agent-aN`: sập hoặc kẹt một agent không kéo theo agent khác hay bot quản lý; tự khởi động lại; lỗi liên tục thì bot quản lý nhắn cảnh báo;
- **giới hạn RAM / CPU / số tiến trình riêng** (cgroup);
- **không nhìn thấy** `/etc/agentos` (token, khóa), `/var/lib/agentos` (dữ liệu bot quản lý), `/srv/onedrive`, `/root`, thư mục của agent khác;
- **cơ sở dữ liệu, bộ nhớ, dự án, kỹ năng, hộp cô lập AI riêng**.

Agent chỉ dùng được lệnh cơ bản (nhắn việc, `/duan`, `/kynang`, `/hoantac`, `/nen`, `/huy`, `/help`…). Cập nhật hệ điều hành, toàn quyền, kết nối máy, Google, màn hình, KiotViet… **chỉ ở bot quản lý**.

## Cách hoạt động (an toàn)
Bot quản lý chạy bằng người dùng thường (`agentos`) nên **không tự tạo được tài khoản**. Nó thả tệp yêu cầu vào `/var/lib/agentos-agentctl/req/`; `agentos-agentctl.path` đánh thức `agentos-agentctl` (root) để làm. Vì người gửi kém quyền hơn root, root **kiểm lại mọi giá trị** (mã agent, token, ID, giới hạn), không đi theo liên kết tượng trưng, chỉ ghi kết quả vào `res/`.
- Token của agent chỉ nằm trong `/etc/agentos/agents/aN.env` (root 600); bot quản lý **không lưu** token (sổ `data/agents.json` chỉ có tên, @bot, ID chủ, giới hạn).
- Agent nhận khóa Claude dùng chung (`CLAUDE_CODE_OAUTH_TOKEN` hoặc khóa API) chép từ cấu hình máy; **không** nhận token bot chính, khóa KiotViet, Google…
- Chương trình `claude` được chép một bản vào `/var/lib/agentos-agents/.bin/claude` (agent không đọc được thư mục của bot quản lý, và cũng bị cấm vào thư mục của agentctl).

## Giới hạn hiện tại
- Agent chỉ dùng **Claude** (không Codex/Gemini/DeepSeek).
- Không có trình duyệt/màn hình ảo riêng cho agent (chưa hỗ trợ việc cần Chrome).
- Máy chưa có token/khóa Claude dùng chung mà chỉ đăng nhập bằng tài khoản: agent dùng **bản sao** phiên đăng nhập; hết phiên thì phải đặt token dài hạn (`claude setup-token`) để mọi agent dùng chung ổn định.
- Bot không nhắn trực tiếp cho bot khác được (giới hạn của Telegram), nên chưa có "giao việc từ bot quản lý sang agent". Báo cáo/nhật ký xem bằng `/daily nhatky`.
- Cần cập nhật lên bản có agent rồi chạy `sudo agentos-agentctl init` hoặc khởi động lại máy lần đầu.

## Gỡ rối
- Không tạo được: `systemctl status agentos-agentctl.path agentos-agentctl.service`, `journalctl -u agentos-agentctl`.
- Agent không trả lời: `/daily nhatky aN`; token sai/bị thu hồi → thêm lại bằng token mới.
- Xóa hẳn dữ liệu đã lưu trữ: `sudo rm -rf /var/lib/agentos-agents/.da-xoa-*`.
