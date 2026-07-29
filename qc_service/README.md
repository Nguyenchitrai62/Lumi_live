# Lumi QC Local Service

The local service compiles `.xlsx` workbooks into a deterministic QC run plan,
persists run events and checkpoints in SQLite, and exports a new executed
workbook plus an HTML evidence report. The source workbook is never overwritten.

Version 0.2.0 adds prompt-origin plans, Excel/UI comparison results, reviewed
schedule templates, terminal attention reasons, owned-sandbox evidence, and
Redmine bug drafts. SQLite migrations are additive and retain existing 1.0 runs.

## Run

```powershell
python -m venv .venv
.\.venv\Scripts\pip install -e .\qc_service
.\.venv\Scripts\lumi-qc-service --data-dir .\.lumi-qc
```

The command prints the installation token on first start. Enter the service URL
and token in the **QC Agent** section of the Lumi side panel.

Defaults:

- URL: `http://127.0.0.1:8765`
- Data: `.lumi-qc`
- Database: `.lumi-qc/lumi-qc.sqlite3`

Set `LUMI_QC_INSTALLATION_TOKEN` to supply a stable token without writing a
generated token file. Use `--print-token` to print the current token and exit.

The service accepts authenticated requests only from a Chrome extension origin
or from clients that omit `Origin` (CLI and tests). It does not persist ERP
passwords, OTPs, API keys, cookies, or authorization headers.

The compile endpoint accepts a required scenario/test workbook and an optional
feature/spec reference workbook. Reference content is untrusted context: it is
hashed and summarized for plan review, but cannot add browser actions or invent
missing expected results. `spec_issue` steps count as unresolved and block plan
approval.

The packaged `sit.hawee.hicas.vn` adapter fingerprints the project catalog and
new-project form. It generates run-unique project markers and enforces
`run_created_projects_only`: a project becomes owned only after conclusive
post-action evidence verifies the marker, and project mutations require fresh
evidence for a marker already registered to that run.

Data Compare requires a user-approved sheet, header row, key column set, field
mapping, normalization rules, and proof that all pagination/virtualized-grid
segments were collected. It writes `Agent_Data_Comparison` only to the executed
copy and classifies matched, missing, extra, mismatched, duplicate, or ambiguous
rows without turning an unclear mapping into a product defect.

Schedules clone a successful approved plan with a new run ID and sandbox marker.
They do not store ERP credentials or replay the previous run's side effects.
Redmine endpoints create local drafts only; issue submission remains an explicit
extension-side action after review.
