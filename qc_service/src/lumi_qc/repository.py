from __future__ import annotations

import json
import hashlib
import re
import secrets
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlparse

from .models import RunPlan, RunStatus, StepMapping, StepResult, StepStatus
from .security import sanitized_json, token_hash


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


class RunNotFoundError(KeyError):
    pass


class InvalidTransitionError(ValueError):
    pass


class QcRepository:
    def __init__(self, database_path: Path):
        self.database_path = database_path
        self._lock = threading.RLock()
        self._initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            journal_cursor = connection.execute("PRAGMA journal_mode = WAL")
            journal_cursor.fetchone()
            journal_cursor.close()
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    workbook_name TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    source_sha256 TEXT NOT NULL,
                    plan_json TEXT NOT NULL,
                    approval_token_hash TEXT,
                    current_step_id TEXT,
                    summary TEXT NOT NULL DEFAULT '',
                    attention_reason TEXT NOT NULL DEFAULT '',
                    output_xlsx_path TEXT,
                    output_html_path TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    event_type TEXT NOT NULL,
                    phase TEXT NOT NULL,
                    test_case_id TEXT NOT NULL DEFAULT '',
                    step_id TEXT NOT NULL DEFAULT '',
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS step_results (
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    step_id TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (run_id, step_id)
                );
                CREATE TABLE IF NOT EXISTS critical_approvals (
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    step_id TEXT NOT NULL,
                    approved_at TEXT NOT NULL,
                    PRIMARY KEY (run_id, step_id)
                );
                CREATE TABLE IF NOT EXISTS owned_projects (
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    marker TEXT NOT NULL,
                    project_id TEXT,
                    created_step_id TEXT NOT NULL,
                    registered_at TEXT NOT NULL,
                    PRIMARY KEY (run_id, marker)
                );
                CREATE TABLE IF NOT EXISTS locator_candidates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    domain TEXT NOT NULL,
                    page_fingerprint TEXT NOT NULL,
                    field_name TEXT NOT NULL,
                    locator_json TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    verified_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS adapter_pages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    domain TEXT NOT NULL,
                    page_fingerprint TEXT NOT NULL,
                    page_name TEXT NOT NULL,
                    catalog_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(domain, page_fingerprint)
                );
                CREATE TABLE IF NOT EXISTS run_templates (
                    id TEXT PRIMARY KEY,
                    source_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
                    plan_json TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS schedules (
                    id TEXT PRIMARY KEY,
                    template_id TEXT NOT NULL REFERENCES run_templates(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    local_time TEXT NOT NULL,
                    days_json TEXT NOT NULL,
                    timezone TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    last_run_at TEXT,
                    last_status TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS comparison_results (
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    comparison_id TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (run_id, comparison_id)
                );
                CREATE TABLE IF NOT EXISTS bug_drafts (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    fingerprint TEXT NOT NULL,
                    draft_json TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'draft',
                    submitted_issue_id INTEGER,
                    submitted_issue_url TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )
            columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(runs)").fetchall()
            }
            if "attention_reason" not in columns:
                connection.execute(
                    "ALTER TABLE runs ADD COLUMN attention_reason TEXT NOT NULL DEFAULT ''"
                )

    def create_run(self, plan: RunPlan, source_path: Path) -> dict[str, Any]:
        timestamp = now_iso()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO runs (
                    id, status, workbook_name, source_path, source_sha256,
                    plan_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    plan.run_id,
                    RunStatus.DRAFT.value,
                    plan.workbook_name,
                    str(source_path),
                    plan.source_sha256,
                    sanitized_json(plan.model_dump(mode="json")),
                    timestamp,
                    timestamp,
                ),
            )
        return self.get_run(plan.run_id)

    def block_run(self, run_id: str, reason: str) -> dict[str, Any]:
        with self._connect() as connection:
            current = self._status(connection, run_id)
            if current not in {
                RunStatus.APPROVED.value,
                RunStatus.RUNNING.value,
                RunStatus.PAUSED.value,
            }:
                raise InvalidTransitionError(f"Cannot block a run in '{current}' state.")
            connection.execute(
                """
                UPDATE runs
                SET status = ?, attention_reason = ?, current_step_id = NULL, updated_at = ?
                WHERE id = ?
                """,
                (RunStatus.BLOCKED.value, reason[:4000], now_iso(), run_id),
            )
        return self.get_run(run_id)

    def get_run(self, run_id: str, include_events: bool = True) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            if not row:
                raise RunNotFoundError(run_id)
            result = {
                "run_id": row["id"],
                "status": row["status"],
                "workbook_name": row["workbook_name"],
                "source_sha256": row["source_sha256"],
                "plan": json.loads(row["plan_json"]),
                "current_step_id": row["current_step_id"],
                "summary": row["summary"],
                "attention_reason": row["attention_reason"],
                "artifacts": {
                    "xlsx": row["output_xlsx_path"],
                    "html": row["output_html_path"],
                },
                "owned_projects": [
                    {
                        "marker": project["marker"],
                        "project_id": project["project_id"],
                        "created_step_id": project["created_step_id"],
                        "registered_at": project["registered_at"],
                    }
                    for project in connection.execute(
                        """
                        SELECT marker, project_id, created_step_id, registered_at
                        FROM owned_projects
                        WHERE run_id = ?
                        ORDER BY registered_at
                        """,
                        (run_id,),
                    )
                ],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            if include_events:
                result["events"] = [
                    {
                        "id": event["id"],
                        "type": event["event_type"],
                        "phase": event["phase"],
                        "test_case_id": event["test_case_id"],
                        "step_id": event["step_id"],
                        "payload": json.loads(event["payload_json"]),
                        "created_at": event["created_at"],
                    }
                    for event in connection.execute(
                        "SELECT * FROM events WHERE run_id = ? ORDER BY id",
                        (run_id,),
                    )
                ]
            return result

    def _status(self, connection: sqlite3.Connection, run_id: str) -> str:
        row = connection.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not row:
            raise RunNotFoundError(run_id)
        return row["status"]

    def transition(self, run_id: str, action: str) -> tuple[dict[str, Any], str | None]:
        transitions = {
            ("draft", "approve"): "approved",
            ("approved", "start"): "running",
            ("running", "pause"): "paused",
            ("paused", "resume"): "running",
            ("approved", "cancel"): "cancelled",
            ("running", "cancel"): "cancelled",
            ("paused", "cancel"): "cancelled",
        }
        approval_token: str | None = None
        with self._lock, self._connect() as connection:
            current = self._status(connection, run_id)
            target = transitions.get((current, action))
            if not target:
                raise InvalidTransitionError(f"Cannot {action} a run in '{current}' state.")
            timestamp = now_iso()
            if action == "approve":
                plan_row = connection.execute(
                    "SELECT plan_json FROM runs WHERE id = ?",
                    (run_id,),
                ).fetchone()
                plan = RunPlan.model_validate_json(plan_row["plan_json"])
                if not plan.allowed_domains:
                    raise InvalidTransitionError(
                        "Add at least one allowed ERP domain before approving the run."
                    )
                if int(plan.stats.get("needs_review", 0)) > 0:
                    raise InvalidTransitionError(
                        "Resolve or explicitly classify every needs_review step before approval."
                    )
                approval_token = secrets.token_urlsafe(32)
                connection.execute(
                    """
                    UPDATE runs
                    SET status = ?, approval_token_hash = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (target, token_hash(approval_token), timestamp, run_id),
                )
            else:
                connection.execute(
                    "UPDATE runs SET status = ?, updated_at = ? WHERE id = ?",
                    (target, timestamp, run_id),
                )
        return self.get_run(run_id), approval_token

    def update_step_mapping(self, run_id: str, step_id: str, mapping: StepMapping) -> dict[str, Any]:
        with self._lock, self._connect() as connection:
            if self._status(connection, run_id) != RunStatus.DRAFT.value:
                raise InvalidTransitionError("Step mappings can change only while the run is draft.")
            row = connection.execute("SELECT plan_json FROM runs WHERE id = ?", (run_id,)).fetchone()
            plan = RunPlan.model_validate_json(row["plan_json"])
            found = False
            for case in plan.test_cases:
                for step in case.steps:
                    if step.id != step_id:
                        continue
                    step.action = mapping.action
                    step.target = mapping.target
                    step.input = mapping.input
                    step.assertions = mapping.assertions
                    step.risk = mapping.risk
                    step.entity_scope = mapping.entity_scope
                    step.status = (
                        "pending"
                        if step.expected and mapping.assertions
                        else "needs_review"
                    )
                    found = True
            if not found:
                raise RunNotFoundError(f"{run_id}/{step_id}")
            plan.stats["needs_review"] = sum(
                step.status in {"needs_review", "spec_issue"}
                for case in plan.test_cases
                for step in case.steps
            )
            plan.stats["spec_issue"] = sum(
                step.status == "spec_issue"
                for case in plan.test_cases
                for step in case.steps
            )
            plan.stats["high_risk"] = sum(
                step.risk == "high"
                for case in plan.test_cases
                for step in case.steps
            )
            connection.execute(
                "UPDATE runs SET plan_json = ?, updated_at = ? WHERE id = ?",
                (sanitized_json(plan.model_dump(mode="json")), now_iso(), run_id),
            )
        return self.get_run(run_id)

    def begin_step(self, run_id: str, step_id: str) -> dict[str, Any]:
        with self._lock, self._connect() as connection:
            if self._status(connection, run_id) != RunStatus.RUNNING.value:
                raise InvalidTransitionError("A step can begin only while the run is running.")
            row = connection.execute("SELECT plan_json FROM runs WHERE id = ?", (run_id,)).fetchone()
            plan = RunPlan.model_validate_json(row["plan_json"])
            ordered_steps = [
                item
                for case in plan.test_cases
                for item in case.steps
            ]
            step = next(
                (
                    step
                    for case in plan.test_cases
                    for step in case.steps
                    if step.id == step_id
                ),
                None,
            )
            if not step:
                raise RunNotFoundError(f"{run_id}/{step_id}")
            prior_result = connection.execute(
                "SELECT result_json FROM step_results WHERE run_id = ? AND step_id = ?",
                (run_id, step_id),
            ).fetchone()
            recorded_ids = {
                result_row["step_id"]
                for result_row in connection.execute(
                    "SELECT step_id FROM step_results WHERE run_id = ?",
                    (run_id,),
                )
            }
            first_pending = next(
                (item for item in ordered_steps if item.id not in recorded_ids),
                None,
            )
            if prior_result:
                return {
                    "step": step.model_dump(mode="json"),
                    "already_recorded": json.loads(prior_result["result_json"]),
                    "requires_user_approval": False,
                    "must_verify_before_action": False,
                }
            if first_pending and first_pending.id != step_id:
                raise InvalidTransitionError(
                    f"QC runs are sequential. The next unrecorded step is '{first_pending.id}'."
                )
            completed_action_event = None
            for event_row in connection.execute(
                """
                SELECT payload_json FROM events
                WHERE run_id = ? AND step_id = ? AND event_type = 'browser_action_completed'
                ORDER BY id DESC
                """,
                (run_id, step_id),
            ):
                event_payload = json.loads(event_row["payload_json"])
                if event_payload.get("tool") != "browser_scroll":
                    completed_action_event = event_payload
                    break
            critical = connection.execute(
                "SELECT 1 FROM critical_approvals WHERE run_id = ? AND step_id = ?",
                (run_id, step_id),
            ).fetchone()
            connection.execute(
                "UPDATE runs SET current_step_id = ?, updated_at = ? WHERE id = ?",
                (step_id, now_iso(), run_id),
            )
            return {
                "step": step.model_dump(mode="json"),
                "already_recorded": None,
                "requires_user_approval": step.risk == "high" and not bool(critical),
                "must_verify_before_action": bool(completed_action_event),
                "resume_evidence": completed_action_event,
            }

    def approve_critical_step(self, run_id: str, step_id: str) -> None:
        with self._connect() as connection:
            if self._status(connection, run_id) not in {
                RunStatus.RUNNING.value,
                RunStatus.PAUSED.value,
            }:
                raise InvalidTransitionError("Critical approval requires a running or paused run.")
            connection.execute(
                """
                INSERT INTO critical_approvals (run_id, step_id, approved_at)
                VALUES (?, ?, ?)
                ON CONFLICT(run_id, step_id) DO UPDATE SET approved_at = excluded.approved_at
                """,
                (run_id, step_id, now_iso()),
            )

    def authorize_action(
        self,
        run_id: str,
        step_id: str,
        action: str,
        url: str,
        approval_token: str,
        arguments: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        from urllib.parse import urlparse

        action_map = {
            "navigate": {"browser_open_tab", "browser_switch_tab"},
            "click": {"browser_click"},
            "fill": {"browser_input_text"},
            "select": {"browser_select_option", "browser_click"},
            "check": {"browser_click"},
            "upload": {"browser_upload_file"},
            "download": {"browser_click"},
            "wait": {"browser_wait_for_page_state"},
            "extract": {"browser_get_page_state", "browser_find_semantic_context"},
            "assert": {
                "browser_get_page_state",
                "browser_find_semantic_context",
                "browser_wait_for_page_state",
                "browser_inspect_screenshot",
            },
            "generate": {"browser_input_text"},
            "login": {"browser_input_text", "browser_click"},
        }
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            if not row:
                raise RunNotFoundError(run_id)
            if row["status"] != RunStatus.RUNNING.value:
                return {"authorized": False, "reason": "run_not_running"}
            if row["current_step_id"] != step_id:
                return {"authorized": False, "reason": "step_not_active"}
            if not row["approval_token_hash"] or not secrets.compare_digest(
                row["approval_token_hash"], token_hash(approval_token)
            ):
                return {"authorized": False, "reason": "invalid_approval_token"}
            plan = RunPlan.model_validate_json(row["plan_json"])
            step = next(
                (
                    item
                    for case in plan.test_cases
                    for item in case.steps
                    if item.id == step_id
                ),
                None,
            )
            if not step or (
                action not in action_map.get(step.action.value, set())
                and action != "browser_scroll"
            ):
                return {"authorized": False, "reason": "action_outside_plan"}
            host = (urlparse(url).hostname or "").lower()
            if plan.allowed_domains and not any(
                host == domain or host.endswith(f".{domain}")
                for domain in plan.allowed_domains
            ):
                return {"authorized": False, "reason": "domain_outside_plan"}
            if plan.entity_policy and (
                host == plan.entity_policy.domain
                or host.endswith(f".{plan.entity_policy.domain}")
            ):
                parsed_url = urlparse(url)
                path = parsed_url.path.rstrip("/") or "/"
                evidence_row = connection.execute(
                    """
                    SELECT payload_json FROM events
                    WHERE run_id = ?
                      AND event_type IN (
                        'browser_observation_completed',
                        'browser_action_completed'
                      )
                    ORDER BY id DESC
                    LIMIT 1
                    """,
                    (run_id,),
                ).fetchone()
                latest_evidence = evidence_row["payload_json"] if evidence_row else ""
                supplied_arguments = arguments or {}
                if step.entity_scope == "project_create":
                    if action in {"browser_open_tab", "browser_switch_tab"}:
                        target_url = str(supplied_arguments.get("url", ""))
                        target = urlparse(target_url)
                        if (
                            target.hostname != plan.entity_policy.domain
                            or target.path.rstrip("/") != "/du-an/them"
                        ):
                            return {
                                "authorized": False,
                                "reason": "project_create_route_required",
                            }
                    elif action == "browser_input_text":
                        if (
                            step.target == "#input-project-name-create-update-project-page"
                            and str(supplied_arguments.get("text", "")) != step.input
                        ):
                            return {
                                "authorized": False,
                                "reason": "run_project_marker_required",
                            }
                    elif (
                        action == "browser_click"
                        and step.target == "#button-save-create-update-project-page"
                    ):
                        if path != "/du-an/them" or step.expected not in latest_evidence:
                            return {
                                "authorized": False,
                                "reason": "verified_project_create_form_required",
                            }
                elif step.entity_scope == "owned_project":
                    owned_markers = [
                        project["marker"]
                        for project in connection.execute(
                            "SELECT marker FROM owned_projects WHERE run_id = ?",
                            (run_id,),
                        )
                    ]
                    if not owned_markers or not any(
                        marker in latest_evidence for marker in owned_markers
                    ):
                        return {
                            "authorized": False,
                            "reason": "owned_project_evidence_required",
                        }
                elif (
                    step.risk in {"ordinary", "high"}
                    and re.match(r"^/du-an(?:/|$)", path)
                ):
                    return {
                        "authorized": False,
                        "reason": "project_scope_required",
                    }
            if step.risk == "high":
                approved = connection.execute(
                    "SELECT 1 FROM critical_approvals WHERE run_id = ? AND step_id = ?",
                    (run_id, step_id),
                ).fetchone()
                if not approved:
                    return {"authorized": False, "reason": "critical_approval_required"}
            prior_action = None
            for action_row in connection.execute(
                """
                SELECT payload_json FROM events
                WHERE run_id = ? AND step_id = ? AND event_type = 'browser_action_completed'
                ORDER BY id DESC
                """,
                (run_id, step_id),
            ):
                payload = json.loads(action_row["payload_json"])
                if payload.get("tool") != "browser_scroll":
                    prior_action = payload
                    break
            if prior_action:
                return {
                    "authorized": False,
                    "reason": "post_action_verification_required",
                }
            return {
                "authorized": True,
                "confirmed": step.risk in {"ordinary", "high"},
                "step_id": step_id,
                "action": action,
            }

    def append_event(
        self,
        run_id: str,
        event_type: str,
        phase: str,
        payload: dict[str, Any],
        test_case_id: str = "",
        step_id: str = "",
    ) -> dict[str, Any]:
        timestamp = now_iso()
        payload_text = sanitized_json(payload)
        if len(payload_text.encode("utf-8")) > 512 * 1024:
            raise ValueError("Event payload exceeds the 512 KB audit limit.")
        with self._connect() as connection:
            self._status(connection, run_id)
            cursor = connection.execute(
                """
                INSERT INTO events (
                    run_id, event_type, phase, test_case_id, step_id,
                    payload_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    event_type,
                    phase,
                    test_case_id,
                    step_id,
                    payload_text,
                    timestamp,
                ),
            )
            connection.execute(
                "UPDATE runs SET updated_at = ? WHERE id = ?",
                (timestamp, run_id),
            )
            return {
                "id": cursor.lastrowid,
                "type": event_type,
                "phase": phase,
                "test_case_id": test_case_id,
                "step_id": step_id,
                "payload": json.loads(payload_text),
                "created_at": timestamp,
            }

    def record_step(self, run_id: str, step_id: str, result: StepResult) -> dict[str, Any]:
        timestamp = now_iso()
        payload = json.loads(sanitized_json(result.model_dump(mode="json")))
        with self._connect() as connection:
            if self._status(connection, run_id) not in {
                RunStatus.RUNNING.value,
                RunStatus.PAUSED.value,
            }:
                raise InvalidTransitionError("Step results require a running or paused run.")
            connection.execute(
                """
                INSERT INTO step_results (run_id, step_id, result_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(run_id, step_id)
                DO UPDATE SET result_json = excluded.result_json, updated_at = excluded.updated_at
                """,
                (run_id, step_id, json.dumps(payload, ensure_ascii=False), timestamp),
            )
            plan_row = connection.execute(
                "SELECT plan_json FROM runs WHERE id = ?",
                (run_id,),
            ).fetchone()
            plan = RunPlan.model_validate_json(plan_row["plan_json"])
            step = next(
                (
                    item
                    for case in plan.test_cases
                    for item in case.steps
                    if item.id == step_id
                ),
                None,
            )
            if (
                step
                and step.entity_scope == "project_create"
                and step.action.value == "click"
                and step.target == "#button-save-create-update-project-page"
                and result.status.value == "passed"
                and step.expected
                and step.expected in f"{result.actual}\n{result.evidence}"
            ):
                action_row = connection.execute(
                    """
                    SELECT payload_json FROM events
                    WHERE run_id = ? AND step_id = ?
                      AND event_type = 'browser_action_completed'
                    ORDER BY id DESC
                    LIMIT 1
                    """,
                    (run_id, step_id),
                ).fetchone()
                action_payload = json.loads(action_row["payload_json"]) if action_row else {}
                verification = (
                    action_payload.get("result", {}).get("controllerVerification", {})
                )
                verification_text = json.dumps(verification, ensure_ascii=False)
                if (
                    verification.get("conclusive") is True
                    and step.expected in verification_text
                ):
                    project_id_match = re.search(
                        r"div-project-card-([0-9a-f-]{36})-projects-grid-view",
                        verification_text,
                        re.I,
                    )
                    connection.execute(
                        """
                        INSERT INTO owned_projects (
                            run_id, marker, project_id, created_step_id, registered_at
                        ) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(run_id, marker) DO UPDATE SET
                            project_id = COALESCE(
                                excluded.project_id,
                                owned_projects.project_id
                            ),
                            created_step_id = excluded.created_step_id,
                            registered_at = excluded.registered_at
                        """,
                        (
                            run_id,
                            step.expected,
                            project_id_match.group(1) if project_id_match else None,
                            step_id,
                            timestamp,
                        ),
                    )
            connection.execute(
                "UPDATE runs SET current_step_id = NULL, updated_at = ? WHERE id = ?",
                (timestamp, run_id),
            )
        return payload

    def list_step_results(self, run_id: str) -> dict[str, dict[str, Any]]:
        with self._connect() as connection:
            self._status(connection, run_id)
            return {
                row["step_id"]: json.loads(row["result_json"])
                for row in connection.execute(
                    "SELECT step_id, result_json FROM step_results WHERE run_id = ?",
                    (run_id,),
                )
            }

    def missing_step_ids(self, run_id: str) -> list[str]:
        run = self.get_run(run_id, include_events=False)
        plan = RunPlan.model_validate(run["plan"])
        recorded = set(self.list_step_results(run_id))
        return [
            step.id
            for case in plan.test_cases
            for step in case.steps
            if step.id not in recorded
        ]

    def complete(
        self,
        run_id: str,
        status: str,
        summary: str,
        xlsx_path: Path,
        html_path: Path,
    ) -> dict[str, Any]:
        target = RunStatus.COMPLETED.value if status == "completed" else RunStatus.FAILED.value
        with self._connect() as connection:
            current = self._status(connection, run_id)
            if current not in {RunStatus.RUNNING.value, RunStatus.PAUSED.value}:
                raise InvalidTransitionError(f"Cannot complete a run in '{current}' state.")
            connection.execute(
                """
                UPDATE runs
                SET status = ?, summary = ?, output_xlsx_path = ?,
                    output_html_path = ?, current_step_id = NULL, updated_at = ?
                WHERE id = ?
                """,
                (
                    target,
                    summary,
                    str(xlsx_path),
                    str(html_path),
                    now_iso(),
                    run_id,
                ),
            )
        return self.get_run(run_id)

    def set_artifacts(self, run_id: str, xlsx_path: Path, html_path: Path) -> None:
        with self._connect() as connection:
            self._status(connection, run_id)
            connection.execute(
                """
                UPDATE runs
                SET output_xlsx_path = ?, output_html_path = ?, updated_at = ?
                WHERE id = ?
                """,
                (str(xlsx_path), str(html_path), now_iso(), run_id),
            )

    def save_comparison_result(
        self,
        run_id: str,
        comparison_id: str,
        result: dict[str, Any],
    ) -> dict[str, Any]:
        payload = sanitized_json(result)
        with self._connect() as connection:
            self._status(connection, run_id)
            connection.execute(
                """
                INSERT INTO comparison_results (
                    run_id, comparison_id, result_json, updated_at
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(run_id, comparison_id)
                DO UPDATE SET result_json = excluded.result_json, updated_at = excluded.updated_at
                """,
                (run_id, comparison_id, payload, now_iso()),
            )
        return json.loads(payload)

    def list_comparison_results(self, run_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            self._status(connection, run_id)
            rows = connection.execute(
                """
                SELECT result_json FROM comparison_results
                WHERE run_id = ? ORDER BY comparison_id
                """,
                (run_id,),
            ).fetchall()
        return [json.loads(row["result_json"]) for row in rows]

    def create_bug_draft(self, run_id: str, draft: dict[str, Any]) -> dict[str, Any]:
        self.get_run(run_id, include_events=False)
        draft_id = str(uuid.uuid4())
        fingerprint_source = "|".join([
            str(draft.get("module", "")),
            str(draft.get("step_id", "")),
            str(draft.get("url", "")),
            str(draft.get("expected", "")),
            str(draft.get("actual", "")),
        ])
        fingerprint = hashlib.sha256(
            fingerprint_source.encode("utf-8")
        ).hexdigest()[:24]
        payload = sanitized_json(draft)
        timestamp = now_iso()
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO bug_drafts (
                    id, run_id, fingerprint, draft_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (draft_id, run_id, fingerprint, payload, timestamp, timestamp),
            )
            duplicates = connection.execute(
                """
                SELECT id FROM bug_drafts
                WHERE fingerprint = ? AND id != ? AND status != 'dismissed'
                ORDER BY created_at DESC LIMIT 10
                """,
                (fingerprint, draft_id),
            ).fetchall()
        return {
            "id": draft_id,
            "run_id": run_id,
            "fingerprint": fingerprint,
            "status": "draft",
            "draft": json.loads(payload),
            "duplicate_draft_ids": [row["id"] for row in duplicates],
            "created_at": timestamp,
            "updated_at": timestamp,
        }

    def bug_draft_eligible(
        self,
        run_id: str,
        step_id: str,
        classification: str,
    ) -> bool:
        with self._connect() as connection:
            self._status(connection, run_id)
            if classification == "failed_product":
                row = connection.execute(
                    """
                    SELECT result_json FROM step_results
                    WHERE run_id = ? AND step_id = ?
                    """,
                    (run_id, step_id),
                ).fetchone()
                if not row:
                    return False
                result = json.loads(row["result_json"])
                return (
                    result.get("status") == StepStatus.FAILED_PRODUCT.value
                    and int(result.get("retry_count") or 0) >= 1
                )
            failures = connection.execute(
                """
                SELECT COUNT(*) AS count FROM events
                WHERE run_id = ? AND step_id = ?
                  AND event_type IN (
                    'browser_tool_failed',
                    'frontend_error',
                    'api_error'
                  )
                """,
                (run_id, step_id),
            ).fetchone()
            return int(failures["count"]) >= 2

    def list_bug_drafts(self, run_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            self._status(connection, run_id)
            rows = connection.execute(
                """
                SELECT * FROM bug_drafts WHERE run_id = ? ORDER BY created_at
                """,
                (run_id,),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "run_id": row["run_id"],
                "fingerprint": row["fingerprint"],
                "status": row["status"],
                "draft": json.loads(row["draft_json"]),
                "submitted_issue_id": row["submitted_issue_id"],
                "submitted_issue_url": row["submitted_issue_url"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]

    def patch_bug_draft(
        self,
        run_id: str,
        draft_id: str,
        patch: dict[str, Any],
    ) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM bug_drafts WHERE id = ? AND run_id = ?
                """,
                (draft_id, run_id),
            ).fetchone()
            if not row:
                raise RunNotFoundError(draft_id)
            draft = json.loads(row["draft_json"])
            for key in (
                "project_id",
                "tracker_id",
                "priority_id",
                "assigned_to_id",
                "subject",
                "description",
            ):
                value = patch.get(key)
                if value not in {None, ""}:
                    draft[key] = value
            submitted_issue_id = patch.get("submitted_issue_id")
            submitted_issue_url = str(patch.get("submitted_issue_url", ""))
            status = "submitted" if submitted_issue_id else row["status"]
            connection.execute(
                """
                UPDATE bug_drafts
                SET draft_json = ?, status = ?, submitted_issue_id = ?,
                    submitted_issue_url = ?, updated_at = ?
                WHERE id = ? AND run_id = ?
                """,
                (
                    sanitized_json(draft),
                    status,
                    submitted_issue_id or row["submitted_issue_id"],
                    submitted_issue_url or row["submitted_issue_url"],
                    now_iso(),
                    draft_id,
                    run_id,
                ),
            )
        return next(
            item for item in self.list_bug_drafts(run_id) if item["id"] == draft_id
        )

    def create_schedule(self, value: dict[str, Any]) -> dict[str, Any]:
        source_run_id = str(value["template_run_id"])
        source = self.get_run(source_run_id, include_events=False)
        if source["status"] != RunStatus.COMPLETED.value:
            raise InvalidTransitionError(
                "A schedule requires a successfully completed source run."
            )
        template_id = str(uuid.uuid4())
        schedule_id = str(uuid.uuid4())
        timestamp = now_iso()
        with self._connect() as connection:
            existing = connection.execute(
                "SELECT id FROM run_templates WHERE source_run_id = ?",
                (source_run_id,),
            ).fetchone()
            if existing:
                template_id = existing["id"]
            else:
                connection.execute(
                    """
                    INSERT INTO run_templates (
                        id, source_run_id, plan_json, source_path, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        template_id,
                        source_run_id,
                        json.dumps(source["plan"], ensure_ascii=False),
                        str(self.source_path(source_run_id)),
                        timestamp,
                        timestamp,
                    ),
                )
            connection.execute(
                """
                INSERT INTO schedules (
                    id, template_id, name, local_time, days_json, timezone,
                    enabled, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    schedule_id,
                    template_id,
                    value["name"],
                    value["local_time"],
                    json.dumps(value["days_of_week"]),
                    value["timezone"],
                    1 if value.get("enabled", True) else 0,
                    timestamp,
                    timestamp,
                ),
            )
        return self.get_schedule(schedule_id)

    def get_schedule(self, schedule_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT schedules.*, run_templates.source_run_id
                FROM schedules
                JOIN run_templates ON run_templates.id = schedules.template_id
                WHERE schedules.id = ?
                """,
                (schedule_id,),
            ).fetchone()
        if not row:
            raise RunNotFoundError(schedule_id)
        return {
            "id": row["id"],
            "template_run_id": row["source_run_id"],
            "name": row["name"],
            "local_time": row["local_time"],
            "days_of_week": json.loads(row["days_json"]),
            "timezone": row["timezone"],
            "enabled": bool(row["enabled"]),
            "last_run_at": row["last_run_at"],
            "last_status": row["last_status"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def list_schedules(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            ids = [
                row["id"]
                for row in connection.execute(
                    "SELECT id FROM schedules ORDER BY created_at"
                ).fetchall()
            ]
        return [self.get_schedule(schedule_id) for schedule_id in ids]

    def patch_schedule(self, schedule_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "name": "name",
            "local_time": "local_time",
            "days_of_week": "days_json",
            "timezone": "timezone",
            "enabled": "enabled",
        }
        assignments = []
        values: list[Any] = []
        for key, column in allowed.items():
            if key not in patch or patch[key] is None:
                continue
            value = patch[key]
            if key == "days_of_week":
                value = json.dumps(value)
            if key == "enabled":
                value = 1 if value else 0
            assignments.append(f"{column} = ?")
            values.append(value)
        if assignments:
            assignments.append("updated_at = ?")
            values.extend([now_iso(), schedule_id])
            with self._connect() as connection:
                if not connection.execute(
                    "SELECT 1 FROM schedules WHERE id = ?", (schedule_id,)
                ).fetchone():
                    raise RunNotFoundError(schedule_id)
                connection.execute(
                    f"UPDATE schedules SET {', '.join(assignments)} WHERE id = ?",
                    values,
                )
        return self.get_schedule(schedule_id)

    def delete_schedule(self, schedule_id: str) -> None:
        with self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM schedules WHERE id = ?", (schedule_id,)
            )
            if cursor.rowcount == 0:
                raise RunNotFoundError(schedule_id)

    def clone_schedule_run(self, schedule_id: str) -> tuple[dict[str, Any], str]:
        schedule = self.get_schedule(schedule_id)
        if not schedule["enabled"]:
            raise InvalidTransitionError("The schedule is disabled.")
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT run_templates.* FROM run_templates
                JOIN schedules ON schedules.template_id = run_templates.id
                WHERE schedules.id = ?
                """,
                (schedule_id,),
            ).fetchone()
            if not row:
                raise RunNotFoundError(schedule_id)
            source_plan = json.loads(row["plan_json"])
            old_run_id = source_plan["run_id"]
            new_run_id = str(uuid.uuid4())

            def replace_run_marker(value: Any) -> Any:
                if isinstance(value, str):
                    return value.replace(old_run_id, new_run_id).replace(
                        old_run_id[:8].upper(), new_run_id[:8].upper()
                    )
                if isinstance(value, list):
                    return [replace_run_marker(item) for item in value]
                if isinstance(value, dict):
                    return {
                        key: replace_run_marker(item) for key, item in value.items()
                    }
                return value

            plan_dict = replace_run_marker(source_plan)
            plan_dict["run_id"] = new_run_id
            plan_dict["schema_version"] = "1.1"
            for test_case in plan_dict.get("test_cases", []):
                for step in test_case.get("steps", []):
                    step["status"] = "pending"
            plan = RunPlan.model_validate(plan_dict)
            approval_token = secrets.token_urlsafe(32)
            timestamp = now_iso()
            connection.execute(
                """
                INSERT INTO runs (
                    id, status, workbook_name, source_path, source_sha256,
                    plan_json, approval_token_hash, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    new_run_id,
                    RunStatus.RUNNING.value,
                    plan.workbook_name,
                    row["source_path"],
                    plan.source_sha256,
                    sanitized_json(plan.model_dump(mode="json")),
                    token_hash(approval_token),
                    timestamp,
                    timestamp,
                ),
            )
            connection.execute(
                """
                UPDATE schedules
                SET last_run_at = ?, last_status = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    timestamp,
                    RunStatus.RUNNING.value,
                    timestamp,
                    schedule_id,
                ),
            )
        return self.get_run(new_run_id), approval_token

    def record_discovery(self, observation: dict[str, Any]) -> dict[str, Any]:
        parsed = urlparse(str(observation.get("url", "")))
        domain = (parsed.hostname or "").lower()
        if not domain or parsed.scheme not in {"http", "https"}:
            raise ValueError("Discovery observations require an http or https URL.")
        fingerprint_source = f"{domain}|{parsed.path.rstrip('/')}|{observation.get('title', '')}"
        fingerprint = hashlib.sha256(fingerprint_source.encode("utf-8")).hexdigest()[:24]
        catalog = {
            "title": observation.get("title", ""),
            "path": parsed.path,
            "tool": observation.get("tool", ""),
            "arguments": observation.get("arguments", {}),
            "observation": observation.get("observation", {}),
        }
        catalog_text = sanitized_json(catalog)
        if len(catalog_text.encode("utf-8")) > 512 * 1024:
            raise ValueError("Discovery observation exceeds the 512 KB catalog limit.")
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO adapter_pages (
                    domain, page_fingerprint, page_name, catalog_json, created_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(domain, page_fingerprint)
                DO UPDATE SET
                    page_name = excluded.page_name,
                    catalog_json = excluded.catalog_json,
                    created_at = excluded.created_at
                """,
                (
                    domain,
                    fingerprint,
                    str(observation.get("title", ""))[:1000],
                    catalog_text,
                    now_iso(),
                ),
            )
        return {
            "recorded": True,
            "domain": domain,
            "page_fingerprint": fingerprint,
        }

    def source_path(self, run_id: str) -> Path:
        with self._connect() as connection:
            row = connection.execute("SELECT source_path FROM runs WHERE id = ?", (run_id,)).fetchone()
            if not row:
                raise RunNotFoundError(run_id)
            return Path(row["source_path"])
