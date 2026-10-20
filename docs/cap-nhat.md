# Phát hành bản cập nhật (dành cho chủ dự án)

Khóa riêng nằm ở `C:\Users\nguye\.agentos-update\signing-private.pem` (đã tạo bằng `node update/keygen.js`). **Sao lưu nơi an toàn, không đưa lên GitHub, không gửi cho ai.**

Mỗi lần có thay đổi muốn đưa tới máy khách:

```bash
node update/build-bundle.js --key "$USERPROFILE/.agentos-update/signing-private.pem" --version 2026.10.22.1 --notes "Nội dung ngắn gọn cho khách" [--apply update/apply.sh]
git add -A && git commit -m "Phát hành 2026.10.22.1" && git push
```

- Số phiên bản phải LỚN HƠN bản đang chạy (dạng `năm.tháng.ngày.số-thứ-tự`).
- Máy khách thấy trong tối đa 3 giờ → bot nhắn → khách gõ `/capnhat co` (hoặc đã bật `/capnhat tudong bat`).
- Gói chứa: mã bộ điều phối, trình hướng dẫn, trợ lý màn hình, các lệnh `agentos-*`, dịch vụ, biểu tượng. Cần cài thêm gói apt/npm thì viết `apply.sh` (chạy bằng root, có biến `AGENTOS_FROM`, `AGENTOS_TO`).
- Thử trước: `node --test update/test/update.test.js`; thử thật trên máy ảo bằng `AGENTOS_UPDATE_URL=http://10.0.2.2:8099/` và một máy chủ tĩnh trên máy Windows.
- Muốn thu hồi một bản lỗi: phát hành bản MỚI hơn sửa lỗi (không hạ phiên bản được).
