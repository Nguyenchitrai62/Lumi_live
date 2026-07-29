from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class RunStatus(StrEnum):
    DRAFT = "draft"
    APPROVED = "approved"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"
    BLOCKED = "blocked"


class StepStatus(StrEnum):
    PENDING = "pending"
    PASSED = "passed"
    FAILED_PRODUCT = "failed_product"
    SPEC_ISSUE = "spec_issue"
    BLOCKED = "blocked"
    NEEDS_REVIEW = "needs_review"
    SKIPPED = "skipped"


class ActionName(StrEnum):
    NAVIGATE = "navigate"
    CLICK = "click"
    FILL = "fill"
    SELECT = "select"
    CHECK = "check"
    UPLOAD = "upload"
    DOWNLOAD = "download"
    WAIT = "wait"
    EXTRACT = "extract"
    ASSERT = "assert"
    GENERATE = "generate"
    LOGIN = "login"


class Assertion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal[
        "text",
        "value",
        "visible",
        "enabled",
        "checked",
        "url",
        "toast",
        "modal",
        "validation",
        "table",
        "count",
        "download",
        "vision",
    ] = "text"
    operator: Literal[
        "equals",
        "contains",
        "matches",
        "exists",
        "not_exists",
        "gte",
        "lte",
    ] = "contains"
    expected: str = ""
    target: str = ""


class WritebackTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sheet: str
    status_cell: str | None = None
    actual_cell: str | None = None
    evidence_cell: str | None = None


class QcStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    order: int
    instruction: str
    action: ActionName
    target: str = ""
    input: str = ""
    expected: str = ""
    assertions: list[Assertion] = Field(default_factory=list)
    writeback: WritebackTarget
    risk: Literal["none", "ordinary", "high"] = "none"
    entity_scope: Literal["none", "project_create", "owned_project"] = "none"
    skill_record: str = Field(default="", max_length=500)
    coverage_status: str = Field(default="", max_length=80)
    status: StepStatus = StepStatus.PENDING
    source_row: int
    retry_policy: dict[str, int] = Field(
        default_factory=lambda: {
            "same_locator": 2,
            "selector_recovery": 1,
            "vision_fallback": 1,
        }
    )


class TestCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    flow: str = ""
    precondition: str = ""
    steps: list[QcStep]


class ReferenceWorkbookSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    source_sha256: str
    sheets: list[str] = Field(default_factory=list)
    stats: dict[str, int] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class EntityPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["run_created_projects_only"]
    domain: str
    project_markers: list[str] = Field(default_factory=list)


class RunPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1.0", "1.1"] = "1.1"
    run_id: str
    workbook_name: str
    source_sha256: str
    source_type: Literal["prompt", "workbook_scenario", "workbook_compare"] = "workbook_scenario"
    knowledge_version: str = ""
    target_fingerprint: str = ""
    execution_mode: Literal["step", "fast_verified"] = "step"
    allowed_domains: list[str] = Field(default_factory=list)
    test_cases: list[TestCase]
    comparison_specs: list["DataComparisonSpec"] = Field(default_factory=list)
    reference_workbooks: list[ReferenceWorkbookSummary] = Field(default_factory=list)
    entity_policy: EntityPolicy | None = None
    generated_data: dict[str, str] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    stats: dict[str, int] = Field(default_factory=dict)

    @field_validator("allowed_domains")
    @classmethod
    def normalize_domains(cls, value: list[str]) -> list[str]:
        domains: list[str] = []
        for item in value:
            domain = item.strip().lower().rstrip(".")
            if domain and domain not in domains:
                domains.append(domain)
        return domains


class RunActionResponse(BaseModel):
    run_id: str
    status: RunStatus
    updated_at: str
    approval_token: str | None = None


class StepMapping(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: ActionName
    target: str = Field(max_length=1000)
    input: str = Field(default="", max_length=4000)
    assertions: list[Assertion] = Field(default_factory=list, max_length=12)
    risk: Literal["none", "ordinary", "high"] = "none"
    entity_scope: Literal["none", "project_create", "owned_project"] = "none"


class StepResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: StepStatus
    actual: str = Field(default="", max_length=12000)
    expected: str = Field(default="", max_length=12000)
    evidence: str = Field(default="", max_length=16000)
    url: str = Field(default="", max_length=4000)
    locator: str = Field(default="", max_length=4000)
    confidence: float | None = Field(default=None, ge=0, le=1)
    screenshot_path: str = Field(default="", max_length=4000)
    console_errors: list[str] = Field(default_factory=list, max_length=40)
    network_errors: list[str] = Field(default_factory=list, max_length=40)
    retry_count: int = Field(default=0, ge=0, le=10)
    timings: dict[str, float] = Field(default_factory=dict)
    execution_mode: Literal["step", "fast_verified"] = "step"


class EventInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str = Field(min_length=1, max_length=120)
    phase: Literal[
        "PLAN",
        "OBSERVE",
        "ACT",
        "STABILIZE",
        "VERIFY",
        "RECORD",
        "RECOVER",
        "COMPLETE",
    ]
    test_case_id: str = Field(default="", max_length=300)
    step_id: str = Field(default="", max_length=300)
    payload: dict[str, Any] = Field(default_factory=dict)


class ActionAuthorizationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    step_id: str
    action: str
    url: str
    approval_token: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class CompleteRunInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["completed", "failed"] = "completed"
    summary: str = Field(default="", max_length=12000)


class PromptPlanStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    instruction: str = Field(min_length=1, max_length=4000)
    action: ActionName
    target: str = Field(default="", max_length=1000)
    input: str = Field(default="", max_length=4000)
    expected: str = Field(default="", max_length=4000)
    assertions: list[Assertion] = Field(default_factory=list, max_length=12)
    risk: Literal["none", "ordinary", "high"] = "none"
    entity_scope: Literal["none", "project_create", "owned_project"] = "none"
    skill_record: str = Field(default="", max_length=500)
    coverage_status: str = Field(default="", max_length=80)


class PromptRunInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(min_length=1, max_length=12000)
    title: str = Field(default="Prompt QC run", max_length=300)
    target_url: str = Field(max_length=4000)
    target_fingerprint: str = Field(default="", max_length=500)
    knowledge_version: str = Field(default="", max_length=120)
    allowed_domains: list[str] = Field(default_factory=list, max_length=20)
    execution_mode: Literal["step", "fast_verified"] = "step"
    steps: list[PromptPlanStep] = Field(min_length=1, max_length=100)


class ComparisonFieldMapping(BaseModel):
    model_config = ConfigDict(extra="forbid")

    excel_column: str = Field(min_length=1, max_length=300)
    ui_field: str = Field(min_length=1, max_length=500)
    value_type: Literal[
        "text", "number", "currency", "percentage", "date", "status", "enum"
    ] = "text"
    case_sensitive: bool = True
    tolerance: float = Field(default=0, ge=0)
    displayed_precision: int | None = Field(default=None, ge=0, le=12)


class DataComparisonSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    sheet: str
    header_row: int = Field(ge=1)
    key_columns: list[str] = Field(min_length=1, max_length=12)
    mappings: list[ComparisonFieldMapping] = Field(min_length=1, max_length=200)
    target_url: str = Field(max_length=4000)
    expected_rows: list[dict[str, Any]] = Field(default_factory=list)


class ComparisonActualInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rows: list[dict[str, Any]] = Field(default_factory=list, max_length=100000)
    complete: bool = True
    page_count: int = Field(default=1, ge=1, le=10000)
    evidence: str = Field(default="", max_length=16000)


class EvidenceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    step_id: str = Field(default="", max_length=300)
    kind: Literal["terminal_screenshot", "step_screenshot"] = "terminal_screenshot"
    mime_type: Literal["image/png", "image/jpeg"]
    data_base64: str = Field(min_length=1, max_length=14_000_000)
    scope: Literal["owned_sandbox"]
    url: str = Field(default="", max_length=4000)


class ScheduleInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=300)
    template_run_id: str
    local_time: str = Field(pattern=r"^\d{2}:\d{2}$")
    days_of_week: list[int] = Field(min_length=1, max_length=7)
    timezone: str = Field(default="Asia/Bangkok", max_length=100)
    enabled: bool = True

    @field_validator("days_of_week")
    @classmethod
    def validate_days(cls, value: list[int]) -> list[int]:
        normalized = sorted(set(value))
        if not all(0 <= item <= 6 for item in normalized):
            raise ValueError("days_of_week values must be between 0 and 6.")
        return normalized

    @field_validator("local_time")
    @classmethod
    def validate_time(cls, value: str) -> str:
        hour, minute = (int(part) for part in value.split(":"))
        if hour > 23 or minute > 59:
            raise ValueError("local_time must be a valid 24-hour time.")
        return value


class SchedulePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=300)
    local_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    days_of_week: list[int] | None = Field(default=None, min_length=1, max_length=7)
    timezone: str | None = Field(default=None, max_length=100)
    enabled: bool | None = None


class BugDraftInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    step_id: str = Field(default="", max_length=300)
    module: str = Field(default="", max_length=300)
    subject: str = Field(min_length=1, max_length=500)
    description: str = Field(min_length=1, max_length=30000)
    classification: Literal["failed_product", "frontend_error", "api_error"]
    url: str = Field(default="", max_length=4000)
    expected: str = Field(default="", max_length=12000)
    actual: str = Field(default="", max_length=12000)
    evidence: str = Field(default="", max_length=16000)
    screenshot_path: str = Field(default="", max_length=4000)
    confidence: float | None = Field(default=None, ge=0, le=1)


class BugDraftPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(default="", max_length=200)
    tracker_id: int | None = Field(default=None, ge=1)
    priority_id: int | None = Field(default=None, ge=1)
    assigned_to_id: int | None = Field(default=None, ge=1)
    subject: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = Field(default=None, min_length=1, max_length=30000)
    submitted_issue_id: int | None = Field(default=None, ge=1)
    submitted_issue_url: str = Field(default="", max_length=4000)


class DiscoveryObservation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str = Field(max_length=4000)
    title: str = Field(default="", max_length=1000)
    tool: str = Field(max_length=200)
    arguments: dict[str, Any] = Field(default_factory=dict)
    observation: dict[str, Any] = Field(default_factory=dict)


RunPlan.model_rebuild()
