# Materials

## Contents

- [Material contracts](#material-contracts)
- [Purchase orders](#purchase-orders)
- [Transfer orders](#transfer-orders)
- [Material review and controls](#material-review-and-controls)
- [Catalogs and suppliers](#catalogs-and-suppliers)

## Material contracts

List routes: `/hop-dong-vat-tu` and `/du-an/{project_id}/hop-dong-vat-tu`.

Controls: refresh icon, `Tải xuống`, `Tạo mới`, search, project selector on enterprise route, page-size, pagination, row actions.

Columns: STT, Trạng thái, Số hợp đồng, Nhà cung cấp, Ngày ký, Ngày hết hiệu lực, Loại hàng hoá, TG chờ hàng, Diễn giải, GT hàng hoá trước VAT, CCPS trước VAT, and grouped contract/addendum values.

Create route: `/hop-dong-vat-tu/them` or `/du-an/{project_id}/hop-dong-vat-tu/them`.

Required fields:

- `projectId`: Dự án.
- `supplierCode`: Nhà cung cấp.
- `contractNumber`: Số hợp đồng.
- `startDate`: Ngày ký.
- `currencyId`: Loại tiền.

Optional/general fields:

- Contract class checkboxes: HĐ vật tư, HĐ thiết bị, XNĐH.
- `endDate`, `itemCategoryDescription`, `description`.
- `totalAmountExclTax`, `totalAmountVat`, `exchangeRate`.
- `advanceRate`, `paymentRate`, `retentionRate`, `leadTimeInDays`.
- Price-hold conditions by days, minimum order value/count, and minimum contract value; amount fields stay readonly until their checkbox is enabled.
- `paymentType`, `paymentAccount`.

Detail actions: select all, clear selection, delete selected (disabled until selection), tax-included switch `#isTaxIncluded`, download template, import Excel, add row, save `#button-submit-create-material-contract`.

Detail columns: description, material code/name, model, manufacturer, origin, unit, volume, unit price, VAT and converted totals.

## Purchase orders

List: `/du-an/{project_id}/vat-tu/don-hang`

- Refresh `#btn-refresh-purchase-order-page`.
- Export, add `#btn-add-purchase-order-page`, search `#input-search-purchase-order-page`.
- Columns: status, order number, supplier, goods type, order date, area, description, stock-in status, expected arrival, pre-VAT value.

Create: `/du-an/{project_id}/vat-tu/don-hang/them`

Fields:

- Required `orderType`, `supplierCode`.
- Optional `supplyContractId`, `estimatedDeliveryDate`, `orderDate`, `description`.
- Detail dimensions: tower, position, work package, phase.
- Detail material data: description, code/name, model, manufacturer, origin, unit, signed/order/norm/outside-norm/lost-cost volumes.
- Value data: converted value, before VAT, VAT rate/value, after VAT.

Actions: add row, select/clear all, delete selected, download template, save.

## Transfer orders

List: `/du-an/{project_id}/vat-tu/lenh-dieu-chuyen`

Controls:

- Refresh `#button-refresh-transfer-order-page`.
- Export `#button-export-transfer-order-page`.
- Create `#button-add-new-transfer-order-page`.
- Search `#input-search-transfer-order-page`.

Columns: status, transfer number/date, description, issue/receive warehouse, stock-in/out slip numbers and statuses.

Create: `/du-an/{project_id}/vat-tu/lenh-dieu-chuyen/them`

Required inputs:

- `#select-ticket-type-transfer-order-form`
- `#date-picker-transfer-date-transfer-order-form`
- `#select-issue-warehouse-transfer-order-form`
- `#select-receive-warehouse-transfer-order-form`

Optional: receive project and description.

Detail actions: select all, clear, delete selected, template download `#button-export-material-transfer-table`, import `#btn-import-material-transfer-table`, add row `#button-add-row-material-transfer-table`, cancel, save.

Columns: material identity, available stock, transfer volume, unit price, amount, issued volume.

## Material review and controls

| Screen | Tabs/actions | Main data |
|---|---|---|
| Norm-volume slips | refresh/create, BOQ/status/tower filters | slip number/status/name, package, description, impact, confirmation date/user |
| Volume review | Main Data; Support & Assembly; refresh/export | Main: slip/status/name/material; Support: typical, assembly, pipe/assembly size, height |
| Excess-order control | four tabs; export | package totals, tower/project material, excess/lost-cost values, temporary unit price |
| Detailed materials/labor | Materials/Labor tabs; export | material/labor codes, full names, project volume, model/manufacturer |
| Project material-cost report | material/slip tabs; display/export | ordered/delivered/pending volume, goods identity, pre-VAT values |

Excess-order tab IDs:

- `#rc-tabs-0-tab-compileByWorkPackage`
- `#rc-tabs-0-tab-compileByTower`
- `#rc-tabs-0-tab-compileByProject`
- `#rc-tabs-0-tab-detailByWorkPackage`

## Catalogs and suppliers

### Loss rates

List columns: loss group, material group/name, size range, loss rate. Actions: export, import, create, inline save, expand, edit, delete.

Create fields:

- Required `name`, `itemGroupCode`, `itemNames`, `rate`.
- Size inputs `sizeForm`, `sizeTo`; hidden/resolved item IDs and names.

### Packaging

List columns: material group/name, manufacturer, unit. Create fields:

- Required material group, unit, material name, manufacturer, packaging type.
- Row columns: area, from/to values, packaging unit, conversion value, action.
- Actions: save, save-and-add, add row.

This catalog is shared even when linked from a project menu; do not save during sandbox research.

### SPEC and code generation

- SPEC catalog redirects to discipline and exposes status, system name/code, description, custom-field, import/export/create/edit/delete.
- Global code generation has settings and attribute-matrix tabs.
- Project code generation has All/Main material/Accessory tabs plus material/group tree and location/package filters.
- Edit actions affect shared or broad catalogs; keep `blocked_by_policy`.

### Suppliers

Project supplier list uses partner columns: status, partner code/name, tax code, address, recipient, payment account.

Create fields mirror partner creation: required tax code, partner code, full name, short/private name; optional address, phone, fax, email, supplied product; customer/subcontractor/supplier/lookup switches; bank-account rows.

Supplier/partner records may be shared beyond one project. Treat create/save/delete as `blocked_by_policy` unless the user explicitly broadens scope.

