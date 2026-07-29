# Data dictionary

## Contents

- [Conventions](#conventions)
- [Project and shared data](#project-and-shared-data)
- [BOQ and norm data](#boq-and-norm-data)
- [Material data](#material-data)
- [Labor data](#labor-data)
- [Warehouse data](#warehouse-data)
- [Administrative and report data](#administrative-and-report-data)
- [Sensitive-data rules](#sensitive-data-rules)

## Conventions

- `text`: free text/code.
- `number/spinbutton`: numeric, money, rate, quantity, days, or sequence.
- `date/range`: date or date range; verify displayed locale separately from submitted value.
- `combobox`: lookup/enum; options may depend on preceding fields.
- `checkbox/switch`: boolean or activation state.
- `file`: upload; verify accepted format, size, and post-upload row.
- `*`: required.
- `readonly`: calculated or dependency-controlled.

Do not infer currency, decimal precision, or business rule from a Vietnamese label alone. Record the visible unit/format and assert the rendered value.

## Project and shared data

### Project

| Data | Field/selector | Type | Required |
|---|---|---|---|
| Project code | `input-project-code-create-update-project-page` | text | No/generated when omitted |
| Project name | `input-project-name-create-update-project-page` | text | Yes |
| Short name | `input-project-short-name-create-update-project-page` | text | No |
| Document code | `input-document-code-create-update-project-page` | text | No |
| Country/state | `select-country-*`, `select-state-*` | combobox | No |
| Address/investor | `input-address-*`, `input-investor-*` | text | No |
| Function/scope/level/director | `select-project-*`, `select-work-scope-*` | combobox | No |
| Contract value | `input-contract-value-*` | money/number | No |
| Scale | `textarea-project-scale-*` | textarea | No |
| Kick-off/duration | `datepicker-kickoffdate-*`, `range-picker-project-date-*` | date/range | No |
| Perspective/order | upload buttons | file | No |

Project catalog displays generated code, name, optional location/function, and status.

### Company contacts

Employee code, full name, title, phone, email, note. All row data is sensitive.

### Policy

Document group: group code/name, description, created date/user.

Document: number, group, document name, effective date, creator.

## BOQ and norm data

### Norm views

Dimensions: BOQ type, tower/basement, area, work package, phase, typical.

Items: labor/material codes and names, model, manufacturer, origin, unit, totals. Views: Overview, SHOP, QS, COST, Owner, Reserve.

### BOQ slip

Header: slip number, name, approval batch*, description, status.

Values: total/material/labor/other cost for BOQ and COST 1.0.

Detail: material/labor identities, package/system, VT/NC/other-cost allocations, consolidated code, approved prices.

### Owner slips

Common: actual slip number, acceptance period, acceptance content, system slip number, date, creator.

Value-payment adds total/material/labor value. Quantity-payment links payment-area/quantity data.

## Material data

### Material contract

Header:

- Project*, supplier*, contract number*, sign date*, currency*.
- Contract classes, expiry, goods type, description.
- Before-VAT amount, VAT, exchange rate.
- Advance/payment/warranty-retention rates and lead time.
- Price-hold conditions: days, minimum order value/count, minimum contract value.
- Payment method/account.

Detail:

- Supplier description, material code/name, model, manufacturer, origin, unit.
- Volume, unit price.
- Converted, pre-VAT, VAT-rate, VAT, post-VAT values.

### Purchase order

Header: order type*, supplier*, contract, expected arrival, order date, description, status/stock-in status.

Dimensions: tower*, position*, work package*, phase*.

Detail: material identity and signed/order/norm/outside-norm/lost-cost quantities; VAT values.

### Transfer order

Header: ticket type*, transfer date*, issue warehouse*, receive project, receive warehouse*, description.

Detail: material identity, available stock, transfer/issued volume, unit price, amount.

### Catalogs

- Loss rate: loss group*, material group*, material*, from/to size, rate*.
- Packaging: material group*, unit*, material*, manufacturer*, type*, area, from/to values, packing unit*, conversion value*.
- SPEC: status, system/code, description, custom fields.
- Code generation: object/table, field name, prefix, suffix, separator, material type/group, size/spec/area ranges.
- Supplier: partner identity/tax/contact/bank data.

### Material control/report

Data includes package/tower/material, norm/excess/lost-cost quantity and value, temporary price, ordered/delivered/pending quantity, pre-VAT goods/additional costs.

## Labor data

### Labor contract

Header: project*, subcontractor*, bank*, contract number*, sign date*, summary, currency*, exchange rate, VAT.

Values: before/after VAT, advance, advance deduction and finish milestone, material/installation payment, installation invoice, warranty retention.

Detail: subcontractor description, labor code/name, volume, total/material/labor unit prices, pre-VAT/VAT/post-VAT, material-acceptance flag.

### Subcontractor

Tax code*, partner code*, full/private names*, address, phone, fax, email, supplied product, short name, role switches, bank and contact rows. Treat as shared/sensitive.

### Payment request

Request type*, date*, subcontractor*, labor contract*, payment rate*, VAT, description.

Dimensions: tower*, position, work package, phase, norm payment rate.

Result values: completed before tax, tax, after tax; status.

### Labor controls

Package/subcontractor/labor identities, contract price, norm/paid/excess quantities, excess values.

### Personnel

Employee code/name, phone, email, note, project roles. Sensitive.

## Warehouse data

### Warehouse

Code, name*, type*, active state. Types: material, owner, utility, VT2.

### Stock-in

Header: ticket type*, direct-export boolean, transaction date*, purchase order*, warehouse*, readonly supplier, description.

Detail: order description, material identities, ordered/delivered/pending quantities.

List values: status, slip number/date/name, description, order, supplier, pre-VAT value, creator.

### Stock-out

Header: ticket type*, date*, issue warehouse*, construction subtype*, order, recipient unit*, cost-bearing unit, recipient person, description.

Dimensions: tower*, position*, package*, phase*.

Detail: material identity, total norm, issued, and remaining quantities.

List values: status, slip number/date, area, package/phase, type, recipient.

### Warehouse reports

- Excess issue: subcontractor/package/tower/material, temporary price, excess/lost-cost value.
- Inventory aging: package total value and age buckets; detailed inventory quantities/material identity.
- Cost table: opening/import/issue/closing quantity and value; temporary/fixed/average/contract/approved-COST prices.

## Administrative and report data

- Department: status, code, name, note.
- Title: status, code, name, note.
- Employee: status, code, name, department, title, phone, email.
- Role: module and view/action/manage/default/quantity/value/create/edit/delete/print/import/export/confirm permissions.
- Accounting period: status, closing month/day/date, update date/user, note.
- Rounding: type, min/max, method, threshold, decimal places, note.
- Banner: title, subtitle, button text, link, status, order, image.
- Management report: material/slip identity, dates, order/stock numbers, area/description, ordered/delivered/pending quantity, pre-VAT values.

## Sensitive-data rules

Classify as sensitive: credentials, employee/contact data, tax identifiers, bank accounts, contracts, financial values, supplier/subcontractor identities, project names/IDs, attachments, notification content.

Store only:

- field/column labels;
- selector patterns;
- data types and formats;
- anonymized examples using `LUMI_DISCOVERY_<run-id>`;
- aggregate counts when required.

Redact row values and replace UUIDs with `{project_id}` or `{entity_id}`.

