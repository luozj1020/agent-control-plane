#!/usr/bin/env python3
"""Export and verify the versioned AI Coding Workflow machine contract."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Dict

ROOT = Path(__file__).resolve().parent.parent
CONTRACT_VERSION = "1.6.0"
DEFAULT_ARTIFACT = (
    ROOT / "contracts" / "workflow-contract-v1.json"
    if (ROOT / "contracts" / "workflow-contract-v1.json").is_file()
    else ROOT / "ai" / "contracts" / "workflow-contract-v1.json"
)
SCHEMA_BINDINGS = (
    ("task-card-v1", "schemas/task-card-v1.schema.json"),
    ("workflow-state-v1", "schemas/workflow-state.schema.json"),
    ("workflow-event-v1", "schemas/workflow-event.schema.json"),
    ("review-receipt-v1", "schemas/review-receipt.schema.json"),
    ("review-decision-v1", "schemas/review-decision-v1.schema.json"),
    ("coordination-event-v1", "schemas/coordination-event-v1.schema.json"),
    ("coordination-run-summary-v1", "schemas/coordination-run-summary-v1.schema.json"),
    ("coordination-run-detail-v1", "schemas/coordination-run-detail-v1.schema.json"),
)


def sha256_file(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def installed_or_source_path(root: Path, relative: str) -> Path:
    source = root / relative
    return source if source.is_file() else root / "ai" / relative


def build_contract(root: Path = ROOT) -> Dict[str, Any]:
    """Return the deterministic public contract derived from repository sources."""
    return {
        "schema_version": 1,
        "contract_id": "ai-coding-workflow",
        "contract_version": CONTRACT_VERSION,
        "producer": {"repository": "ai-coding-workflow", "cli": "aiwf"},
        "modes": [
            {
                "id": "overnight",
                "ownership": "downstream-convergence",
                "entrypoint": ["python", "ai/aiwf.py", "submit", "TASK.json"],
                "upstream_lifecycle": "bookends",
            },
            {
                "id": "balanced",
                "ownership": "round-based",
                "entrypoint": ["python", "ai/aiwf.py", "balanced", "TASK.json"],
                "upstream_lifecycle": "active-between-rounds",
            },
            {
                "id": "interactive",
                "ownership": "upstream-continuous",
                "entrypoint": None,
                "upstream_lifecycle": "continuous",
            },
        ],
        "overnight_strategies": [
            {
                "id": "convergent",
                "scope_rule": "non-expanding",
                "stop_rule": "acceptance-approved",
            },
            {
                "id": "continuous-improvement",
                "scope_rule": "acceptance-floor-preserving",
                "stop_rule": "operator-interrupt",
            },
        ],
        "runtime": {
            "bookend": {
                "states": [
                    "submitted", "converging", "classifying", "recovering", "projecting",
                    "checkpoint_ready", "revision_pending", "review_ready", "semantic_blocked",
                    "runtime_blocked", "authority_blocked", "budget_exhausted", "cancelled",
                ],
                "wake_states": ["checkpoint_ready", "revision_pending", "semantic_blocked"],
                "terminal_states": [
                    "review_ready", "semantic_blocked", "runtime_blocked", "authority_blocked",
                    "budget_exhausted", "cancelled",
                ],
                "success_states": ["review_ready"],
            },
            "balanced": {
                "states": ["review_pending"],
                "wake_states": ["review_pending"],
                "terminal_states": [],
                "success_states": [],
            },
        },
        "review": {
            "overnight_decisions": ["accept", "revise"],
            "balanced_decisions": ["accept", "revise", "stop"],
            "revision_delta": "bounded-non-expanding",
        },
        "projections": {
            "task_card": {
                "schema_binding": "task-card-v1",
                "schema_version": 1,
                "interface_ownership": {
                    "participant_path": "extensions.task_shape.participants",
                    "interface_path": "extensions.task_shape.interfaces",
                    "reference_policy": "declared-participants-only",
                    "validation_policy": "reference-or-preflight-warning",
                },
            },
            "control_plane_runtime": {
                "overnight": {
                    "states": [
                        "submitted", "running", "revision_pending",
                        "improvement_cycle_ready", "runtime_blocked",
                        "scope_violation", "validation_failed", "accepted",
                        "stopped", "interrupted", "interrupt_requested",
                    ],
                    "initial_state": "submitted",
                    "active_state": "running",
                    "wake_states": [
                        "revision_pending", "improvement_cycle_ready",
                        "runtime_blocked", "scope_violation", "validation_failed",
                    ],
                    "terminal_states": ["accepted", "stopped", "interrupted"],
                    "review_decisions": {
                        "revision_pending": ["accept", "revise", "stop"],
                        "improvement_cycle_ready": ["continue", "revise", "stop"],
                        "runtime_blocked": ["stop"],
                        "scope_violation": ["stop"],
                        "validation_failed": ["stop"],
                    },
                    "outcome_states": {
                        "interrupted": "interrupted",
                        "runtime_failure": "runtime_blocked",
                        "scope_failure": "scope_violation",
                        "validation_failure": "validation_failed",
                        "no_change": "revision_pending",
                        "convergent_ready": "revision_pending",
                        "improvement_ready": "improvement_cycle_ready",
                    },
                    "decision_states": {
                        "accept": "accepted",
                        "stop": "stopped",
                        "revise": "submitted",
                        "continue": "submitted",
                        "interrupt": "interrupted",
                        "interrupt_requested": "interrupt_requested",
                    },
                },
                "balanced": {
                    "states": [
                        "created", "running", "review_pending",
                        "revision_pending", "accepted", "stopped",
                    ],
                    "initial_state": "created",
                    "active_state": "running",
                    "review_state": "review_pending",
                    "terminal_states": ["accepted", "stopped"],
                    "evidence_statuses": [
                        "review_pending", "runtime_blocked", "budget_exhausted",
                        "scope_violation", "validation_failed",
                    ],
                    "review_decisions": ["accept", "revise", "stop"],
                    "outcome_states": {
                        "ready": "review_pending",
                        "runtime_failure": "runtime_blocked",
                        "budget_failure": "budget_exhausted",
                        "scope_failure": "scope_violation",
                        "validation_failure": "validation_failed",
                    },
                    "decision_states": {
                        "accept": "accepted",
                        "revise": "revision_pending",
                        "stop": "stopped",
                    },
                },
            },
            "coordination_observability": {
                "event_schema_binding": "coordination-event-v1",
                "summary_schema_binding": "coordination-run-summary-v1",
                "detail_schema_binding": "coordination-run-detail-v1",
                "event_kinds": [
                    "run_created", "agent_invoke_started", "agent_invoke_completed",
                    "artifact_read", "artifact_write", "state_transition", "review_decision",
                    "validation_completed", "wake_requested", "wake_delivered",
                    "interrupt_requested",
                ],
                "measurement_sources": [
                    "runtime", "filesystem_snapshot", "provider_reported",
                    "derived", "agent_claimed",
                ],
                "content_policy": "metadata-only",
                "coverage_policy": "unsupported-is-not-zero",
                "read_containment_modes": [
                    "exact-paths", "partial-event-audit", "unsupported",
                ],
                "write_containment_modes": [
                    "exact-paths", "post-run-audit", "unsupported",
                ],
                "read_audit_policy": "explicit-events-only",
                "derived_metric_policy": "recorded-events-only",
                "topology_metrics": [
                    "node-count", "relationship-count", "unique-read-artifacts",
                    "repeated-artifact-reads", "artifact-reader-links",
                    "max-artifact-reader-fan-out",
                ],
                "detail_projection_policy": "allowlist-metadata-only",
                "temporal_order_policy": "append-sequence",
            },
        },
        "invariants": [
            "explicit-mode-selection",
            "single-writer",
            "hash-bound-evidence",
            "tools-establish-facts-models-make-claims",
            "models-never-merge",
            "human-retains-sensitive-authority",
        ],
        "schema_bindings": [
            {
                "id": binding_id,
                "path": relative,
                "sha256": sha256_file(installed_or_source_path(root, relative)),
            }
            for binding_id, relative in SCHEMA_BINDINGS
        ],
    }


def serialized_contract(root: Path = ROOT) -> str:
    return json.dumps(build_contract(root), indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def validate_shape(contract: Dict[str, Any]) -> list[str]:
    errors = []
    if contract.get("schema_version") != 1:
        errors.append("schema_version must be 1")
    if contract.get("contract_id") != "ai-coding-workflow":
        errors.append("contract_id must be ai-coding-workflow")
    if contract.get("contract_version") != CONTRACT_VERSION:
        errors.append(f"contract_version must be {CONTRACT_VERSION}")
    if [mode.get("id") for mode in contract.get("modes", [])] != [
        "overnight", "balanced", "interactive"
    ]:
        errors.append("modes must declare overnight, balanced, and interactive in order")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="operation")
    export_parser = subparsers.add_parser("export", help="write or print the current contract")
    export_parser.add_argument("--output", type=Path)
    check_parser = subparsers.add_parser("check", help="verify a contract against repository sources")
    check_parser.add_argument("path", nargs="?", type=Path, default=DEFAULT_ARTIFACT)
    args = parser.parse_args(argv)

    if args.operation in (None, "export"):
        content = serialized_contract()
        output = getattr(args, "output", None)
        if output:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(content, encoding="utf-8")
            print(output)
        else:
            sys.stdout.write(content)
        return 0

    try:
        actual = json.loads(args.path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"workflow_contract_valid=false\nerror={exc}", file=sys.stderr)
        return 1
    errors = validate_shape(actual)
    if actual != build_contract():
        errors.append("contract differs from the current authoritative export")
    if errors:
        print("workflow_contract_valid=false", file=sys.stderr)
        for error in errors:
            print(f"error={error}", file=sys.stderr)
        return 1
    print("workflow_contract_valid=true")
    print(f"contract_version={CONTRACT_VERSION}")
    print(f"contract_sha256={sha256_file(args.path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
