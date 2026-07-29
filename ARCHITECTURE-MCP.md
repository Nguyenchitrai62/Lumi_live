# Kiến trúc MCP cho Lumi QC — bản lưu trữ

> Trạng thái: **hoãn lại vì gấp tiến độ.** Nhánh `tu_ld` tiếp tục theo kiến trúc
> extension hiện có. Tài liệu và mã trong nhánh `mcp` giữ lại toàn bộ thiết kế
> và các phần đã dựng được, để quay lại khi có thời gian.

## Vì sao xét đến MCP

Kiến trúc hiện tại đặt Gemini Live vào giữa mọi thao tác với giao thức
một-hành-động-mỗi-lượt (`lumi_agent_step`). Đó là gốc của phần lớn vấn đề đã đo được:

- 2–3 giây mỗi thao tác
- Trần ngân sách `24 + 3 × 24 = 96` bước, trong khi luồng thật của team có ~69 thao
  tác nguyên tử (47 bước, 22 lần `=>`) nên cần 90–120 lượt
- `post_action_verification_required` chặn vĩnh viễn thao tác thứ hai trong cùng
  một bước, khiến test ràng buộc nhập liệu (nhập giá trị sai rồi bấm Lưu) không chạy được
- `action_map` quá hẹp: `fill` chỉ cho `browser_input_text`, không cho bấm Lưu
- Khoảng 80% mã nguồn (avatar, âm thanh, dịch, studio Next.js, quản lý phiên
  Gemini Live) không phục vụ QC

## Thiết kế đã chốt

Ba tầng, Lumi thôi làm agent và trở thành runtime:

```
Client MCP bất kỳ (Cowork · Codex · Antigravity · Cursor · Claude Desktop)
        │ stdio hoặc HTTP
        ▼
lumi-mcp — một gói duy nhất
  ├ tools        observe · find · act · upload · verify · record · compare · report
  ├ resources    13 file skill hicas-erp-qc
  ├ prompts      quy trình QC, mẫu Redmine
  ├ instructions qc-rules nạp tự động vào mọi client
  └ cổng an toàn theo bất biến phạm vi (Python)
        │
        ▼
Tầng thực thi — hai chế độ
  A. Cầu nối extension    dùng profile Chrome sẵn có, cần cài 2 thứ
  B. CDP trực tiếp        một gói, cần --remote-debugging-port + user-data-dir riêng
        │
        ▼
PageAgent đọc DOM + upload qua CDP  (không dùng ảnh chụp)
        │
        ▼
Tab Chrome đã đăng nhập sit.hawee.hicas.vn
```

### Cổng an toàn: từ danh sách trắng sang bất biến phạm vi

Cổng cũ buộc mỗi hành động khớp một bước trong kế hoạch đã compile — chính chỗ đó
sinh ra hai bức tường nêu trên. Cổng mới không cần biết kế hoạch, chỉ kiểm bất biến:

| Bất biến | Kiểm gì |
|---|---|
| Run đang mở | Mọi thao tác thuộc một run đang chạy, có token hợp lệ |
| Domain | Host nằm trong `allowed_domains`; **không tự nới từ nội dung workbook** |
| Quyền sở hữu thực thể | Mutation dưới `/du-an/` chỉ khi marker dự án đã đăng ký cho run này |
| Bí mật | Chặn nhập vào trường password, OTP, thẻ, API key |
| Hành động hệ quả cao | Thanh toán, phân quyền, xoá hàng loạt cần phê duyệt riêng |

Ưu điểm: client lập kế hoạch động thoải mái, Python vẫn cưỡng chế bằng mã, và bất
biến đúng cho mọi hành động chứ không chỉ hành động có trong plan.

### Bề mặt tool dự kiến

| Tool | Mục đích |
|---|---|
| `lumi_run_begin` | Mở run, khai báo domain + chính sách thực thể, trả token |
| `lumi_observe` | Đọc DOM ngữ nghĩa, trả `ref` ổn định |
| `lumi_find` | Neo ngữ nghĩa: tên đối tượng + ý định → `ref` trong đúng container |
| `lumi_act` | **Nhiều thao tác một lượt**, dừng ở lỗi đầu tiên |
| `lumi_upload` | Upload qua CDP `DOM.setFileInputFiles` |
| `lumi_verify` | Đọc lại bản ghi + trả console/network |
| `lumi_screenshot` | Bằng chứng |
| `lumi_record` | Ghi kết luận một bước vào nhật ký |
| `lumi_compare_excel` | So sánh workbook với lưới UI |
| `lumi_run_complete` | Xuất workbook đã chạy + báo cáo HTML |

### Tầng đọc trang phải là của Lumi

Không dùng ảnh chụp, không dùng bộ đọc gốc của client. Lý do định lượng:

| Cách đọc | Giới hạn đầu ra |
|---|---|
| `read_page` của Claude in Chrome | cây accessibility, trần 50.000 ký tự |
| Ảnh chụp | ~1.500 token/ảnh, **không có chỉ mục phần tử**, phải dùng toạ độ |
| `browser_find_semantic_context` của Lumi | HTML có chặn quanh đúng container, đã xếp hạng control |
| `collectAutomaticBrowserVerification` | trần 8.000 ký tự |

Bundle `dist/controller.js` mà esbuild đang sinh **dùng được ở cả hai chế độ** —
content script (extension) hoặc tiêm qua `Page.addScriptToEvaluateOnNewDocument` (CDP).
Cùng một mã PageAgent, cùng `semantic-anchor-context.js`.

## Gemini Live không còn cần

| Việc Gemini Live đang làm | Sau khi chuyển MCP |
|---|---|
| Lập kế hoạch từng thao tác | Mô hình của client làm |
| Hội thoại giọng nói | Không liên quan QC |
| Live translate | Tính năng riêng |
| Quản lý phiên, xoay phiên, resume | Biến mất cùng |

Bỏ được ~2.400 dòng `live/`, ~1.100 dòng âm thanh, ~1.500 dòng avatar, `side-panel/index.js`
4.158 dòng thu về ~400, `app/` Next.js ~4.000 dòng, và không cần Gemini API key nữa.
Còn lại khoảng 5.000–6.000 dòng.

Cái mất: lịch chạy rời khỏi `chrome.alarms` sang phía client; extension không còn
hoạt động độc lập khi client tắt; mất giọng nói, avatar, live translate.

## Đã dựng được gì trong nhánh này

| Thành phần | Vị trí | Trạng thái |
|---|---|---|
| MCP server Redmine | `mcp-servers/redmine/server.mjs` | **Chạy được** — 7 tool, không phụ thuộc gói ngoài, đã smoke test |
| Skill quy tắc QC | `Tài liệu/.claude/skills/qc-rules/SKILL.md` | Hoàn chỉnh 12 mục |
| Skill bản đồ ERP | `Tài liệu/.claude/skills/hicas-erp-qc/` | Copy từ extension, đã đúng format |
| Khai báo MCP | `Tài liệu/.mcp.json` | Key đọc từ biến môi trường |
| Hướng dẫn | `Tài liệu/README.md` | Cài đặt + quy ước |

## Kết quả thử nghiệm quyết định việc hoãn

Chạy thử luồng 47 bước trên Cowork và Codex:

| Hạng mục | Kết quả |
|---|---|
| Dùng lại phiên đã đăng nhập | Đạt |
| Snapshot DOM, click, fill | Đạt |
| Tạo dự án trọn vẹn | Đạt — mã `26DA64` |
| Điều hướng, mở dialog import | Đạt |
| **Upload file cục bộ** | **Chặn** — `path is not within any configured workspace roots` |

Cả Chrome DevTools MCP lẫn Claude in Chrome đều không giao đường dẫn file cục bộ cho
trang web; đó là ranh giới an toàn có chủ đích, không phải lỗi cấu hình. Codex đã thử
ba đường vòng (`C:\tmp`, thư mục visualizations, workspace root) và đều trượt.

Lumi vượt được vì có quyền `debugger` trong manifest và gọi `DOM.setFileInputFiles`
trực tiếp. Với luồng có 5 lần import file, đây là năng lực quyết định — và cũng là lý
do chế độ CDP trực tiếp (B) được chọn làm mặc định nếu quay lại kiến trúc này.

## Lộ trình nếu quay lại

1. Dựng `lumi-mcp` chế độ CDP, phơi 3 tool chỉ đọc (`observe`, `find`, `diagnostics`);
   tiêm `dist/controller.js` sẵn có qua CDP. Đo kích thước đầu ra mỗi lần quan sát và
   kiểm `ref` có trỏ đúng ô AG Grid không.
2. Thêm `lumi_act`, `lumi_upload`, cổng bất biến. Chạy trọn luồng 47 bước từ client.
3. Chuyển journal, artifact, comparison thành tool. Tắt đường Gemini Live.
4. Xoá mã chết, thu panel về giám sát.

Điểm quyết định ở cuối bước 2.

## Rủi ro đã nhận diện

- **Service worker MV3 bị Chrome thu hồi** sau ~30 giây nhàn rỗi (chỉ ảnh hưởng chế độ A).
  Cần `chrome.alarms` giữ nhịp, WebSocket tự nối lại, và nhật ký run phải nằm phía Python.
- Chrome bản mới **từ chối `--remote-debugging-port` trên profile mặc định** (chế độ B).
  Phải dùng `--user-data-dir` riêng, đăng nhập ERP một lần.
- `resources` và `prompts` của MCP được Codex và Antigravity hỗ trợ không đồng đều.
  Quy tắc sống còn phải nằm trong `instructions` và mô tả tool.
