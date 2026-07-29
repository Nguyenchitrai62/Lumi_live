# Project and BOQ

## Contents

- [Project setup](#project-setup)
- [Norms](#norms)
- [BOQ consolidation](#boq-consolidation)
- [Owner acceptance and payment](#owner-acceptance-and-payment)

## Project setup

| Route | Controls | Data/status |
|---|---|---|
| `/du-an/{project_id}/tong-quan` | `Quay lại` | Placeholder `Sắp ra mắt` |
| `/du-an/{project_id}/chinh-sach` | policy tabs and search | Shared policy data; read-only |
| `/du-an/{project_id}/so-do-khu-vuc` | `#button-import-project-site-plan`, `#button-create-project-site-plan`; row edit/delete when nodes exist | Area/tree code and name; mutations allowed only in owned sandbox |
| `/du-an/{project_id}/bao-cao-so-sanh-dinh-muc` | `Quay về trang chủ` | Unavailable in researched build |

Area/tree nodes are prerequisites for tower/location-dependent material, labor, and warehouse workflows.

## Norms

Route: `/du-an/{project_id}/dinh-muc-vat-tu-nhan-cong`

Actions:

- Refresh: `#button-refresh-materials-labor-bill`
- Export: `#button-export-materials-labors-bill`
- Typical selector: `#button-typical-filter-materials-labors-bill`
- Filters: BOQ type, tower/basement, area, search/page size

Tabs:

| Tab | Columns |
|---|---|
| Tổng quan | STT, Tên gói công việc, SL điển hình |
| SHOP | STT, Mã gói, Giai đoạn, Mã/Tên nhân công, Mã/Tên VTTB, Mã hiệu, Hãng sản xuất, Xuất xứ, ĐVT, Tổng cộng |
| QS | Same detail schema |
| COST | Same detail schema; additional filter state |
| Chủ đầu tư | Same detail schema |
| Dự phòng | Same detail schema |

Tab IDs: `#rc-tabs-0-tab-overview`, `-2`, `-3`, `-1`, `-5`, `-4`.

## BOQ consolidation

List route: `/du-an/{project_id}/boq/boq-gop`

Controls:

- `Mở rộng tất cả` and `Thu gọn tất cả`; disabled on an empty sandbox.
- `Tạo mới`.
- Search, status/type combobox, page size, pagination.

Columns:

- Số phiếu, Trạng thái, Tên phiếu, Diễn giải.
- BOQ values: Tổng GT, GT Vật tư, GT Nhân công, GT CP khác.
- COST 1.0 values: Tổng GT, GT Vật tư, GT Nhân công, GT CP khác.

Create/edit route template:

`/du-an/{project_id}/boq/boq-gop/them/{entity_id}`

The menu may emit `undefined` before an entity exists; treat it as create mode, not a reusable ID.

Form:

- `#cost-create-form_code`: Số phiếu.
- `#cost-create-form_name`: Tên phiếu.
- `#cost-create-form_batchNo`: Đợt duyệt, required.
- `#cost-create-form_description`: Diễn giải.
- Actions: import Excel, search, pagination, save/cancel when enabled by prerequisites.
- Detail columns: Mã/Tên VTTB, Mã/Tên nhân công, Mã gói, Hệ, VT, NC, CP khác, Mã gộp, approved COST prices.

BOQ creation was `blocked_by_prerequisite` in the empty sandbox because upstream norms/items were absent.

## Owner acceptance and payment

All three lists provide `Thêm mới`, search, page-size, pagination, and row action patterns.

| Route | Columns |
|---|---|
| `/boq/nghiem-thu-vat-tu` | STT, Số phiếu thực tế, Kỳ nghiệm thu, Nội dung nghiệm thu, Số phiếu, Ngày lập, Người tạo |
| `/boq/gt-thanh-toan-cdt` | Same identification plus Tổng GT, GT vật tư, GT nhân công |
| `/boq/kl-thanh-toan-cdt` | STT, Số phiếu thực tế, Kỳ nghiệm thu, Nội dung nghiệm thu, Số phiếu, Ngày lập, Người lập |

These workflows depend on BOQ/norm and acceptance-period data. Do not synthesize upstream records merely to bypass a missing prerequisite; mark the step `blocked_by_prerequisite`.

