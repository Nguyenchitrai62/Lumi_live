# Enterprise screens

## Contents

- [Home and project catalog](#home-and-project-catalog)
- [Create project](#create-project)
- [Company contacts](#company-contacts)
- [Company and project policies](#company-and-project-policies)
- [Account and support](#account-and-support)

## Home and project catalog

Route: `/tong-quan?tab=du-an`

Tabs:

- `Danh mục dự án` → `?tab=du-an`
- `Dashboard` → `?tab=dashboard`; current build displays a placeholder `DashboardTab`.
- `Công việc của tôi` → `?tab=cong-viec`; current build displays a placeholder `TasksTab`.

Controls:

| Control | Selector | Result | Status |
|---|---|---|---|
| Download | exact button `Tải xuống` | Export project catalog | `observed` |
| Import | `#button-import-business-overview-page` | Opens Excel import | `blocked_by_policy` for shared catalog |
| Create project | `#button-create-project-business-overview-page` | Opens `/du-an/them` | `verified` |
| Search | `#input-search-projects-tab` | Filters project cards | `observed` |
| Add filter | `#btn-filter-projects-tab` | Opens project filters | `observed` |
| Grid/list view | adjacent view radio control | Changes presentation only | `observed` |
| Edit card | `#button-edit-projects-grid-view`, scoped to one card | Opens edit action | `blocked_by_policy` for existing projects |
| Pagination | previous/next buttons and page-size combobox | Changes visible page | `observed` |

Project cards contain generated project code, project name, optional location/function, and status. Card IDs follow:

`div-project-card-{project_id}-projects-grid-view`

Never reuse a project ID from documentation. Capture it from a newly created sandbox card.

## Create project

Route: `/du-an/them`

Actions:

- Back: `#button-goback-create-update-project-page`
- Cancel: `#button-cancel-create-update-project-page`
- Save: `#button-save-create-update-project-page`
- Perspective image upload: `#button-perspective-upload-create-update-project-page`
- Construction-order upload: `#button-notice-proceed-upload-create-update-project-page`

Fields:

| Label | Selector | Type | Required |
|---|---|---|---|
| Mã dự án | `#input-project-code-create-update-project-page` | text | No |
| Tên dự án | `#input-project-name-create-update-project-page` | text | Yes |
| Tên viết tắt | `#input-project-short-name-create-update-project-page` | text | No |
| Mã hồ sơ dự án | `#input-document-code-create-update-project-page` | text | No |
| Quốc gia | `#select-country-create-update-project-page` | combobox | No |
| Tỉnh/Thành phố | `#select-state-create-update-project-page` | combobox | No |
| Địa chỉ | `#input-address-create-update-project-page` | text | No |
| Chủ đầu tư | `#input-investor-create-update-project-page` | text | No |
| Chức năng dự án | `#select-project-function-create-update-project-page` | combobox, plus-create option | No |
| Tổng giá trị HĐ sau thuế | `#input-contract-value-create-update-project-page` | number | No |
| Phạm vi công việc | `#select-work-scope-create-update-project-page` | combobox, plus-create option | No |
| Quy mô dự án | `#textarea-project-scale-create-update-project-page` | textarea | No |
| Cấp dự án | `#select-project-level-create-update-project-page` | combobox, plus-create option | No |
| Giám đốc dự án | `#select-project-director-create-update-project-page` | combobox | No |
| Ngày kick-off | `#datepicker-kickoffdate-create-update-project-page` | date | No |
| Thời gian thực hiện | `#range-picker-project-date-create-update-project-page` + end input | date range | No |
| Ảnh phối cảnh | file upload | file | No |
| Lệnh thi công | file upload | file | No |

Verified behavior:

- Empty save marks project name invalid and shows `Hãy nhập thông tin cho trường Tên dự án`.
- Saving only a unique name succeeds, assigns a generated project code, returns to the catalog, and creates an active project.
- Use `LUMI_DISCOVERY_<run-id>`; immediately capture the generated card/project ID and register it as the only mutable project.

## Company contacts

Route: `/danh-ba`

Controls:

- Refresh: `#button-refresh-business-contacts-page`
- Search: `#input-search-business-contacts-page`
- Page-size selector and first/previous/next/last pagination

Columns:

`Mã nhân viên`, `Họ tên`, `Chức vụ`, `Điện thoại`, `Email`, `Ghi chú`.

The table is sensitive. Extract column definitions and aggregate counts only unless the user explicitly requests an authorized person. Never store contact rows in the skill or evidence.

## Company and project policies

Routes: `/chinh-sach` and `/du-an/{project_id}/chinh-sach`.

Tabs and data:

| Tab | Primary action | Columns |
|---|---|---|
| Nhóm tài liệu | `Tạo nhóm tài liệu` | Mã nhóm, Tên nhóm tài liệu, Mô tả, Ngày tạo, Người tạo, Chức năng |
| Danh sách tài liệu | create/upload action appears after tab switch | Mã số, Nhóm tài liệu, Tên tài liệu, Ngày hiệu lực, Người tạo, Chức năng |

Other controls: search by group/document name, page-size, pagination, row functions.

These records are shared company data even when reached through a project path. Inspect only; never save/delete/import during QC discovery.

## Account and support

Account menu from `#avatar-trigger-profile:visible`:

- Identity summary: sensitive; do not persist.
- `Đổi mật khẩu` → `/doi-mat-khau`; fields `currentPassword`, `newPassword`, `confirmPassword`.
- `Cài đặt tài khoản` → `/cai-dat-tai-khoan`; `userName` is disabled, `fullName`/`email`/`phone` editable, department/positions/date disabled.
- `Đăng xuất`: session side effect; require explicit intent.

Notifications open from `.anticon-bell.ant-dropdown-trigger`. Record unread/read state and generic message metadata only; redact content unless requested.

`TRỢ GIÚP` opens `/help?from=<current-path>` in a new tab. The researched build returned an empty ERP shell.

