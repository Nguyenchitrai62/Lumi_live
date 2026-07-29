# Coverage and evidence

## Contents

- [Research baseline](#research-baseline)
- [Verified workflows](#verified-workflows)
- [Observed coverage](#observed-coverage)
- [Known limitations](#known-limitations)
- [Completion checklist](#completion-checklist)

## Research baseline

- Environment: `sit.hawee.hicas.vn`
- Role: current admin account; other role variants `role_unverified`
- Research date: 2026-07-29
- Enterprise menu routes: 28/28 visited
- Project menu routes: 57/57 visited using one owned sandbox
- Project sandbox was retained
- Existing projects were read-only
- Shared/global catalogs were not saved, imported, edited, or deleted

Two discovery passes were used:

1. Static route/control/field/column inventory.
2. Tab, dialog, retry, slow-grid, and representative workflow pass.

The second pass found query-specific tab states for overview and temporary cost tables; these are documented in `navigation.md`.

## Verified workflows

| Workflow | Evidence | Status |
|---|---|---|
| Empty project validation | project-name invalid message | `verified` |
| Minimal sandbox project create | return to catalog, generated code, active card | `verified` |
| Warehouse create | owned row appeared | `verified` |
| Warehouse edit | edit route loaded values; updated row appeared | `verified` |
| Warehouse delete | irreversible dialog, success toast, row absent | `verified` |
| Overview tab switching | URL changed for project/dashboard/tasks | `verified` |
| Norm tabs | Overview, SHOP, QS, COST, Owner, Reserve inspected | `observed` |
| Policy tabs | group and document schemas inspected | `observed` |
| Permission tabs | department, title, employee, role inspected | `observed` |
| Warehouse-type tabs | four stock-in and stock-out tabs inspected | `observed` |
| Control/report tabs | excess order/payment/issue, inventory aging, cost, material report inspected | `observed` |
| Warehouse export click | action dispatched, no visible error | `observed`; file event not independently verified |
| Warehouse import dialog | file/sheet/header controls and disabled submit observed | `verified` |
| Import template download/cancel | actions dispatched and dialog closed | `verified` |
| Help | opened `/help?from=...` in a new tab | `verified`; target page empty |

## Observed coverage

Every documented screen includes:

- route and heading/title;
- tabs;
- main actions and stable IDs where available;
- non-generated form controls;
- AG Grid/table column schema;
- side-effect classification;
- coverage status.

Repeated AG Grid selection checkboxes and pagination instances are represented as patterns rather than listing every generated ID.

Unavailable/placeholder routes were recorded rather than populated with inferred controls.

## Known limitations

| Area | Limitation | Status |
|---|---|---|
| Shared/global writes | Intentionally never confirmed | `blocked_by_policy` |
| Existing project writes | Intentionally never attempted | `blocked_by_policy` |
| Contract/order/payment/stock workflows | Empty sandbox lacked upstream catalogs and partners | `blocked_by_prerequisite` |
| Actual Excel import submission | Template/dialog inspected; no validated workbook submitted | `blocked_by_prerequisite` |
| `/nhan-cong-vat-tu` labor tab | Large grid repeatedly exceeded inspection deadline | `observed_partial` |
| Global code-generation matrix | Large grid intermittently exceeded inspection deadline | `observed_partial` |
| Project subcontractor list | Large grid timed out; create form and navigation were inspected | `observed_partial` |
| Enterprise material-contract list | Heavy grid had intermittent timeout; project list and create form supply its schema | `observed_partial` |
| Dashboard/tasks/help and several overview routes | Current build renders placeholders/empty/404 shell | unavailable |
| Other roles | Only admin surface observed | `role_unverified` |

## Completion checklist

Before relying on this skill after an ERP release:

- [ ] Confirm domain and admin session.
- [ ] Revisit 28 enterprise and 57 project route templates.
- [ ] Compare title, heading, tab set, and stable IDs.
- [ ] Recheck unavailable routes for newly implemented screens.
- [ ] Recheck partial large grids at a smaller page size.
- [ ] Confirm delete dialog and post-save behavior.
- [ ] Confirm import template/schema before any submission.
- [ ] Scan evidence for credentials, real project identifiers, contact data, tax/bank/contract values.
- [ ] Keep all new writes inside a newly registered sandbox.

