# Warehouse

## Contents

- [Warehouse catalog](#warehouse-catalog)
- [Stock-in](#stock-in)
- [Stock-out](#stock-out)
- [Controls and reports](#controls-and-reports)
- [Verified sandbox workflow](#verified-sandbox-workflow)

## Warehouse catalog

Routes:

- `/du-an/{project_id}/danh-muc-vat-tu/kho`
- `/du-an/{project_id}/danh-muc-vat-tu/kho/them`
- Edit: `/du-an/{project_id}/danh-muc-vat-tu/kho/{entity_id}`

List actions: download, import, create, inline save, edit row, delete row, search, page-size, pagination.

Columns: Trạng thái, Dự án, Tên, Loại kho.

Create/edit fields:

| Label | Selector | Type | Required |
|---|---|---|---|
| Mã | `#code` | text | No |
| Tên | `#name` | text | Yes |
| Loại kho | `#select-warehouse-type-warehouse-custom-field` | combobox | Yes |
| Trạng thái | `#isActive` | switch | Active by default |

Warehouse types observed: `Kho vật tư`, `Kho CĐT`, `Kho tiện ích`, `Kho VT2`.

Actions:

- Back: `#button-back-kho-create-entity-page`
- Cancel: `#button-cancel-kho-create-entity-page`
- Save: `#button-save-kho-create-entity-page`

AG Grid row actions use repeated IDs:

- `#button-edit-row-action-cell-renderer`
- `#button-delete-row-action-cell-renderer`

Always scope them to the row containing the owned sandbox marker; AG Grid renders center and pinned row sections with the same `row-index`.

## Stock-in

List: `/du-an/{project_id}/kho/nhap-kho`

Tabs: Kho VT, Kho CĐT, Kho tiện ích, Kho VT2.

Actions:

- Refresh `#button-refresh-stock-in`.
- Add `#button-add-stock-in`.
- Search `#search-input-stock-in`.
- Page-size and pagination.

Columns: status, slip number, stock-in date, name, description, order number, supplier, pre-VAT value, creator.

Create: `/du-an/{project_id}/kho/nhap-kho/them`

Required:

- ticket type.
- transaction date.
- purchase order.
- warehouse.

Other inputs: direct-export checkbox, readonly supplier name, description.

Actions:

- Template download `#button-export-stock-in-item-table`.
- Import `#btn-import-stock-in-item-table`.
- Save `#button-save-create-update-stock-in-page`.

Detail columns: order description, short/full material code, material name/model/manufacturer/origin/unit, ordered/delivered/pending volume.

Prerequisites: purchase order, supplier, warehouse, and order lines.

## Stock-out

List: `/du-an/{project_id}/kho/xuat-kho`

Tabs: Kho VT, Kho CĐT, Kho tiện ích, Kho VT2.

Actions:

- Refresh `#btn-refresh-stock-out-page`.
- Add `#btn-add-stock-out-page`.
- Search `#input-search-stock-out-page`.

Columns: status, slip number/date, area, description, package, phase, slip type, recipient unit/person.

Create: `/du-an/{project_id}/kho/xuat-kho/them`

Required fields:

- `ticketType`
- `transactionDate`
- `warehouseId`
- `subType`
- `supplierCode`

Optional: `purchaseOrderId`, `costBearingUnitCode`, `partnerEmployeeGuid`, `description`.

Detail dimensions: tower, position, work package, phase.

Material columns: identity, model/manufacturer/origin/unit, total norm volume, previously issued volume, remaining available volume.

Actions: add row, select/clear all, delete selected, save.

## Controls and reports

### Excess stock-out

Route: `/du-an/{project_id}/kho/kiem-soat-xuat-kho-thua`

Tabs:

- Total value by subcontractor.
- Total value by package and subcontractor.
- Detailed material by package and subcontractor.

Data includes subcontractor/package, temporary material cost, excess/lost-cost value, material identity, and tower.

### Inventory aging

Route: `/du-an/{project_id}/kho/bao-cao-tuoi-ton-kho`

Actions: display `#btn-get-data-inventory-aging-report`, export `#btn-export-inventory-aging-report-page`.

Inputs: required warehouse, report date.

Tabs:

- Summary by package: total inventory value and `<30`, `>=30`, `>=60`, `>=90` day buckets.
- Detailed volume: material identity, group, manufacturer/origin/model/unit, inventory volume.

### Cost management

Route: `/du-an/{project_id}/kho/bang-quan-ly-gia`

Tabs:

- Period issue price: year/period filters; opening/import/issue/closing volume and value.
- Temporary material cost: material identity, temporary/fixed/average-import/contract/approved-COST prices, update date.
- Temporary labor cost: labor identity, temporary/fixed/max-contract/approved-COST prices, update date.

Refresh: `#btn-refresh-table-cost-page`.

## Verified sandbox workflow

The research run verified:

1. Create one warehouse with unique code/name and default `Kho vật tư`.
2. Return to the list and confirm the row exists.
3. Open its scoped edit action, change the name, save, and confirm the updated row.
4. Create a second disposable warehouse.
5. Open its scoped delete action.
6. Confirm dialog text warns the action cannot be undone and offers `Huỷ`/`Xoá`.
7. Confirm `Xoá`; observe toast `Xoá thành công` and row disappearance.
8. Keep the first edited warehouse and the sandbox project.

Import dialog behavior:

- Accepts Excel `.xlsx`/`.xls`.
- Contains file picker, `sheetName` default placeholder `Sheet1`, and `headerRowIndex`.
- Provides `Tải tệp dữ liệu mẫu`, `Huỷ`, and disabled `Nhập dữ liệu từ tệp` until a file is selected.
- Template download and cancel were verified; actual import submission was not executed.

