# Administration

## Contents

- [Permissions](#permissions)
- [Partners and detailed catalogs](#partners-and-detailed-catalogs)
- [Accounting and rounding](#accounting-and-rounding)
- [Code generation and banner](#code-generation-and-banner)
- [Management report](#management-report)

All screens in this reference are shared or cross-project unless explicitly stated. Keep create/edit/delete/import/save `blocked_by_policy`.

## Permissions

Route: `/phan-quyen`

Common actions: download, import, create, inline save, search, edit/delete row, pagination.

Tabs:

| Tab | Columns/actions |
|---|---|
| Bộ phận | Status, department code/name, note |
| Chức danh | Status, title code/name, note |
| Nhân sự | Status, employee code/name, department, title, phone, email |
| Vai trò | Add `#btn-add-roles-card`, edit `#btn-edit-roles-card`, delete `#btn-delete-roles-card`; module permission matrix |

Role permission columns:

- Phân hệ.
- Quyền xem, Quyền thao tác, Quản lý, Mặc định.
- Khối lượng, Giá trị.
- Thêm mới, Sửa, Xóa, In, Import, Export, Xác nhận, Chỉnh sửa.

Role behavior was observed only with the current admin account. Do not infer other roles from this matrix.

## Partners and detailed catalogs

### Partners

List `/doi-tac`: export/import/create/inline save/search/pagination.

Columns: status, partner code/full name, tax code, address, recipient, payment account.

Create `/doi-tac/them`:

- Required tax code, partner code, full name, private name.
- Optional address, phone, fax, email, supplied products, short name.
- Switches: customer, subcontractor, supplier, lookup.
- Bank-account grid: bank, address, branch, city, account number, currency, function.

### Detailed materials and labor

Route: `/nhan-cong-vat-tu`

Tabs:

- Vật tư chi tiết: material code, full code/name, applied project volume, model, manufacturer.
- Nhân công chi tiết: tab exists; its large grid repeatedly exceeded the browser extraction deadline, so column-level behavior remains `observed_partial`.

Action: export `#btn-download-labors-and-materials`; search and pagination.

### Global work packages

See [labor.md](labor.md) for fields. Global create/save/delete remains blocked.

## Accounting and rounding

### Accounting periods

Route: `/danh-muc-vat-tu/ky-ke-toan` and project-linked equivalent.

Inputs: search, readonly year picker, page size.

Columns: status, closing month, day count, closing date, update date/user, note.

Actions: edit row and inline save. These settings are shared; do not save.

### Rounding rules

List `/quy-tac-lam-tron`: export/import/create/edit/delete/inline save.

Columns: type, minimum/maximum values, method, threshold, displayed decimal places, note.

Create `/quy-tac-lam-tron/them`:

- Required readonly comboboxes `fieldName` and `ruleType`.
- Optional `minValue`, `maxValue`, `threshold`, `decimalPlaces`, `description`.
- Back, cancel, save.

## Code generation and banner

### Global code generation

Route: `/danh-muc-vat-tu/tao-ma-moi-gop`.

Controls: refresh `#btn-refresh-code-formula-actions`, edit `#btn-edit-code-formula-actions`.

Tabs:

- Code generation settings: table/field selection and field sequence.
- Attribute matrix and material-name generation.

Columns: field name, prefix, suffix, separator. Generated-field buttons remain disabled until edit mode.

The second tab's large grid intermittently exceeded the inspection deadline; use a fresh snapshot and stop if its fingerprint differs.

### Project code generation

Route: `/du-an/{project_id}/danh-muc-vat-tu/tao-ma-moi-gop`.

Tabs: All, Main material, Accessory.

Filters: material/group tree, location, work package. Fields/buttons include material code/type, size/spec/area ranges, and field composition.

Treat edits as shared/broad configuration unless a product owner explicitly confirms project isolation.

### Banner

Route: `/admin/banner`

Action: `Thêm mới`; search and pagination.

Columns: title, subtitle, button text, link, status, order, image.

Never create or change a banner during QC discovery.

## Management report

Routes:

- `/du-an/bao-cao/cost-vat-tu`
- `/du-an/{project_id}/bao-cao/cost-vat-tu`

Actions:

- Display `#btn-get-data-material-cost-report`.
- Export `#btn-export-material-cost-report`.
- Project selector, date range, pagination.

Tabs:

- Detail by material: short/material codes, name, unit, ordered/delivered/pending volume, pre-VAT goods and additional costs.
- Detail by slip: order/stock-in/stock-out date and number, material identity, order area/description.

Reports are read-only; selecting filters and exporting is safe after verifying no hidden write or external-domain navigation.

