# Workflows

## Contents

- [Select and classify a project](#select-and-classify-a-project)
- [Create the sandbox project](#create-the-sandbox-project)
- [Operate an existing project safely](#operate-an-existing-project-safely)
- [Warehouse CRUD smoke test](#warehouse-crud-smoke-test)
- [Import and export](#import-and-export)
- [Dependency-driven business flows](#dependency-driven-business-flows)
- [Shared administration](#shared-administration)
- [Recovery](#recovery)

## Select and classify a project

1. Observe the current URL and project chooser.
2. If the URL has `/du-an/{project_id}`, resolve the visible project name.
3. Mark `owned_sandbox` only if name and captured ID match the current run registry.
4. Mark `user_authorized_test` when the user explicitly named this project for the current test workflow and the visible name plus captured ID match that target in the current run.
5. Otherwise mark `existing_or_unknown`.
6. For `existing_or_unknown`, permit only navigation, filtering, viewing, and non-confirming dialogs.

Never infer permission from a project name alone. `owned_sandbox` needs the marker and run-captured ID; `user_authorized_test` needs the user's current-conversation authorization plus the exact visible name and run-captured ID.

## Create the sandbox project

1. Open `/du-an/them`.
2. Verify `#button-save-create-update-project-page` is unique.
3. Optionally submit empty once to record validation; expect only project name required.
4. Fill `LUMI_DISCOVERY_<run-id>` into the name field, unless the user explicitly provides a different test-project name for the current workflow.
5. Save once.
6. Verify return to `/tong-quan?tab=du-an`.
7. Locate the card containing the exact marker.
8. Extract its generated project ID from the card ID and register it in memory only.
9. Never store that UUID in the skill.

## Operate an existing project safely

- Open project and route links for schema discovery.
- Switch tabs, search, filter, sort, paginate, and view reports.
- Open a create form only to inspect fields; do not fill/save if the record is shared or outside the sandbox/user-authorized test project.
- Never click existing project-card edit, inline edit, save, state transition, import, upload, or delete unless it is classified as `user_authorized_test` for the current workflow.
- If a control may autosave, do not focus or change it.

## Warehouse CRUD smoke test

Use the verified sequence from `warehouse.md`:

1. Create `LUMI_DISCOVERY_<run-id>_WH_KEEP`.
2. Verify its row.
3. Edit to append `_EDITED`; verify.
4. Create `LUMI_DISCOVERY_<run-id>_WH_DELETE`.
5. Scope delete to the exact row.
6. Inspect irreversible dialog.
7. Confirm delete; verify toast and absence.
8. Keep the first warehouse and project.

After every save, verify the list because the create/edit form may remain open and clear its inputs rather than navigate.

## Import and export

### Export

1. Observe exact current project/route/filter.
2. Click the screen's export/download action.
3. Verify a download event or a newly created file through the browser-supported download surface.
4. Do not infer success solely from the absence of an error toast.

### Import

1. Ensure the target is project-scoped and owned.
2. Open import dialog.
3. Download the screen-specific template.
4. Validate extension, sheet name, header row, column names, and sample rows offline.
5. Redact credentials and real business values.
6. Upload only a file whose rows use the run marker.
7. Review preview/count before submit.
8. Submit once and verify created rows.

Warehouse template download and dialog cancellation were verified. Actual file submission remains `blocked_by_prerequisite`; do not claim full import verification.

## Dependency-driven business flows

Use this dependency order:

1. Project area/tower.
2. Work packages and phases.
3. Project personnel/supplier/subcontractor assignments.
4. Norm-volume and material/labor definitions.
5. Material/labor contracts.
6. Purchase order or labor payment request.
7. Stock-in.
8. Stock-out or transfer.
9. Acceptance/payment and management reports.

If a required upstream object is absent, mark the downstream flow `blocked_by_prerequisite`. Do not create shared partner/catalog data to bypass the block.

## Shared administration

For permissions, partners, policies, accounting, rounding, banners, global code generation, packaging, and loss rates:

1. Observe route, tabs, controls, fields, columns, disabled state, and dialog.
2. Trigger client validation only if the form has an explicit save and no autosave.
3. Cancel without saving.
4. Mark write actions `blocked_by_policy`.

## Recovery

- Route changed unexpectedly: stop, capture URL/heading, return to the last verified route.
- Selector count not equal to one: refresh snapshot; use a scoped stable alternative; otherwise stop.
- Slow/large AG Grid: use a light structural read, reduce page size, or document `observed_partial`; never fall back to row-content scraping.
- Save result unclear: check toast, route, and exact owned row before retrying. Do not repeat a possible side effect blindly.
- Session expired: request sign-in in the existing Chrome session; never store credentials.
