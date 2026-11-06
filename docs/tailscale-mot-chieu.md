# Chặn máy con kết nối ngược lên máy đầu não (luật Tailscale)

Từ bản 2026.11.06.2, AgentOS đã tự khóa MỘT CHIỀU ở tầng ứng dụng (máy đầu não không nhận điều khiển; máy con chỉ nghe máy điều khiển đầu tiên).
Luật dưới đây là lớp bảo vệ THỨ HAI ở tầng mạng: máy con không mở được kết nối nào tới máy đầu não hay máy con khác, kể cả SSH, RustDesk, cổng 8433.

## Cách đặt (một lần, 2 phút)
1. Vào https://login.tailscale.com/admin/acls (đăng nhập tài khoản Tailscale của cửa hàng) → thẻ **Access controls**.
2. Thay nội dung bằng đoạn dưới, sửa danh sách `daunao` cho đúng thiết bị CỦA ANH:
   - `100.83.146.120` là máy đầu não "chien" (xem lại ở https://login.tailscale.com/admin/machines).
   - Thêm địa chỉ Tailscale của điện thoại/laptop anh nếu muốn vào máy con bằng SSH/RustDesk từ đó.
3. Bấm **Save**. Có hiệu lực ngay, không cần khởi động lại máy nào.

```json
{
  "hosts": {
    "daunao": "100.83.146.120"
  },
  "acls": [
    { "action": "accept", "src": ["daunao"], "dst": ["*:*"] }
  ]
}
```

Ý nghĩa: chỉ máy `daunao` được CHỦ ĐỘNG kết nối tới các máy khác. Máy con không có luật nào cho phép nó chủ động kết nối → không vào được máy đầu não hay máy con khác.
Máy con vẫn trả lời được các kết nối mà máy đầu não mở tới nó (Tailscale cho phép gói trả lời).

## Cần biết
- Thêm thiết bị điều khiển mới (điện thoại, laptop khác): thêm địa chỉ vào `hosts` rồi đưa vào `src`, ví dụ `"src": ["daunao", "dienthoai"]`.
- Máy con vẫn ra internet bình thường (luật chỉ áp cho kết nối giữa các máy trong tài khoản Tailscale).
- Nếu có máy dùng Tailscale làm lối ra (exit node) hoặc chia sẻ mạng con, hỏi lại trước khi đặt luật.
- Không dùng "tag" (thẻ máy) cho máy con: AgentOS bỏ qua máy gắn thẻ khi tự dò và ghép đôi.
- Muốn quay lại như cũ: dán lại luật mặc định `{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}`.
