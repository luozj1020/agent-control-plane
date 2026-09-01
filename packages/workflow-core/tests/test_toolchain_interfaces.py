from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "toolchain_interfaces.py"


def load_module():
    spec = importlib.util.spec_from_file_location("toolchain_interfaces", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


toolchain = load_module()


def manifest_value(
    harness_id="codex",
    upstream=True,
    downstream=True,
    adapter_version="1.0.0",
    capabilities=None,
):
    return {
        "schemaVersion": 1,
        "id": harness_id,
        "displayName": harness_id.title(),
        "adapterVersion": adapter_version,
        "lifecycle": "preview",
        "trustLevel": "built-in",
        "roles": {"upstream": upstream, "downstream": downstream},
        "providerPolicy": "configurable",
        "capabilities": capabilities or {},
    }


def report_value(
    harness_id="codex",
    installation_id="local",
    adapter_version="1.0.0",
    capabilities=None,
):
    evidence = {}
    for name, state in (capabilities or {}).items():
        evidence[name] = {
            "state": state,
            "source": "runtime-probe",
            "observedAt": "2026-08-31T02:00:00Z",
            "expiresAt": "2026-12-31T00:00:00Z",
            "evidenceRef": "receipt://{}-{}".format(harness_id, name),
        }
    return {
        "schemaVersion": 1,
        "id": "report-{}".format(harness_id),
        "harnessId": harness_id,
        "installationId": installation_id,
        "adapterVersion": adapter_version,
        "harnessVersion": "2026.8",
        "observedAt": "2026-08-31T02:00:00Z",
        "compatibility": {
            "os": "linux",
            "architecture": "x86_64",
            "authenticationMode": "external",
            "providerRoute": "configured",
            "configSchema": "observed-v1",
        },
        "capabilities": evidence,
    }


def profile_value(
    mode="interactive",
    upstream="codex",
    upstream_installation="local",
    backend_kind="native-subagents",
    downstream=None,
    downstream_installation=None,
):
    backend = {"kind": backend_kind}
    if downstream is not None:
        backend["harnessId"] = downstream
    if downstream_installation is not None:
        backend["installationId"] = downstream_installation
    return {
        "schemaVersion": 1,
        "id": "profile-1",
        "upstream": {
            "harnessId": upstream,
            "installationId": upstream_installation,
        },
        "mode": mode,
        "executionBackend": backend,
        "roles": [],
    }


class HarnessManifestTests(unittest.TestCase):
    def test_manifest_preserves_forward_extension_fields(self):
        value = manifest_value(
            capabilities={"nativeSubagents": "supported"}
        )
        value["vendorExtension"] = {"future": True}

        manifest = toolchain.HarnessManifest.from_mapping(value)

        self.assertEqual(manifest.harness_id, "codex")
        self.assertEqual(manifest.raw["vendorExtension"], {"future": True})
        value["vendorExtension"]["future"] = False
        self.assertTrue(manifest.raw["vendorExtension"]["future"])

    def test_invalid_capability_state_is_rejected(self):
        with self.assertRaisesRegex(toolchain.ManifestError, "invalid state"):
            toolchain.HarnessManifest.from_mapping(
                manifest_value(capabilities={"nativeSubagents": "maybe"})
            )

    def test_registry_is_deterministic_and_rejects_duplicate_ids(self):
        registry = toolchain.HarnessRegistry()
        zcode = toolchain.HarnessManifest.from_mapping(
            manifest_value("zcode", upstream=False, downstream=True)
        )
        codex = toolchain.HarnessManifest.from_mapping(manifest_value("codex"))
        registry.register_manifest(zcode)
        registry.register_manifest(codex)

        self.assertEqual(
            [item.harness_id for item in registry.list_manifests()],
            ["codex", "zcode"],
        )
        self.assertEqual(
            [item.harness_id for item in registry.list_manifests("upstream")],
            ["codex"],
        )
        with self.assertRaises(toolchain.DuplicateHarnessError):
            registry.register_manifest(codex)


class WorkflowProfileTests(unittest.TestCase):
    def test_manual_unknown_model_id_is_preserved(self):
        value = profile_value()
        value["roles"] = [{
            "id": "worker",
            "model": {
                "providerId": "custom-provider",
                "modelId": "new-model-not-in-built-in-catalog",
                "source": "manual",
            },
            "futureRoleSetting": 3,
        }]

        profile = toolchain.WorkflowProfile.from_mapping(value)

        self.assertEqual(
            profile.roles[0]["model"]["modelId"],
            "new-model-not-in-built-in-catalog",
        )
        self.assertEqual(profile.roles[0]["futureRoleSetting"], 3)

    def test_duplicate_role_ids_are_rejected(self):
        value = profile_value()
        value["roles"] = [{"id": "worker"}, {"id": "worker"}]
        with self.assertRaisesRegex(toolchain.ProfileError, "duplicate role"):
            toolchain.WorkflowProfile.from_mapping(value)


class ModelCatalogTests(unittest.TestCase):
    def test_runtime_catalog_wins_without_dropping_manual_unknown_model(self):
        manual_known = toolchain.manual_model_entry(
            "openai-compatible", "known-model", "opencode"
        )
        manual_unknown = toolchain.manual_model_entry(
            "openai-compatible", "released-five-minutes-ago", "opencode"
        )
        catalog = toolchain.ModelCatalog.from_mapping({
            "schemaVersion": 1,
            "id": "runtime-opencode",
            "providerId": "openai-compatible",
            "harnessId": "opencode",
            "source": "runtime",
            "observedAt": "2026-08-31T04:00:00Z",
            "models": [{
                "modelId": "known-model",
                "displayName": "Known Model (verified by runtime)",
                "lifecycle": "active",
                "reasoningEfforts": ["low", "medium"],
            }],
        })

        merged = toolchain.merge_model_catalogs(
            [catalog], [manual_known, manual_unknown]
        )
        by_id = {entry.model_id: entry for entry in merged}

        self.assertEqual(by_id["known-model"].source, "runtime")
        self.assertEqual(
            by_id["released-five-minutes-ago"].source, "manual"
        )

    def test_newest_catalog_wins_within_the_same_source(self):
        def value(catalog_id, observed_at, display_name):
            return {
                "schemaVersion": 1,
                "id": catalog_id,
                "providerId": "vendor",
                "source": "catalog",
                "observedAt": observed_at,
                "models": [{
                    "modelId": "model-a",
                    "displayName": display_name,
                }],
            }

        older = toolchain.ModelCatalog.from_mapping(value(
            "older", "2026-08-30T00:00:00Z", "Old name"
        ))
        newer = toolchain.ModelCatalog.from_mapping(value(
            "newer", "2026-08-31T00:00:00Z", "New name"
        ))

        merged = toolchain.merge_model_catalogs([newer, older])

        self.assertEqual(merged[0].display_name, "New name")

    def test_global_and_harness_scoped_models_can_coexist(self):
        global_entry = toolchain.manual_model_entry("vendor", "model-a")
        harness_entry = toolchain.manual_model_entry(
            "vendor", "model-a", "zcode"
        )

        merged = toolchain.merge_model_catalogs(
            [], [harness_entry, global_entry]
        )

        self.assertEqual(len(merged), 2)
        self.assertEqual(
            [entry.harness_id for entry in merged], [None, "zcode"]
        )


class CompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.at = datetime(2026, 9, 1, tzinfo=timezone.utc)

    def test_interactive_accepts_current_native_subagent_evidence(self):
        registry = toolchain.HarnessRegistry()
        registry.register_manifest(toolchain.HarnessManifest.from_mapping(
            manifest_value(capabilities={"nativeSubagents": "supported"})
        ))
        report = toolchain.CapabilityReport.from_mapping(report_value(
            capabilities={"nativeSubagents": "supported"}
        ))
        profile = toolchain.WorkflowProfile.from_mapping(profile_value())

        result = toolchain.evaluate_profile_compatibility(
            profile, registry, [report], self.at
        )

        self.assertTrue(result.compatible, result.issues)

    def test_interactive_without_probe_is_unverified_not_supported(self):
        registry = toolchain.HarnessRegistry()
        registry.register_manifest(toolchain.HarnessManifest.from_mapping(
            manifest_value(capabilities={"nativeSubagents": "supported"})
        ))
        profile = toolchain.WorkflowProfile.from_mapping(profile_value())

        result = toolchain.evaluate_profile_compatibility(profile, registry)

        self.assertFalse(result.compatible)
        self.assertEqual(result.issues[0].code, "required-capability-unverified")

    def test_expired_capability_evidence_fails_closed(self):
        registry = toolchain.HarnessRegistry()
        registry.register_manifest(toolchain.HarnessManifest.from_mapping(
            manifest_value(capabilities={"nativeSubagents": "supported"})
        ))
        report_data = report_value(
            capabilities={"nativeSubagents": "supported"}
        )
        report_data["capabilities"]["nativeSubagents"]["expiresAt"] = (
            "2026-08-31T03:00:00Z"
        )
        report = toolchain.CapabilityReport.from_mapping(report_data)
        profile = toolchain.WorkflowProfile.from_mapping(profile_value())

        result = toolchain.evaluate_profile_compatibility(
            profile, registry, [report], self.at
        )

        self.assertFalse(result.compatible)
        self.assertEqual(result.issues[0].code, "required-capability-unverified")

    def test_adapter_version_mismatch_invalidates_probe(self):
        registry = toolchain.HarnessRegistry()
        registry.register_manifest(toolchain.HarnessManifest.from_mapping(
            manifest_value(
                adapter_version="2.0.0",
                capabilities={"nativeSubagents": "supported"},
            )
        ))
        report = toolchain.CapabilityReport.from_mapping(report_value(
            adapter_version="1.0.0",
            capabilities={"nativeSubagents": "supported"},
        ))
        profile = toolchain.WorkflowProfile.from_mapping(profile_value())

        result = toolchain.evaluate_profile_compatibility(
            profile, registry, [report], self.at
        )

        self.assertFalse(result.compatible)
        self.assertEqual(result.issues[0].code, "required-capability-unverified")

    def test_balanced_allows_distinct_upstream_and_downstream_harnesses(self):
        registry = toolchain.HarnessRegistry()
        upstream_caps = {"rulesInjection": "supported"}
        downstream_caps = {
            "nonInteractiveRun": "supported",
            "boundedExecution": "supported",
            "statusReporting": "supported",
        }
        registry.register_manifest(toolchain.HarnessManifest.from_mapping(
            manifest_value(
                "opencode", upstream=True, downstream=False,
                capabilities=upstream_caps,
            )
        ))
        registry.register_manifest(toolchain.HarnessManifest.from_mapping(
            manifest_value(
                "zcode", upstream=False, downstream=True,
                capabilities=downstream_caps,
            )
        ))
        reports = [
            toolchain.CapabilityReport.from_mapping(report_value(
                "opencode", capabilities=upstream_caps
            )),
            toolchain.CapabilityReport.from_mapping(report_value(
                "zcode", capabilities=downstream_caps
            )),
        ]
        profile = toolchain.WorkflowProfile.from_mapping(profile_value(
            mode="balanced",
            upstream="opencode",
            backend_kind="external-harness",
            downstream="zcode",
            downstream_installation="local",
        ))

        result = toolchain.evaluate_profile_compatibility(
            profile, registry, reports, self.at
        )

        self.assertTrue(result.compatible, result.issues)

    def test_interactive_rejects_external_cross_harness_backend(self):
        registry = toolchain.HarnessRegistry()
        registry.register_manifest(toolchain.HarnessManifest.from_mapping(
            manifest_value(capabilities={"nativeSubagents": "supported"})
        ))
        report = toolchain.CapabilityReport.from_mapping(report_value(
            capabilities={"nativeSubagents": "supported"}
        ))
        profile = toolchain.WorkflowProfile.from_mapping(profile_value(
            backend_kind="external-harness",
            downstream="zcode",
            downstream_installation="local",
        ))

        result = toolchain.evaluate_profile_compatibility(
            profile, registry, [report], self.at
        )

        self.assertFalse(result.compatible)
        self.assertEqual(
            {issue.code for issue in result.issues},
            {
                "interactive-requires-native-subagents",
                "interactive-cross-harness-backend",
            },
        )


class ActivationReceiptTests(unittest.TestCase):
    def test_receipt_requires_rollback_evidence_and_preserves_extensions(self):
        value = {
            "schemaVersion": 1,
            "id": "activation-1",
            "profileId": "profile-1",
            "state": "committed",
            "createdAt": "2026-08-31T03:00:00Z",
            "adapterVersions": {"codex": "1.0.0"},
            "changes": [{
                "path": "/tmp/config",
                "operation": "update",
                "beforeHash": None,
                "afterHash": None,
                "ownedByReceipt": True,
            }],
            "backup": {
                "available": True,
                "location": "/tmp/backup",
                "contentHash": None,
            },
            "verification": {"status": "passed", "checks": []},
            "futureReceiptField": {"preserved": True},
        }

        receipt = toolchain.ActivationReceipt.from_mapping(value)

        self.assertEqual(receipt.adapter_versions["codex"], "1.0.0")
        self.assertTrue(receipt.backup["available"])
        self.assertTrue(receipt.raw["futureReceiptField"]["preserved"])


class SchemaTests(unittest.TestCase):
    def test_wire_schemas_are_parseable_and_forward_compatible(self):
        names = [
            "harness-manifest-v1.schema.json",
            "capability-report-v1.schema.json",
            "workflow-profile-v1.schema.json",
            "activation-receipt-v1.schema.json",
            "model-catalog-v1.schema.json",
        ]
        for name in names:
            with self.subTest(name=name):
                value = json.loads((ROOT / "schemas" / name).read_text(
                    encoding="utf-8"
                ))
                self.assertEqual(value["$schema"],
                                 "https://json-schema.org/draft/2020-12/schema")
                self.assertTrue(value["additionalProperties"])
                self.assertIn("schemaVersion", value["required"])


if __name__ == "__main__":
    unittest.main()
