# Button and control catalog

## Contents

- [Risk classes](#risk-classes)
- [Global shell](#global-shell)
- [Common list and form controls](#common-list-and-form-controls)
- [Enterprise and project selectors](#enterprise-and-project-selectors)
- [BOQ and materials](#boq-and-materials)
- [Labor and warehouse](#labor-and-warehouse)
- [Administration and reports](#administration-and-reports)
- [Dialogs and verification](#dialogs-and-verification)

## Risk classes

| Class | Examples | Rule |
|---|---|---|
| Read-only | tab, refresh, search, filter, sort, pagination, display report | Execute after observation |
| Local navigation | back, cancel, create-form link, open details | Execute; verify route |
| Reversible sandbox write | create/edit an owned child record | Require owned project and post-verification |
| Destructive sandbox write | delete owned disposable child | Require exact row scope and confirmation |
| Shared/global write | global save/import/create/edit/delete | `blocked_by_policy` |
| Session/security | change password, account save, logout | Require explicit user request |

## Global shell

| Control | Selector | Effect | Status |
|---|---|---|---|
| Project chooser | visible `div[role=button]:has-text("Chọn dự án")` | Selects project context | `observed` |
| Menu/module chooser | `#select-trigger-tool-select` | Opens route matrix | `observed` |
| Global search | `#input-search-main-header` | Searches current context | `observed` |
| Clear search | `.ant-input-clear-icon` | Clears search | `observed` |
| Notifications | `.anticon-bell.ant-dropdown-trigger` | Opens notification dropdown | `observed` |
| Account | `#avatar-trigger-profile:visible` | Account menu | `observed` |
| Help | visible `button:has-text("TRỢ GIÚP")` | Opens `/help?from=...` in new tab | `verified` |

Account menu actions: `Đổi mật khẩu`, `Cài đặt tài khoản`, `Đăng xuất`. Identity text is sensitive and must not be recorded.

## Common list and form controls

| Label/pattern | Selector guidance | Behavior |
|---|---|---|
| Refresh icon | stable ID beginning `button-refresh-` or `btn-refresh-` | Reload grid data |
| Tải xuống / Xuất excel | exact accessible name or stable export ID | Starts file export |
| Nhập dữ liệu từ tệp | exact name or stable import ID | Opens file/import dialog |
| Tải tệp dữ liệu mẫu | exact name | Downloads import template |
| Tạo mới / Thêm mới | exact name or create/add ID | Opens create route/form |
| Lưu | form-specific save ID | Persists form/inline grid |
| Huỷ/Huỷ bỏ | form-specific cancel ID | Discards local form state |
| Back icon | `button-back-*`, `button-goback-*`, or accessible arrow-left | Navigates back |
| Thêm dòng | exact name or `button-add-row-*` | Adds editable detail row |
| Chọn tất cả | exact name | Selects grid rows |
| Bỏ chọn tất cả | exact name | Clears selection |
| Xoá mục đã chọn | exact name | Deletes selected draft rows; disabled with no selection |
| Edit row | row-scoped `#button-edit-row-action-cell-renderer` | Opens edit mode |
| Delete row | row-scoped `#button-delete-row-action-cell-renderer` | Opens irreversible dialog |
| Pagination | `#button-previous-page-pagination-custom`, `#button-next-page-pagination-custom`, first/last menu controls | Changes page |
| Page size | `#select-page-pagination-custom` | Changes rows per page |
| Tab overflow | `#rc-tabs-*-more` or screen-specific `*-more` | Shows hidden tabs |
| Increase/Decrease Value | number-input stepper spans | Adjusts numeric value |
| Plus icon | combobox-adjacent plus | Opens quick-create shared lookup; normally blocked |

AG Grid repeats row action IDs. Scope by a stable owned row marker and `row-index`; never use an unscoped first/last edit or delete button.

## Enterprise and project selectors

| Screen | Control | Stable selector |
|---|---|---|
| Project catalog | Import | `#button-import-business-overview-page` |
| Project catalog | Create project | `#button-create-project-business-overview-page` |
| Project catalog | Search | `#input-search-projects-tab` |
| Project catalog | Filter | `#btn-filter-projects-tab` |
| Project catalog | Edit card | `#button-edit-projects-grid-view`, card-scoped |
| Project form | Back | `#button-goback-create-update-project-page` |
| Project form | Cancel | `#button-cancel-create-update-project-page` |
| Project form | Save | `#button-save-create-update-project-page` |
| Project form | Perspective upload | `#button-perspective-upload-create-update-project-page` |
| Project form | Construction-order upload | `#button-notice-proceed-upload-create-update-project-page` |
| Contacts | Refresh | `#button-refresh-business-contacts-page` |
| Project area | Import | `#button-import-project-site-plan` |
| Project area | Create | `#button-create-project-site-plan` |
| Norms | Refresh/export/typical | `#button-refresh-materials-labor-bill`, `#button-export-materials-labors-bill`, `#button-typical-filter-materials-labors-bill` |

Overview tab IDs: `#rc-tabs-0-tab-du-an`, `#rc-tabs-0-tab-dashboard`, `#rc-tabs-0-tab-cong-viec`.

Verified fast-path controls are limited to the exact route/control pairs below. The
controller must still observe the element and verify the selected tab or post-condition.

| Route | Control | Selector | Verification | Status |
|---|---|---|---|---|
| `/tong-quan?tab=du-an` | Project tab | `#rc-tabs-0-tab-du-an` | URL query and `aria-selected=true` | `verified` |
| `/tong-quan?tab=dashboard` | Dashboard tab | `#rc-tabs-0-tab-dashboard` | URL query and `aria-selected=true` | `verified` |
| `/tong-quan?tab=cong-viec` | Task tab | `#rc-tabs-0-tab-cong-viec` | URL query and `aria-selected=true` | `verified` |
| `/du-an/them` | Validate or save project | `#button-save-create-update-project-page` | validation or owned project card appears | `verified` |

## BOQ and materials

| Screen | Controls |
|---|---|
| BOQ consolidation | Expand all, collapse all, create, search, status/type filter |
| Norm-volume list | `#button-refresh-review-data-catalog`, `#button-create-review-data-catalog` |
| Material contracts | `#button-refresh-material-contracts-page`, `#button-create-material-contracts-page`, `#button-submit-create-material-contract`, `#isTaxIncluded` |
| Purchase orders | `#btn-refresh-purchase-order-page`, `#btn-add-purchase-order-page`, `#input-search-purchase-order-page` |
| Transfer orders | `#button-refresh-transfer-order-page`, `#button-export-transfer-order-page`, `#button-add-new-transfer-order-page` |
| Transfer detail | `#button-export-material-transfer-table`, `#btn-import-material-transfer-table`, `#button-add-row-material-transfer-table` |
| Review data | `#button-refresh-review-table`, `#button-export-review-table` |
| Excess order | export and four tab IDs documented in `materials.md` |
| Loss/packaging catalogs | export, import, create, inline save, edit/delete row, expand |
| Packaging create | `#btn-save-create-update-packaging-page`, `#btn-save-add-create-update-packaging-page`, add row |
| Code generation | `#btn-refresh-code-formula-actions`, `#btn-edit-code-formula-actions` |

Contract/order detail tables also expose select all, clear all, delete selected, template download, import, add row, and save.

## Labor and warehouse

| Screen | Controls |
|---|---|
| Payment requests | `#btn-refresh-payment-request-page`, `#btn-add-payment-request` |
| Overpayment | `#btn-refresh-overpaid-page`, `#button-download-overpaid-page` |
| Project personnel | Import, add personnel, scoped row delete |
| Warehouse list | export, import, create, inline save, scoped edit/delete |
| Warehouse form | `#button-back-kho-create-entity-page`, `#button-cancel-kho-create-entity-page`, `#button-save-kho-create-entity-page`, `#isActive` |
| Stock-in list | `#button-refresh-stock-in`, `#button-add-stock-in`, `#search-input-stock-in` |
| Stock-in create | `#button-export-stock-in-item-table`, `#btn-import-stock-in-item-table`, `#button-save-create-update-stock-in-page` |
| Stock-out list | `#btn-refresh-stock-out-page`, `#btn-add-stock-out-page`, `#input-search-stock-out-page` |
| Inventory aging | `#btn-get-data-inventory-aging-report`, `#btn-export-inventory-aging-report-page` |
| Cost table | `#btn-refresh-table-cost-page` |

Warehouse-type tab IDs contain generated entity IDs. Locate by exact accessible tab name and verify `aria-selected`, not by persisted UUID.

The following warehouse controls were verified only inside a run-created sandbox.
Row actions additionally require an exact owned marker and row-scoped resolution.

| Route | Control | Selector | Verification | Status |
|---|---|---|---|---|
| `/du-an/{project_id}/danh-muc-vat-tu/kho/them` | Save warehouse | `#button-save-kho-create-entity-page` | owned row appears in warehouse list | `verified` |
| `/du-an/{project_id}/danh-muc-vat-tu/kho/{entity_id}` | Save warehouse edit | `#button-save-kho-create-entity-page` | owned row shows updated values | `verified` |
| `/du-an/{project_id}/danh-muc-vat-tu/kho` | Edit owned warehouse row | row-scoped `#button-edit-row-action-cell-renderer` | edit form loads owned values | `verified` |
| `/du-an/{project_id}/danh-muc-vat-tu/kho` | Delete owned disposable row | row-scoped `#button-delete-row-action-cell-renderer` | confirmation, success toast, row absent | `verified` |

## Administration and reports

| Screen | Controls |
|---|---|
| Permissions | export, import, create, inline save, scoped edit/delete |
| Roles | `#btn-add-roles-card`, `#btn-edit-roles-card`, `#btn-delete-roles-card` |
| Detailed material/labor | `#btn-download-labors-and-materials` |
| Project areas | `#switch-edit-mode-project-area`, `#button-refresh-project-area`, `#button-save-project-area` |
| Partner/supplier/subcontractor | role switches, add/delete bank row, save/cancel |
| Accounting period | edit row, inline save |
| Rounding | export/import/create/edit/delete/save |
| Banner | `Thêm mới` |
| Management report | `#btn-get-data-material-cost-report`, `#btn-export-material-cost-report` |

## Dialogs and verification

### Delete

Observed warehouse delete dialog:

- Title: `Thông báo`.
- Warning: action cannot be undone.
- Buttons: `Huỷ`, `Xoá`.
- Post-condition: toast `Xoá thành công` and owned row absent.

Do not click `Xoá` unless the row contains the exact disposable marker and belongs to the current sandbox.

### Import

Warehouse import dialog:

- Close icon, template download, cancel, submit.
- File input for `.xlsx`/`.xls`.
- `#sheetName`, `#headerRowIndex`.
- Submit disabled before file selection.

For every import, inspect workbook schema and preview first; never import into shared/global catalogs under the current policy.
