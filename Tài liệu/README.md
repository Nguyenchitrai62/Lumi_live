# Không gian chạy thử — Agent QC cho HICAS ERP

Thư mục này là project để chạy thử agent QC trên Claude Cowork. Mở Cowork với thư mục
này làm thư mục gốc.

## Cấu trúc

```
.claude/skills/
  hicas-erp-qc/     bản đồ ERP: route, màn hình, nút, trường dữ liệu, quy trình
  qc-rules/         quy tắc hành xử: ý định, xác minh, 8 mức kết luận, Redmine, Excel
.mcp.json           khai báo MCP server Redmine
mcp-servers/        mã nguồn MCP server (không phụ thuộc gói ngoài)
ket-qua/            nơi ghi báo cáo, workbook kết quả, ảnh chụp bằng chứng
*.xlsx              tài liệu QC đưa vào (yêu cầu kiểm thử, file import mẫu)
```

## Cài đặt một lần

Đặt API key Redmine vào biến môi trường — **không ghi vào file trong repo**:

```powershell
$env:REDMINE_API_KEY = "<key moi tao tai https://redmine.anybim.vn/my/api_key>"
```

Kiểm tra server chạy được:

```bash
printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"redmine_get_current_user","arguments":{}}}' | node mcp-servers/redmine/server.mjs
```

Trả về tên tài khoản là đạt.

## Kết nối đang dùng

| Kênh | Trạng thái | Ghi chú |
|---|---|---|
| Redmine | MCP server cục bộ | `https://redmine.anybim.vn`, key qua biến môi trường |
| Excel | Skill `xlsx` có sẵn | Đọc yêu cầu, ghi kết quả ra `ket-qua/` |
| Google Drive | Connector Cowork | Thư mục `QC-ERP-HICAS` — nơi team gửi yêu cầu và nhận kết quả |
| Trình duyệt | Claude in Chrome | Dùng phiên Chrome đã đăng nhập ERP, đọc bằng DOM |
| Notion | Chưa bật | Bật sau khi luồng Redmine chạy ổn |

## Quy ước làm việc

- Yêu cầu QC đặt vào thư mục này hoặc thả lên Drive `QC-ERP-HICAS`.
- Agent **không bao giờ ghi đè** file yêu cầu gốc; kết quả luôn ra `ket-qua/`.
- Chỉ thao tác trên `sit.hawee.hicas.vn`, chỉ sửa dự án do chính lần chạy tạo ra.
- Chỉ `failed_product` mới tạo Redmine issue; mọi thao tác ghi Redmine đều hỏi trước.
