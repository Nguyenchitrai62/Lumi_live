from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import secrets
import tempfile
import uuid
from zipfile import BadZipFile
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from openpyxl.utils.exceptions import InvalidFileException
from openpyxl import Workbook

from .compiler import compile_workbook
from .comparison import compare_actual_rows, read_expected_rows
from .models import (
    ActionAuthorizationInput,
    ActionName,
    Assertion,
    BugDraftInput,
    BugDraftPatch,
    ComparisonActualInput,
    ComparisonFieldMapping,
    CompleteRunInput,
    DataComparisonSpec,
    DiscoveryObservation,
    EvidenceInput,
    EventInput,
    PromptRunInput,
    QcStep,
    RunActionResponse,
    RunPlan,
    ScheduleInput,
    SchedulePatch,
    StepStatus,
    StepMapping,
    StepResult,
    TestCase,
    WritebackTarget,
)
from .reports import generate_artifacts
from .repository import (
    InvalidTransitionError,
    QcRepository,
    RunNotFoundError,
)
from .security import is_allowed_origin, load_or_create_installation_token, redact

MAX_WORKBOOK_BYTES = 50 * 1024 * 1024
MAX_EVIDENCE_BYTES = 8 * 1024 * 1024


class EventBroker:
    def __init__(self) -> None:
        self.connections: dict[str, set[WebSocket]] = defaultdict(set)
        self.lock = asyncio.Lock()

    async def connect(self, run_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self.lock:
            self.connections[run_id].add(websocket)

    async def disconnect(self, run_id: str, websocket: WebSocket) -> None:
        async with self.lock:
            self.connections[run_id].discard(websocket)

    async def publish(self, run_id: str, event: dict[str, Any]) -> None:
        async with self.lock:
            targets = list(self.connections[run_id])
        stale: list[WebSocket] = []
        for target in targets:
            try:
                await target.send_json(event)
            except Exception:
                stale.append(target)
        if stale:
            async with self.lock:
                for target in stale:
                    self.connections[run_id].discard(target)


def create_app(data_dir: Path | str = ".lumi-qc", installation_token: str | None = None) -> FastAPI:
    data_path = Path(data_dir).resolve()
    input_dir = data_path / "inputs"
    output_dir = data_path / "outputs"
    for directory in (data_path, input_dir, output_dir):
        directory.mkdir(parents=True, exist_ok=True)
    token = installation_token or load_or_create_installation_token(data_path)
    repository = QcRepository(data_path / "lumi-qc.sqlite3")
    broker = EventBroker()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield

    app = FastAPI(
        title="Lumi QC Local Service",
        version="0.2.0",
        lifespan=lifespan,
    )
    app.state.repository = repository
    app.state.installation_token = token
    app.state.data_dir = data_path
    app.state.broker = broker
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"chrome-extension://.*",
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Lumi-Installation-Token"],
    )

    @app.middleware("http")
    async def origin_guard(request: Request, call_next):
        if not is_allowed_origin(request.headers.get("origin")):
            return JSONResponse(
                status_code=403,
                content={"detail": "Origin is not allowed."},
            )
        return await call_next(request)

    async def require_token(
        request: Request,
        authorization: str | None = Header(default=None),
        x_lumi_installation_token: str | None = Header(default=None),
    ) -> None:
        origin = request.headers.get("origin")
        if not is_allowed_origin(origin):
            raise HTTPException(status_code=403, detail="Origin is not allowed.")
        supplied = x_lumi_installation_token or ""
        if authorization and authorization.lower().startswith("bearer "):
            supplied = authorization[7:].strip()
        if not supplied or not secrets.compare_digest(supplied, token):
            raise HTTPException(status_code=401, detail="Invalid installation token.")

    def run_or_404(run_id: str) -> dict[str, Any]:
        try:
            return repository.get_run(run_id)
        except RunNotFoundError as error:
            raise HTTPException(status_code=404, detail="Run not found.") from error

    def transition_or_409(run_id: str, action: str) -> tuple[dict[str, Any], str | None]:
        try:
            return repository.transition(run_id, action)
        except RunNotFoundError as error:
            raise HTTPException(status_code=404, detail="Run not found.") from error
        except InvalidTransitionError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "service": "lumi-qc", "version": "0.2.0"}

    @app.post("/v1/workbooks/compile", dependencies=[Depends(require_token)])
    async def compile_endpoint(
        file: UploadFile = File(...),
        reference_file: UploadFile | None = File(default=None),
        allowed_domains: str = Form(default="[]"),
    ) -> dict[str, Any]:
        filename = Path(file.filename or "workbook.xlsx").name
        if Path(filename).suffix.lower() != ".xlsx":
            raise HTTPException(status_code=415, detail="Only .xlsx workbooks are supported.")
        reference_filename = None
        if reference_file is not None:
            reference_filename = Path(reference_file.filename or "reference.xlsx").name
            if Path(reference_filename).suffix.lower() != ".xlsx":
                raise HTTPException(
                    status_code=415,
                    detail="Only .xlsx reference workbooks are supported.",
                )
        try:
            domains = json.loads(allowed_domains)
        except json.JSONDecodeError as error:
            raise HTTPException(status_code=400, detail="allowed_domains must be a JSON array.") from error
        if not isinstance(domains, list) or not all(isinstance(item, str) for item in domains):
            raise HTTPException(status_code=400, detail="allowed_domains must be a JSON string array.")
        size = 0
        reference_temporary_path: Path | None = None
        with tempfile.NamedTemporaryFile(
            dir=data_path,
            suffix=".xlsx",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_WORKBOOK_BYTES:
                    temporary_path.unlink(missing_ok=True)
                    raise HTTPException(status_code=413, detail="Workbook exceeds the 50 MB limit.")
                temporary.write(chunk)
        if reference_file is not None:
            reference_size = 0
            with tempfile.NamedTemporaryFile(
                dir=data_path,
                suffix=".xlsx",
                delete=False,
            ) as reference_temporary:
                reference_temporary_path = Path(reference_temporary.name)
                while chunk := await reference_file.read(1024 * 1024):
                    reference_size += len(chunk)
                    if reference_size > MAX_WORKBOOK_BYTES:
                        reference_temporary_path.unlink(missing_ok=True)
                        temporary_path.unlink(missing_ok=True)
                        raise HTTPException(
                            status_code=413,
                            detail="Reference workbook exceeds the 50 MB limit.",
                        )
                    reference_temporary.write(chunk)
        try:
            plan, persisted_path = compile_workbook(
                temporary_path,
                input_dir,
                domains,
                workbook_name=filename,
                reference_path=reference_temporary_path,
                reference_name=reference_filename,
            )
            run = repository.create_run(plan, persisted_path)
        except (BadZipFile, InvalidFileException, KeyError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        finally:
            temporary_path.unlink(missing_ok=True)
            if reference_temporary_path is not None:
                reference_temporary_path.unlink(missing_ok=True)
        return run

    @app.post("/v1/runs/from-prompt", dependencies=[Depends(require_token)])
    async def create_prompt_run(body: PromptRunInput) -> dict[str, Any]:
        target = urlparse(body.target_url)
        allowed = {domain.strip().lower().rstrip(".") for domain in body.allowed_domains}
        if target.scheme not in {"http", "https"} or not target.hostname:
            raise HTTPException(status_code=422, detail="target_url must be an http or https URL.")
        if target.hostname.lower() not in allowed:
            raise HTTPException(status_code=422, detail="target_url must belong to allowed_domains.")
        run_id = str(uuid.uuid4())
        marker = f"LUMI-QC-{run_id[:8].upper()}"
        test_steps = []
        needs_review = 0
        high_risk = 0
        for index, source_step in enumerate(body.steps, start=1):
            expected = str(redact(source_step.expected)).strip()
            status = StepStatus.PENDING
            if not expected:
                status = StepStatus.NEEDS_REVIEW
                needs_review += 1
            if source_step.risk == "high":
                high_risk += 1
            step_input = (
                "[RUN_MEMORY_CREDENTIAL]"
                if source_step.action == ActionName.LOGIN
                else str(redact(source_step.input)).replace("{{run_marker}}", marker)
            )
            test_steps.append(
                QcStep(
                    id=f"prompt-{index}",
                    order=index,
                    instruction=str(redact(source_step.instruction)),
                    action=source_step.action,
                    target=str(redact(source_step.target)),
                    input=step_input,
                    expected=expected,
                    assertions=[
                        assertion.model_copy(
                            update={
                                "expected": str(redact(assertion.expected)),
                                "target": str(redact(assertion.target)),
                            }
                        )
                        for assertion in source_step.assertions
                    ],
                    writeback=WritebackTarget(sheet="Prompt_Run"),
                    risk=source_step.risk,
                    entity_scope=source_step.entity_scope,
                    status=status,
                    source_row=index + 1,
                )
            )
        source_path = input_dir / f"{run_id}_prompt-run.xlsx"
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "Prompt_Run"
        sheet.append(["Prompt", "Target URL", "Created Run"])
        sheet.append([str(redact(body.prompt)), str(redact(body.target_url)), run_id])
        workbook.save(source_path)
        workbook.close()
        source_sha256 = hashlib.sha256(source_path.read_bytes()).hexdigest()
        plan = RunPlan(
            schema_version="1.1",
            run_id=run_id,
            workbook_name="prompt-run.xlsx",
            source_sha256=source_sha256,
            source_type="prompt",
            knowledge_version=body.knowledge_version,
            target_fingerprint=body.target_fingerprint,
            execution_mode=body.execution_mode,
            allowed_domains=body.allowed_domains,
            test_cases=[
                TestCase(
                    id="PROMPT-1",
                    title=str(redact(body.title)),
                    flow="Prompt QC",
                    steps=test_steps,
                )
            ],
            generated_data={"run_marker": marker},
            warnings=[],
            stats={
                "test_cases": 1,
                "steps": len(test_steps),
                "needs_review": needs_review,
                "high_risk": high_risk,
            },
        )
        return repository.create_run(plan, source_path)

    @app.post("/v1/comparisons/compile", dependencies=[Depends(require_token)])
    async def compile_comparison(
        file: UploadFile = File(...),
        sheet: str = Form(...),
        header_row: int = Form(default=1),
        key_columns: str = Form(...),
        mappings: str = Form(...),
        target_url: str = Form(...),
        allowed_domains: str = Form(default="[]"),
        knowledge_version: str = Form(default=""),
        target_fingerprint: str = Form(default=""),
        execution_mode: str = Form(default="step"),
    ) -> dict[str, Any]:
        filename = Path(file.filename or "comparison.xlsx").name
        if Path(filename).suffix.lower() != ".xlsx":
            raise HTTPException(status_code=415, detail="Only .xlsx workbooks are supported.")
        try:
            parsed_keys = json.loads(key_columns)
            parsed_mappings = [
                ComparisonFieldMapping.model_validate(item)
                for item in json.loads(mappings)
            ]
            domains = json.loads(allowed_domains)
        except (json.JSONDecodeError, ValueError) as error:
            raise HTTPException(
                status_code=400,
                detail="key_columns, mappings, and allowed_domains must be valid JSON.",
            ) from error
        if not isinstance(parsed_keys, list) or not all(
            isinstance(item, str) for item in parsed_keys
        ):
            raise HTTPException(status_code=400, detail="key_columns must be a string array.")
        target = urlparse(target_url)
        normalized_domains = {
            str(domain).strip().lower().rstrip(".") for domain in domains
        }
        if target.hostname is None or target.hostname.lower() not in normalized_domains:
            raise HTTPException(status_code=422, detail="target_url must belong to allowed_domains.")
        with tempfile.NamedTemporaryFile(
            dir=data_path,
            suffix=".xlsx",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            size = 0
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_WORKBOOK_BYTES:
                    temporary_path.unlink(missing_ok=True)
                    raise HTTPException(status_code=413, detail="Workbook exceeds the 50 MB limit.")
                temporary.write(chunk)
        try:
            expected_rows, warnings = read_expected_rows(
                temporary_path,
                sheet,
                header_row,
                parsed_keys,
                parsed_mappings,
            )
            run_id = str(uuid.uuid4())
            persisted_path = input_dir / f"{run_id}_{filename}"
            persisted_path.write_bytes(temporary_path.read_bytes())
            source_sha256 = hashlib.sha256(persisted_path.read_bytes()).hexdigest()
            comparison_id = f"compare-{run_id[:8]}"
            spec = DataComparisonSpec(
                id=comparison_id,
                sheet=sheet,
                header_row=header_row,
                key_columns=parsed_keys,
                mappings=parsed_mappings,
                target_url=target_url,
                expected_rows=expected_rows,
            )
            status = StepStatus.NEEDS_REVIEW if warnings else StepStatus.PENDING
            plan = RunPlan(
                schema_version="1.1",
                run_id=run_id,
                workbook_name=filename,
                source_sha256=source_sha256,
                source_type="workbook_compare",
                knowledge_version=knowledge_version,
                target_fingerprint=target_fingerprint,
                execution_mode=(
                    "fast_verified"
                    if execution_mode == "fast_verified"
                    else "step"
                ),
                allowed_domains=domains,
                test_cases=[
                    TestCase(
                        id="COMPARE-1",
                        title=f"Compare {sheet} with ERP",
                        flow="Data comparison",
                        steps=[
                            QcStep(
                                id=f"{comparison_id}-extract",
                                order=1,
                                instruction=f"Extract all mapped ERP rows and compare with sheet {sheet}.",
                                action=ActionName.EXTRACT,
                                target=target_url,
                                expected=f"{len(expected_rows)} Excel row(s) compared.",
                                assertions=[
                                    Assertion(
                                        kind="table",
                                        operator="exists",
                                        expected=sheet,
                                        target=target_url,
                                    )
                                ],
                                writeback=WritebackTarget(sheet=sheet),
                                status=status,
                                source_row=header_row,
                            )
                        ],
                    )
                ],
                comparison_specs=[spec],
                warnings=warnings,
                stats={
                    "test_cases": 1,
                    "steps": 1,
                    "needs_review": 1 if warnings else 0,
                    "high_risk": 0,
                    "comparison_rows": len(expected_rows),
                },
            )
            return repository.create_run(plan, persisted_path)
        except (InvalidFileException, KeyError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        finally:
            temporary_path.unlink(missing_ok=True)

    @app.get("/v1/runs/{run_id}", dependencies=[Depends(require_token)])
    async def get_run(run_id: str) -> dict[str, Any]:
        return run_or_404(run_id)

    @app.post("/v1/runs/{run_id}/approve", response_model=RunActionResponse, dependencies=[Depends(require_token)])
    async def approve(run_id: str) -> RunActionResponse:
        run, approval_token = transition_or_409(run_id, "approve")
        return RunActionResponse(
            run_id=run_id,
            status=run["status"],
            updated_at=run["updated_at"],
            approval_token=approval_token,
        )

    def action_route(action: str):
        async def route(run_id: str) -> RunActionResponse:
            run, _ = transition_or_409(run_id, action)
            event = repository.append_event(
                run_id,
                f"run_{action}",
                "COMPLETE" if action == "cancel" else "PLAN",
                {"status": run["status"]},
            )
            await broker.publish(run_id, event)
            return RunActionResponse(
                run_id=run_id,
                status=run["status"],
                updated_at=run["updated_at"],
            )
        return route

    app.post("/v1/runs/{run_id}/start", response_model=RunActionResponse, dependencies=[Depends(require_token)])(action_route("start"))
    app.post("/v1/runs/{run_id}/pause", response_model=RunActionResponse, dependencies=[Depends(require_token)])(action_route("pause"))
    app.post("/v1/runs/{run_id}/resume", response_model=RunActionResponse, dependencies=[Depends(require_token)])(action_route("resume"))
    app.post("/v1/runs/{run_id}/cancel", response_model=RunActionResponse, dependencies=[Depends(require_token)])(action_route("cancel"))

    @app.post("/v1/runs/{run_id}/block", dependencies=[Depends(require_token)])
    async def block_run(run_id: str, body: dict[str, Any]) -> dict[str, Any]:
        reason = str(body.get("reason", "")).strip()
        if not reason:
            raise HTTPException(status_code=422, detail="A concrete block reason is required.")
        try:
            run = repository.block_run(run_id, reason)
        except RunNotFoundError as error:
            raise HTTPException(status_code=404, detail="Run not found.") from error
        except InvalidTransitionError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        event = repository.append_event(
            run_id,
            "run_blocked",
            "COMPLETE",
            {"reason": reason},
        )
        await broker.publish(run_id, event)
        return run

    @app.post("/v1/runs/{run_id}/evidence", dependencies=[Depends(require_token)])
    async def save_evidence(run_id: str, body: EvidenceInput) -> dict[str, Any]:
        run_or_404(run_id)
        try:
            payload = base64.b64decode(body.data_base64, validate=True)
        except (binascii.Error, ValueError) as error:
            raise HTTPException(status_code=422, detail="Evidence is not valid base64.") from error
        if len(payload) > MAX_EVIDENCE_BYTES:
            raise HTTPException(status_code=413, detail="Evidence exceeds the 8 MB limit.")
        suffix = ".png" if body.mime_type == "image/png" else ".jpg"
        evidence_dir = output_dir / "evidence" / run_id
        evidence_dir.mkdir(parents=True, exist_ok=True)
        evidence_id = str(uuid.uuid4())
        evidence_path = evidence_dir / f"{evidence_id}{suffix}"
        evidence_path.write_bytes(payload)
        event = repository.append_event(
            run_id,
            "evidence_saved",
            "RECORD",
            {
                "evidence_id": evidence_id,
                "kind": body.kind,
                "path": str(evidence_path),
                "mime_type": body.mime_type,
                "bytes": len(payload),
                "scope": body.scope,
                "url": body.url,
            },
            step_id=body.step_id,
        )
        await broker.publish(run_id, event)
        return {
            "evidence_id": evidence_id,
            "path": str(evidence_path),
            "mime_type": body.mime_type,
            "bytes": len(payload),
        }

    @app.post("/v1/runs/{run_id}/steps/{step_id}/mapping", dependencies=[Depends(require_token)])
    async def update_mapping(run_id: str, step_id: str, mapping: StepMapping) -> dict[str, Any]:
        try:
            return repository.update_step_mapping(run_id, step_id, mapping)
        except RunNotFoundError as error:
            raise HTTPException(status_code=404, detail="Run or step not found.") from error
        except InvalidTransitionError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/v1/runs/{run_id}/steps/{step_id}/begin", dependencies=[Depends(require_token)])
    async def begin_step(run_id: str, step_id: str) -> dict[str, Any]:
        try:
            result = repository.begin_step(run_id, step_id)
        except RunNotFoundError as error:
            raise HTTPException(status_code=404, detail="Run or step not found.") from error
        except InvalidTransitionError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        event = repository.append_event(
            run_id,
            "step_started",
            "OBSERVE",
            {"step": result["step"], "already_recorded": result["already_recorded"]},
            step_id=step_id,
        )
        await broker.publish(run_id, event)
        return result

    @app.post("/v1/runs/{run_id}/steps/{step_id}/approve", dependencies=[Depends(require_token)])
    async def approve_step(run_id: str, step_id: str) -> dict[str, Any]:
        try:
            repository.approve_critical_step(run_id, step_id)
        except RunNotFoundError as error:
            raise HTTPException(status_code=404, detail="Run or step not found.") from error
        except InvalidTransitionError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        event = repository.append_event(
            run_id,
            "critical_step_approved",
            "PLAN",
            {"approved": True},
            step_id=step_id,
        )
        await broker.publish(run_id, event)
        return {"approved": True, "run_id": run_id, "step_id": step_id}

    @app.post("/v1/runs/{run_id}/authorize-action", dependencies=[Depends(require_token)])
    async def authorize_action(run_id: str, body: ActionAuthorizationInput) -> dict[str, Any]:
        return repository.authorize_action(
            run_id,
            body.step_id,
            body.action,
            body.url,
            body.approval_token,
            body.arguments,
        )

    @app.post("/v1/runs/{run_id}/steps/{step_id}/record", dependencies=[Depends(require_token)])
    async def record_step(run_id: str, step_id: str, result: StepResult) -> dict[str, Any]:
        try:
            payload = repository.record_step(run_id, step_id, result)
        except RunNotFoundError as error:
            raise HTTPException(status_code=404, detail="Run not found.") from error
        except InvalidTransitionError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        event = repository.append_event(
            run_id,
            "step_recorded",
            "RECORD",
            payload,
            step_id=step_id,
        )
        await broker.publish(run_id, event)
        return {"recorded": True, "result": payload}

    @app.post("/v1/runs/{run_id}/events", dependencies=[Depends(require_token)])
    async def append_event(run_id: str, event_input: EventInput) -> dict[str, Any]:
        try:
            event = repository.append_event(
                run_id,
                event_input.type,
                event_input.phase,
                event_input.payload,
                event_input.test_case_id,
                event_input.step_id,
            )
        except RunNotFoundError as error:
            raise HTTPException(status_code=404, detail="Run not found.") from error
        except ValueError as error:
            raise HTTPException(status_code=413, detail=str(error)) from error
        await broker.publish(run_id, event)
        return event

    @app.post(
        "/v1/runs/{run_id}/comparisons/{comparison_id}/actual",
        dependencies=[Depends(require_token)],
    )
    async def record_comparison_actual(
        run_id: str,
        comparison_id: str,
        body: ComparisonActualInput,
    ) -> dict[str, Any]:
        run = run_or_404(run_id)
        plan = RunPlan.model_validate(run["plan"])
        spec = next(
            (
                item for item in plan.comparison_specs
                if item.id == comparison_id
            ),
            None,
        )
        if spec is None:
            raise HTTPException(status_code=404, detail="Comparison was not found.")
        expected_step_id = f"{comparison_id}-extract"
        if run["status"] != "running" or run.get("current_step_id") != expected_step_id:
            raise HTTPException(
                status_code=409,
                detail="Begin the approved comparison step before recording UI rows.",
            )
        if not body.complete:
            raise HTTPException(
                status_code=409,
                detail="UI extraction is incomplete; continue pagination before comparison.",
            )
        try:
            result = compare_actual_rows(spec, body.rows)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        result.update(
            {
                "page_count": body.page_count,
                "evidence": body.evidence,
            }
        )
        saved = repository.save_comparison_result(run_id, comparison_id, result)
        event = repository.append_event(
            run_id,
            "comparison_recorded",
            "RECORD",
            {
                "comparison_id": comparison_id,
                "summary": saved.get("summary", {}),
                "page_count": body.page_count,
            },
            step_id=expected_step_id,
        )
        await broker.publish(run_id, event)
        return saved

    def artifacts_for(run_id: str) -> tuple[dict[str, Any], Path, Path]:
        run = run_or_404(run_id)
        plan = RunPlan.model_validate(run["plan"])
        results = repository.list_step_results(run_id)
        xlsx_path, html_path = generate_artifacts(
            plan,
            repository.source_path(run_id),
            results,
            output_dir,
            comparison_results=repository.list_comparison_results(run_id),
            bug_drafts=repository.list_bug_drafts(run_id),
        )
        repository.set_artifacts(run_id, xlsx_path, html_path)
        return run, xlsx_path, html_path

    @app.post("/v1/runs/{run_id}/complete", dependencies=[Depends(require_token)])
    async def complete(run_id: str, body: CompleteRunInput) -> dict[str, Any]:
        missing_steps = repository.missing_step_ids(run_id)
        if missing_steps:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Cannot complete the run: {len(missing_steps)} step(s) have no terminal record. "
                    f"First missing step: {missing_steps[0]}"
                ),
            )
        _, xlsx_path, html_path = artifacts_for(run_id)
        try:
            run = repository.complete(run_id, body.status, body.summary, xlsx_path, html_path)
        except InvalidTransitionError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        event = repository.append_event(
            run_id,
            "run_completed",
            "COMPLETE",
            {"status": run["status"], "summary": body.summary},
        )
        await broker.publish(run_id, event)
        return run

    @app.get("/v1/runs/{run_id}/report", dependencies=[Depends(require_token)])
    async def report(run_id: str, artifact: str = "json"):
        run, xlsx_path, html_path = artifacts_for(run_id)
        if artifact == "xlsx":
            return FileResponse(
                xlsx_path,
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                filename=xlsx_path.name,
            )
        if artifact == "html":
            return FileResponse(html_path, media_type="text/html", filename=html_path.name)
        return {
            "run_id": run_id,
            "status": run["status"],
            "xlsx_name": xlsx_path.name,
            "html_name": html_path.name,
        }

    @app.post("/v1/runs/{run_id}/bug-drafts", dependencies=[Depends(require_token)])
    async def create_bug_draft(run_id: str, body: BugDraftInput) -> dict[str, Any]:
        try:
            if not body.step_id or not repository.bug_draft_eligible(
                run_id,
                body.step_id,
                body.classification,
            ):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "Bug drafts require a reproducible failed_product step after retry "
                        "or repeated frontend/API evidence."
                    ),
                )
            draft = repository.create_bug_draft(
                run_id,
                body.model_dump(mode="json"),
            )
        except RunNotFoundError as error:
            raise HTTPException(status_code=404, detail="Run not found.") from error
        event = repository.append_event(
            run_id,
            "bug_draft_created",
            "RECORD",
            {
                "draft_id": draft["id"],
                "fingerprint": draft["fingerprint"],
                "classification": body.classification,
            },
            step_id=body.step_id,
        )
        await broker.publish(run_id, event)
        return draft

    @app.get("/v1/runs/{run_id}/bug-drafts", dependencies=[Depends(require_token)])
    async def list_bug_drafts(run_id: str) -> list[dict[str, Any]]:
        try:
            return repository.list_bug_drafts(run_id)
        except RunNotFoundError as error:
            raise HTTPException(status_code=404, detail="Run not found.") from error

    @app.patch(
        "/v1/runs/{run_id}/bug-drafts/{draft_id}",
        dependencies=[Depends(require_token)],
    )
    async def patch_bug_draft(
        run_id: str,
        draft_id: str,
        body: BugDraftPatch,
    ) -> dict[str, Any]:
        try:
            return repository.patch_bug_draft(
                run_id,
                draft_id,
                body.model_dump(mode="json", exclude_none=True),
            )
        except RunNotFoundError as error:
            raise HTTPException(status_code=404, detail="Bug draft was not found.") from error

    @app.get("/v1/schedules", dependencies=[Depends(require_token)])
    async def list_schedules() -> list[dict[str, Any]]:
        return repository.list_schedules()

    @app.post("/v1/schedules", dependencies=[Depends(require_token)])
    async def create_schedule(body: ScheduleInput) -> dict[str, Any]:
        try:
            return repository.create_schedule(body.model_dump(mode="json"))
        except RunNotFoundError as error:
            raise HTTPException(status_code=404, detail="Template run was not found.") from error
        except InvalidTransitionError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.get("/v1/schedules/{schedule_id}", dependencies=[Depends(require_token)])
    async def get_schedule(schedule_id: str) -> dict[str, Any]:
        try:
            return repository.get_schedule(schedule_id)
        except RunNotFoundError as error:
            raise HTTPException(status_code=404, detail="Schedule was not found.") from error

    @app.patch("/v1/schedules/{schedule_id}", dependencies=[Depends(require_token)])
    async def patch_schedule(
        schedule_id: str,
        body: SchedulePatch,
    ) -> dict[str, Any]:
        try:
            current = repository.get_schedule(schedule_id)
            merged = {
                key: current[key]
                for key in (
                    "name",
                    "template_run_id",
                    "local_time",
                    "days_of_week",
                    "timezone",
                    "enabled",
                )
            }
            merged.update(body.model_dump(mode="json", exclude_none=True))
            validated = ScheduleInput.model_validate(merged)
            return repository.patch_schedule(
                schedule_id,
                validated.model_dump(mode="json", exclude={"template_run_id"}),
            )
        except RunNotFoundError as error:
            raise HTTPException(status_code=404, detail="Schedule was not found.") from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.delete(
        "/v1/schedules/{schedule_id}",
        dependencies=[Depends(require_token)],
        status_code=204,
    )
    async def delete_schedule(schedule_id: str) -> None:
        try:
            repository.delete_schedule(schedule_id)
        except RunNotFoundError as error:
            raise HTTPException(status_code=404, detail="Schedule was not found.") from error

    @app.post(
        "/v1/schedules/{schedule_id}/run-now",
        dependencies=[Depends(require_token)],
    )
    async def run_schedule_now(schedule_id: str) -> dict[str, Any]:
        try:
            run, approval_token = repository.clone_schedule_run(schedule_id)
        except RunNotFoundError as error:
            raise HTTPException(status_code=404, detail="Schedule was not found.") from error
        except InvalidTransitionError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return {
            "schedule_id": schedule_id,
            "run": run,
            "approval_token": approval_token,
        }

    @app.post("/v1/discovery/observations", dependencies=[Depends(require_token)])
    async def record_discovery(observation: DiscoveryObservation) -> dict[str, Any]:
        try:
            return repository.record_discovery(observation.model_dump(mode="json"))
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.websocket("/v1/runs/{run_id}/events")
    async def events_socket(websocket: WebSocket, run_id: str):
        if not is_allowed_origin(websocket.headers.get("origin")):
            await websocket.close(code=4403)
            return
        supplied = websocket.query_params.get("token", "")
        if supplied != token:
            await websocket.close(code=4401)
            return
        try:
            repository.get_run(run_id, include_events=False)
        except RunNotFoundError:
            await websocket.close(code=4404)
            return
        await broker.connect(run_id, websocket)
        try:
            await websocket.send_json({"type": "connected", "run_id": run_id})
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            await broker.disconnect(run_id, websocket)

    return app
