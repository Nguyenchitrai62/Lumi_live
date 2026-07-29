# Navigation

## Contents

- [Route conventions](#route-conventions)
- [Enterprise routes](#enterprise-routes)
- [Project routes](#project-routes)
- [Global controls](#global-controls)
- [Unavailable and redirecting routes](#unavailable-and-redirecting-routes)

## Route conventions

- Base domain: `https://sit.hawee.hicas.vn`.
- Replace every project UUID with `{project_id}`.
- Treat `/du-an/{project_id}/...` as project-scoped only after verifying project ownership.
- A menu link with `/them` is a create form unless the screen proves otherwise.
- Query-string tab states are part of the screen fingerprint, notably:
  - `/tong-quan?tab=du-an|dashboard|cong-viec`
  - `/du-an/{project_id}/kho/bang-quan-ly-gia?tab=tempCostMaterial|tempCostHuman`

## Enterprise routes

| Group | Route | Screen |
|---|---|---|
| Tổng quan | `/tong-quan` | Redirects to project catalog tab |
| Tổng quan | `/du-an/them` | Create project |
| Tổng quan | `/danh-ba` | Company contacts |
| Tổng quan | `/chinh-sach` | Company policy document groups/documents |
| Vật tư | `/vat-tu` | Menu target; currently 404 |
| Vật tư | `/hop-dong-vat-tu` | Material contracts |
| Vật tư | `/hop-dong-vat-tu/them` | Create material contract |
| Vật tư | `/danh-muc-vat-tu/ty-le-hao-hut` | Loss-rate catalog |
| Vật tư | `/danh-muc-vat-tu/ty-le-hao-hut/them` | Create loss-rate rule |
| Vật tư | `/danh-muc-vat-tu/quy-cach-dong-goi-moi` | Packaging catalog |
| Vật tư | `/danh-muc-vat-tu/quy-cach-dong-goi-moi/them` | Create packaging rule |
| Vật tư | `/danh-muc-vat-tu/tao-ma-moi-gop` | Code-generation settings |
| Vật tư | `/danh-muc-vat-tu/spec-library` | SPEC library |
| Vật tư | `/danh-muc-vat-tu/spec-catalog` | Redirects to `/discipline` |
| Nhân công | `/nhan-cong` | Menu target; currently 404 |
| Nhân công | `/hop-dong-nhan-cong` | Labor contracts |
| Nhân công | `/hop-dong-nhan-cong/them` | Create labor contract |
| Quản trị | `/phan-quyen` | Departments, titles, employees, roles |
| Quản trị | `/nhan-cong-vat-tu` | Detailed materials/labor |
| Quản trị | `/danh-muc-nhan-cong/goi-cong-viec` | Global work packages |
| Quản trị | `/danh-muc-nhan-cong/goi-cong-viec/them` | Create global work package |
| Quản trị | `/doi-tac` | Partners |
| Quản trị | `/doi-tac/them` | Create partner |
| Quản trị | `/danh-muc-vat-tu/ky-ke-toan` | Accounting periods |
| Quản trị | `/quy-tac-lam-tron` | Rounding rules |
| Quản trị | `/quy-tac-lam-tron/them` | Create rounding rule |
| Quản trị | `/du-an/bao-cao/cost-vat-tu` | Cross-project material cost report |
| Quản trị | `/admin/banner` | Banner settings |

## Project routes

### Project and BOQ

| Route | Screen |
|---|---|
| `/du-an/{project_id}/tong-quan` | Placeholder/coming soon |
| `/du-an/{project_id}/them` | Currently unavailable |
| `/du-an/{project_id}/chinh-sach` | Project policy view |
| `/du-an/{project_id}/so-do-khu-vuc` | Project area tree |
| `/du-an/{project_id}/dinh-muc-vat-tu-nhan-cong` | Material/labor norms |
| `/du-an/{project_id}/bao-cao-so-sanh-dinh-muc` | Currently unavailable |
| `/du-an/{project_id}/boq/tong-quan` | Currently unavailable |
| `/du-an/{project_id}/boq/boq-gop` | BOQ consolidation slips |
| `/du-an/{project_id}/boq/boq-gop/them/{entity_id}` | Create/edit BOQ slip; menu may initially emit `undefined` |
| `/du-an/{project_id}/boq/nghiem-thu-vat-tu` | Material acceptance slips |
| `/du-an/{project_id}/boq/gt-thanh-toan-cdt` | Owner value-payment slips |
| `/du-an/{project_id}/boq/kl-thanh-toan-cdt` | Owner quantity/payment-area slips |

### Materials

| Route | Screen |
|---|---|
| `/du-an/{project_id}/vat-tu/tong-quan` | Currently unavailable |
| `/du-an/{project_id}/danh-muc-vat-tu/quan-ly-danh-muc-boc-khoi-luong` | Norm-volume slips |
| `/du-an/{project_id}/vat-tu/don-hang` | Purchase orders |
| `/du-an/{project_id}/vat-tu/don-hang/them` | Create purchase order |
| `/du-an/{project_id}/vat-tu/lenh-dieu-chuyen` | Transfer orders |
| `/du-an/{project_id}/vat-tu/lenh-dieu-chuyen/them` | Create transfer order |
| `/du-an/{project_id}/hop-dong-vat-tu` | Project material contracts |
| `/du-an/{project_id}/hop-dong-vat-tu/them` | Create project material contract |
| `/du-an/{project_id}/danh-muc-nhan-cong/kiem-soat-dat-hang-thua` | Excess-order control |
| `/du-an/{project_id}/danh-muc-vat-tu/spec-library` | Project SPEC library |
| `/du-an/{project_id}/danh-muc-vat-tu/review-data` | Volume review |
| `/du-an/{project_id}/vat-tu/nha-cung-cap` | Project suppliers |
| `/du-an/{project_id}/vat-tu/nha-cung-cap/them` | Create supplier |

### Labor

| Route | Screen |
|---|---|
| `/du-an/{project_id}/nhan-cong/tong-quan` | Currently unavailable |
| `/du-an/{project_id}/nhan-cong/so-do-thau-phu` | Subcontractor area map |
| `/du-an/{project_id}/nhan-cong/so-do-thau-phu/them` | Assign subcontractor |
| `/du-an/{project_id}/nhan-cong/de-nghi-thanh-quyet-toan` | Payment requests |
| `/du-an/{project_id}/nhan-cong/de-nghi-thanh-quyet-toan/them` | Create payment request |
| `/du-an/{project_id}/hop-dong-nhan-cong` | Project labor contracts |
| `/du-an/{project_id}/hop-dong-nhan-cong/them` | Create labor contract |
| `/du-an/{project_id}/danh-muc-nhan-cong/kiem-soat-thanh-toan-thua` | Overpayment control |
| `/du-an/{project_id}/danh-muc-nhan-cong/bao-cao-nhan-cong` | Currently unavailable |
| `/du-an/{project_id}/nhan-cong/thau-phu` | Subcontractor list |
| `/du-an/{project_id}/nhan-cong/thau-phu/them` | Create subcontractor |

### Warehouse, reports, and project catalogs

| Route | Screen |
|---|---|
| `/du-an/{project_id}/kho/tong-quan` | Currently unavailable |
| `/du-an/{project_id}/kho/nhap-kho` | Stock-in slips |
| `/du-an/{project_id}/kho/nhap-kho/them` | Create stock-in |
| `/du-an/{project_id}/kho/xuat-kho` | Stock-out slips |
| `/du-an/{project_id}/kho/xuat-kho/them` | Create stock-out |
| `/du-an/{project_id}/kho/kiem-soat-xuat-kho-thua` | Excess stock-out control |
| `/du-an/{project_id}/kho/bao-cao-tuoi-ton-kho` | Inventory-aging report |
| `/du-an/{project_id}/kho/bang-quan-ly-gia` | Period and temporary costs |
| `/du-an/{project_id}/danh-muc-vat-tu/ky-ke-toan` | Shared accounting-period view |
| `/du-an/{project_id}/bao-cao/cost-vat-tu` | Project material cost report |
| `/du-an/{project_id}/danh-muc-vat-tu/tao-ma-moi-gop` | Project code generation |
| `/du-an/{project_id}/danh-muc-vat-tu/ty-le-hao-hut` | Loss-rate catalog |
| `/du-an/{project_id}/danh-muc-vat-tu/ty-le-hao-hut/them` | Create loss-rate rule |
| `/du-an/{project_id}/danh-muc-nhan-cong/goi-cong-viec` | Assign project work packages |
| `/du-an/{project_id}/danh-muc-nhan-cong/giai-doan` | Assign phases |
| `/du-an/{project_id}/danh-muc-vat-tu/khu-vuc-du-an` | Project areas |
| `/du-an/{project_id}/danh-muc-phan-quyen/nhan-su-du-an` | Project personnel |
| `/du-an/{project_id}/danh-muc-vat-tu/kho` | Warehouse catalog |
| `/du-an/{project_id}/danh-muc-vat-tu/kho/them` | Create warehouse |

## Global controls

| Control | Selector | Behavior |
|---|---|---|
| Project chooser | visible `div[role=button]` containing `Chọn dự án` | Opens project selection; choosing changes project context |
| Module/menu chooser | `#select-trigger-tool-select` | Opens the enterprise/project navigation matrix |
| Global search | `#input-search-main-header` | Searches from the current context |
| Notifications | `.anticon-bell.ant-dropdown-trigger` | Opens notification dropdown; observed empty in the research run |
| Account | `#avatar-trigger-profile:visible` | Identity summary, change password, account settings, logout |
| Help | visible button `TRỢ GIÚP` | Opens `/help?from=<current-path>` in a new tab; page was empty/placeholder |

Account routes:

- `/doi-mat-khau`: `currentPassword`, `newPassword`, `confirmPassword`; actions `Hủy bỏ`, `Đổi mật khẩu`.
- `/cai-dat-tai-khoan`: `userName` disabled; editable `fullName`, `email`, `phone`; disabled department, positions, date; actions `Hủy`, `Lưu`.

## Unavailable and redirecting routes

- `/vat-tu` and `/nhan-cong` return 404 with `Quay về trang chủ`.
- Project overview displays `Sắp ra mắt`.
- Several project overview routes listed as “currently unavailable” render an empty/404 shell.
- `/danh-muc-vat-tu/spec-catalog` redirects to `/danh-muc-vat-tu/spec-catalog/discipline`.
- Project SPEC library rendered an empty shell in the sandbox.
- Treat an empty shell as `blocked_by_prerequisite` or unavailable; do not invent controls.
