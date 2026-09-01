import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "workflow-contract.py"
ROUTER = ROOT / "scripts" / "aiwf.py"
ARTIFACT = ROOT / "contracts" / "workflow-contract-v1.json"


def load_module():
    spec = importlib.util.spec_from_file_location("workflow_contract", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_checked_in_contract_matches_authoritative_export():
    module = load_module()
    assert json.loads(ARTIFACT.read_text(encoding="utf-8")) == module.build_contract()


def test_contract_exposes_modes_protocol_and_schema_hashes():
    contract = load_module().build_contract()
    assert [mode["id"] for mode in contract["modes"]] == [
        "overnight", "balanced", "interactive"
    ]
    assert [strategy["id"] for strategy in contract["overnight_strategies"]] == [
        "convergent", "continuous-improvement"
    ]
    assert "revision_pending" in contract["runtime"]["bookend"]["wake_states"]
    assert contract["runtime"]["bookend"]["success_states"] == ["review_ready"]
    assert all(binding["sha256"].startswith("sha256:") for binding in contract["schema_bindings"])
    projection = contract["projections"]["control_plane_runtime"]
    assert projection["overnight"]["review_decisions"]["revision_pending"] == [
        "accept", "revise", "stop"
    ]
    assert projection["balanced"]["review_state"] == "review_pending"
    assert projection["balanced"]["evidence_statuses"] == [
        "review_pending", "runtime_blocked", "budget_exhausted",
        "scope_violation", "validation_failed",
    ]
    coordination = contract["projections"]["coordination_observability"]
    assert coordination["event_schema_binding"] == "coordination-event-v1"
    assert coordination["summary_schema_binding"] == "coordination-run-summary-v1"
    assert coordination["detail_schema_binding"] == "coordination-run-detail-v1"
    assert coordination["content_policy"] == "metadata-only"
    assert coordination["coverage_policy"] == "unsupported-is-not-zero"
    assert "artifact_read" in coordination["event_kinds"]
    assert coordination["read_containment_modes"] == [
        "exact-paths", "partial-event-audit", "unsupported",
    ]
    assert coordination["write_containment_modes"] == [
        "exact-paths", "post-run-audit", "unsupported",
    ]
    assert coordination["read_audit_policy"] == "explicit-events-only"
    assert coordination["derived_metric_policy"] == "recorded-events-only"
    assert "max-artifact-reader-fan-out" in coordination["topology_metrics"]
    assert coordination["detail_projection_policy"] == "allowlist-metadata-only"
    assert coordination["temporal_order_policy"] == "append-sequence"
    binding_ids = {binding["id"] for binding in contract["schema_bindings"]}
    assert {
        "coordination-event-v1", "coordination-run-summary-v1", "coordination-run-detail-v1"
    } <= binding_ids
    interface_ownership = contract["projections"]["task_card"]["interface_ownership"]
    assert interface_ownership["reference_policy"] == "declared-participants-only"
    assert interface_ownership["validation_policy"] == "reference-or-preflight-warning"


def test_coordination_schemas_expose_read_events_and_containment_coverage():
    event_schema = json.loads(
        (ROOT / "schemas" / "coordination-event-v1.schema.json").read_text(encoding="utf-8")
    )
    summary_schema = json.loads(
        (ROOT / "schemas" / "coordination-run-summary-v1.schema.json").read_text(
            encoding="utf-8"
        )
    )
    detail_schema = json.loads(
        (ROOT / "schemas" / "coordination-run-detail-v1.schema.json").read_text(
            encoding="utf-8"
        )
    )
    assert "artifact_read" in event_schema["properties"]["kind"]["enum"]
    assert {"artifactReads", "readViolations", "readClassifications", "containment", "topology"} <= set(
        summary_schema["required"]
    )
    assert summary_schema["properties"]["containment"]["properties"]["read"]["enum"] == [
        "exact-paths", "partial-event-audit", "unsupported"
    ]
    assert "enforced" in summary_schema["properties"]["coverage"]["properties"]["read"]["enum"]
    assert detail_schema["properties"]["timeline"]["properties"]["events"]["maxItems"] == 500
    assert detail_schema["properties"]["graph"]["properties"]["scope"]["const"] == "returned-events"


def test_aiwf_router_exports_and_checks_contract():
    exported = subprocess.run(
        [sys.executable, str(ROUTER), "contract", "export"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    assert json.loads(exported.stdout)["contract_version"] == "1.6.0"
    checked = subprocess.run(
        [sys.executable, str(ROUTER), "contract", "check"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    assert "workflow_contract_valid=true" in checked.stdout


def test_installed_layout_exports_and_checks_the_same_contract(tmp_path):
    ai_dir = tmp_path / "ai"
    schemas_dir = ai_dir / "schemas"
    contracts_dir = ai_dir / "contracts"
    schemas_dir.mkdir(parents=True)
    contracts_dir.mkdir()
    for name in (
        "task-card-v1.schema.json",
        "workflow-state.schema.json",
        "workflow-event.schema.json",
        "review-receipt.schema.json",
        "review-decision-v1.schema.json",
        "coordination-event-v1.schema.json",
        "coordination-run-summary-v1.schema.json",
        "coordination-run-detail-v1.schema.json",
    ):
        shutil.copy2(ROOT / "schemas" / name, schemas_dir / name)
    shutil.copy2(SCRIPT, ai_dir / "workflow-contract.py")
    shutil.copy2(ROUTER, ai_dir / "aiwf.py")
    shutil.copy2(ARTIFACT, contracts_dir / ARTIFACT.name)

    checked = subprocess.run(
        [sys.executable, str(ai_dir / "aiwf.py"), "contract", "check"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=True,
    )
    assert "workflow_contract_valid=true" in checked.stdout
