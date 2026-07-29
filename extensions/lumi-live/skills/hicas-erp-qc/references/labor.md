# Labor

## Contents

- [Labor contracts](#labor-contracts)
- [Subcontractors and area assignment](#subcontractors-and-area-assignment)
- [Payment requests](#payment-requests)
- [Overpayment control](#overpayment-control)
- [Work packages, phases, and personnel](#work-packages-phases-and-personnel)

## Labor contracts

List routes: `/hop-dong-nhan-cong` and `/du-an/{project_id}/hop-dong-nhan-cong`.

Controls: `Tải xuống`, `Tạo mới`, search, project selector on enterprise route, page-size, pagination, and row action pattern.

Columns:

- STT, Trạng thái, Số HĐ thực tế, Tên thầu phụ, Ngày ký, Tóm tắt nội dung.
- Grouped contract/addendum values: before VAT, VAT, after VAT.

Create route: `/hop-dong-nhan-cong/them` or `/du-an/{project_id}/hop-dong-nhan-cong/them`.

Required:

- `projectId`: project.
- `customerCode`: subcontractor.
- `partnerBankSelect`: bank account.
- `contractNumber`: contract number.
- `signDate`: signing date.
- `currency`: currency.

Value/payment fields:

- `exchangeRate`, `vatPercent`.
- `beforeEstimatedContractValue`; `afterEstimatedContractValue` is calculated/readonly.
- `advancePercent`, `deductionPercent`, `deductionFinishMilestone`.
- `materialPaymentPercent_checked` plus amount.
- `installationPaymentPercent`, `installationInvoicePercent`, `warrantyRetentionPercent`.

Detail actions: download template, import Excel, add row, cancel, save.

Detail columns: subcontractor description, labor code/name, volume, total/material/labor unit prices, before-VAT/VAT/after-VAT values, material-acceptance flag.

Creating a contract was `blocked_by_prerequisite` in the empty sandbox because no authorized subcontractor/bank/work item existed.

## Subcontractors and area assignment

Routes:

- `/du-an/{project_id}/nhan-cong/thau-phu`
- `/du-an/{project_id}/nhan-cong/thau-phu/them`
- `/du-an/{project_id}/nhan-cong/so-do-thau-phu`
- `/du-an/{project_id}/nhan-cong/so-do-thau-phu/them`

Subcontractor create fields:

- Required `ms_Thue`, `ma_kh`, `ten_kh`, `ten_rieng`.
- Optional address, phone, fax, email, supplied product, short name.
- Role switches: customer, subcontractor, supplier, lookup.
- Bank rows: bank name/address/branch/city/account/currency.
- Contact rows: recipient, gender, title, location, phone, fax.

Partner-like records may be shared. Keep save/delete `blocked_by_policy` under the current scope.

Area-map actions:

- List/map: `Gán thầu phụ`.
- Assignment form: required `supplierCode`; readonly `ten_goi_tat`; add-row table with System, Work package, Area, Action; `Huỷ bỏ`, `Lưu`.

Area assignment is project-scoped but requires an existing shared subcontractor plus project areas/work packages.

## Payment requests

List: `/du-an/{project_id}/nhan-cong/de-nghi-thanh-quyet-toan`

- Refresh `#btn-refresh-payment-request-page`.
- Add `#btn-add-payment-request`.
- Search, page-size, pagination.
- Columns: status, slip number, request date, subcontractor, subcontract number, request type, completed values before tax/tax/after tax.

Create: `/du-an/{project_id}/nhan-cong/de-nghi-thanh-quyet-toan/them`

Required:

- `requestType`
- `requestDate`
- `customerCode`
- `contractLaborId`
- `rateOfPayment` (readonly until dependencies resolve)

Optional: `vatPercent`, `description`.

Detail dimensions: tower, position, work package, phase, norm payment rate, action.

Actions: add row, cancel, save.

This flow requires a labor contract, assigned subcontractor, area/work package, and payment-rate data.

## Overpayment control

Route: `/du-an/{project_id}/danh-muc-nhan-cong/kiem-soat-thanh-toan-thua`

Actions:

- Refresh `#btn-refresh-overpaid-page`.
- Export `#button-download-overpaid-page`.
- Search `#input-search-overpaid-page`.

Tabs:

| Tab | Main columns |
|---|---|
| Tổng hợp giá trị theo thầu phụ | STT, Tên thầu phụ, Tổng |
| Tổng hợp giá trị theo gói & TP | Mã/Tên gói, Tên thầu phụ, Tổng, Giá trị thanh toán thừa |
| Chi tiết nhân công theo gói & TP | Mã gói, Mã/Tên nhân công, Thầu phụ, Đơn giá HĐTP, Giá trị/KL dư thừa, KL định mức, Tổng KL, KL đã thanh toán |

The project labor-report overview route was unavailable in the researched build.

## Work packages, phases, and personnel

### Global work packages

List columns: status, system/project package codes, package name, material/labor cost-management methods, note, system code.

Create fields:

- Required system, project code, description, system package code, package name.
- Optional note and material/labor cost methods.
- Active switch `#isActive`.

This is shared data; do not save.

### Project assignment

- `/danh-muc-nhan-cong/goi-cong-viec`: export/import, `Gán gói công việc`, inline save; same package columns.
- `/danh-muc-nhan-cong/giai-doan`: export/import, `Gán giai đoạn`, inline save; status, phase name/code, note.
- These assignments are project-scoped but may depend on shared catalogs.

### Project personnel

Route: `/du-an/{project_id}/danh-muc-phan-quyen/nhan-su-du-an`

Actions: import, add personnel, row delete, search, pagination.

Columns: employee code, full name, phone, email, note, role list.

Personnel data is sensitive. Do not persist row values. Project assignment changes are allowed only when explicitly included in the sandbox plan.

