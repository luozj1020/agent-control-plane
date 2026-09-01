#!/usr/bin/env python3
"""Versioned extension contracts for pluggable agent toolchains.

This module deliberately does not launch a Harness or write user configuration.
It defines the stable boundary that future Codex, Claude Code, OpenCode, Cursor,
Zcode, and custom adapters implement.  The accompanying JSON Schemas are the
language-neutral wire format; these Python types provide fail-closed loading,
registration, and mode compatibility checks for the existing control plane.

Python 3.9+ compatible.  No third-party dependencies.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Protocol, Sequence


SCHEMA_VERSION = 1
CAPABILITY_STATES = frozenset(
    {"supported", "unsupported", "unverified", "degraded"}
)
ADAPTER_LIFECYCLES = frozenset(
    {"experimental", "preview", "stable", "deprecated", "removed"}
)
TRUST_LEVELS = frozenset({"built-in", "verified", "community", "local"})
PROVIDER_POLICIES = frozenset({"fixed", "configurable", "unknown"})
MODES = frozenset({"overnight", "balanced", "interactive"})
BACKEND_KINDS = frozenset({"external-harness", "native-subagents"})
MODEL_SOURCES = (
    "runtime",
    "endpoint",
    "catalog",
    "fallback",
    "manual",
)
MODEL_SOURCE_PRIORITY = {
    source: len(MODEL_SOURCES) - index
    for index, source in enumerate(MODEL_SOURCES)
}
MODEL_LIFECYCLES = frozenset(
    {"active", "preview", "deprecated", "retired", "unknown"}
)

# These are minimum activation requirements, not an exhaustive feature list.
# Adapters may add stricter requirements, but may not weaken mode semantics.
MODE_CAPABILITY_REQUIREMENTS = {
    "overnight": {
        "upstream": ("rulesInjection",),
        "downstream": (
            "nonInteractiveRun",
            "persistentState",
            "statusReporting",
        ),
    },
    "balanced": {
        "upstream": ("rulesInjection",),
        "downstream": (
            "nonInteractiveRun",
            "boundedExecution",
            "statusReporting",
        ),
    },
    "interactive": {
        "upstream": ("nativeSubagents",),
        "downstream": (),
    },
}


class ToolchainInterfaceError(ValueError):
    """Base class for invalid extension contracts."""


class ManifestError(ToolchainInterfaceError):
    """Raised when a Harness Manifest is structurally invalid."""


class CapabilityReportError(ToolchainInterfaceError):
    """Raised when capability evidence is structurally invalid."""


class ProfileError(ToolchainInterfaceError):
    """Raised when a workflow Profile is structurally invalid."""


class ActivationReceiptError(ToolchainInterfaceError):
    """Raised when an activation receipt is structurally invalid."""


class ModelCatalogError(ToolchainInterfaceError):
    """Raised when a Provider or Harness model catalog is invalid."""


class DuplicateHarnessError(ToolchainInterfaceError):
    """Raised when two extensions claim the same stable Harness ID."""


def _mapping(value: Any, label: str, error_type: type) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise error_type("{} must be an object".format(label))
    return value


def _nonempty(value: Any, label: str, error_type: type) -> str:
    if not isinstance(value, str) or not value.strip():
        raise error_type("{} must be a non-empty string".format(label))
    return value.strip()


def _boolean(value: Any, label: str, error_type: type) -> bool:
    if not isinstance(value, bool):
        raise error_type("{} must be a boolean".format(label))
    return value


def _schema_version(value: Mapping[str, Any], error_type: type) -> None:
    if value.get("schemaVersion") != SCHEMA_VERSION:
        raise error_type(
            "unsupported schemaVersion: {!r}".format(value.get("schemaVersion"))
        )


def _timestamp(value: Any, label: str, error_type: type) -> datetime:
    text = _nonempty(value, label, error_type)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise error_type("{} must be an RFC-3339 timestamp".format(label)) from exc
    if parsed.tzinfo is None:
        raise error_type("{} must include a timezone".format(label))
    return parsed.astimezone(timezone.utc)


@dataclass(frozen=True)
class HarnessManifest:
    """Stable metadata for one Harness adapter implementation."""

    harness_id: str
    display_name: str
    adapter_version: str
    lifecycle: str
    can_be_upstream: bool
    can_be_downstream: bool
    provider_policy: str
    capabilities: Mapping[str, str]
    trust_level: str = "local"
    raw: Mapping[str, Any] = field(default_factory=dict, compare=False, repr=False)

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "HarnessManifest":
        value = _mapping(value, "Harness Manifest", ManifestError)
        _schema_version(value, ManifestError)
        roles = _mapping(value.get("roles"), "roles", ManifestError)
        capabilities = _mapping(
            value.get("capabilities"), "capabilities", ManifestError
        )
        normalized_capabilities: Dict[str, str] = {}
        for name, state in capabilities.items():
            capability = _nonempty(name, "capability name", ManifestError)
            if state not in CAPABILITY_STATES:
                raise ManifestError(
                    "capability {!r} has invalid state {!r}".format(capability, state)
                )
            normalized_capabilities[capability] = state

        lifecycle = _nonempty(value.get("lifecycle"), "lifecycle", ManifestError)
        if lifecycle not in ADAPTER_LIFECYCLES:
            raise ManifestError("invalid lifecycle {!r}".format(lifecycle))
        provider_policy = _nonempty(
            value.get("providerPolicy"), "providerPolicy", ManifestError
        )
        if provider_policy not in PROVIDER_POLICIES:
            raise ManifestError(
                "invalid providerPolicy {!r}".format(provider_policy)
            )
        trust_level = value.get("trustLevel", "local")
        if trust_level not in TRUST_LEVELS:
            raise ManifestError("invalid trustLevel {!r}".format(trust_level))

        return cls(
            harness_id=_nonempty(value.get("id"), "id", ManifestError),
            display_name=_nonempty(
                value.get("displayName"), "displayName", ManifestError
            ),
            adapter_version=_nonempty(
                value.get("adapterVersion"), "adapterVersion", ManifestError
            ),
            lifecycle=lifecycle,
            can_be_upstream=_boolean(
                roles.get("upstream"), "roles.upstream", ManifestError
            ),
            can_be_downstream=_boolean(
                roles.get("downstream"), "roles.downstream", ManifestError
            ),
            provider_policy=provider_policy,
            capabilities=copy.deepcopy(normalized_capabilities),
            trust_level=trust_level,
            raw=copy.deepcopy(dict(value)),
        )


@dataclass(frozen=True)
class CapabilityEvidence:
    state: str
    source: str
    observed_at: datetime
    evidence_ref: str
    expires_at: Optional[datetime] = None

    @classmethod
    def from_mapping(
        cls, capability: str, value: Mapping[str, Any]
    ) -> "CapabilityEvidence":
        value = _mapping(
            value,
            "capabilities.{}".format(capability),
            CapabilityReportError,
        )
        state = value.get("state")
        if state not in CAPABILITY_STATES:
            raise CapabilityReportError(
                "capability {!r} has invalid state {!r}".format(capability, state)
            )
        expires_at = value.get("expiresAt")
        return cls(
            state=state,
            source=_nonempty(
                value.get("source"),
                "capabilities.{}.source".format(capability),
                CapabilityReportError,
            ),
            observed_at=_timestamp(
                value.get("observedAt"),
                "capabilities.{}.observedAt".format(capability),
                CapabilityReportError,
            ),
            evidence_ref=_nonempty(
                value.get("evidenceRef"),
                "capabilities.{}.evidenceRef".format(capability),
                CapabilityReportError,
            ),
            expires_at=(
                _timestamp(
                    expires_at,
                    "capabilities.{}.expiresAt".format(capability),
                    CapabilityReportError,
                )
                if expires_at is not None
                else None
            ),
        )

    def effective_state(self, at: Optional[datetime] = None) -> str:
        now = at or datetime.now(timezone.utc)
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        if self.expires_at is not None and now >= self.expires_at:
            return "unverified"
        return self.state


@dataclass(frozen=True)
class CapabilityReport:
    """Version-bound, installation-specific capability evidence."""

    report_id: str
    harness_id: str
    installation_id: str
    adapter_version: str
    harness_version: str
    observed_at: datetime
    compatibility: Mapping[str, Any]
    capabilities: Mapping[str, CapabilityEvidence]
    raw: Mapping[str, Any] = field(default_factory=dict, compare=False, repr=False)

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "CapabilityReport":
        value = _mapping(value, "Capability Report", CapabilityReportError)
        _schema_version(value, CapabilityReportError)
        compatibility = _mapping(
            value.get("compatibility"), "compatibility", CapabilityReportError
        )
        for key in (
            "os",
            "architecture",
            "authenticationMode",
            "providerRoute",
            "configSchema",
        ):
            if key not in compatibility:
                raise CapabilityReportError(
                    "compatibility missing {!r}".format(key)
                )
            if compatibility[key] is not None:
                _nonempty(
                    compatibility[key],
                    "compatibility.{}".format(key),
                    CapabilityReportError,
                )
        capability_values = _mapping(
            value.get("capabilities"), "capabilities", CapabilityReportError
        )
        capabilities = {
            _nonempty(name, "capability name", CapabilityReportError):
            CapabilityEvidence.from_mapping(str(name), evidence)
            for name, evidence in capability_values.items()
        }
        return cls(
            report_id=_nonempty(value.get("id"), "id", CapabilityReportError),
            harness_id=_nonempty(
                value.get("harnessId"), "harnessId", CapabilityReportError
            ),
            installation_id=_nonempty(
                value.get("installationId"),
                "installationId",
                CapabilityReportError,
            ),
            adapter_version=_nonempty(
                value.get("adapterVersion"),
                "adapterVersion",
                CapabilityReportError,
            ),
            harness_version=_nonempty(
                value.get("harnessVersion"),
                "harnessVersion",
                CapabilityReportError,
            ),
            observed_at=_timestamp(
                value.get("observedAt"), "observedAt", CapabilityReportError
            ),
            compatibility=copy.deepcopy(dict(compatibility)),
            capabilities=copy.deepcopy(capabilities),
            raw=copy.deepcopy(dict(value)),
        )

    def capability_state(
        self, capability: str, at: Optional[datetime] = None
    ) -> str:
        evidence = self.capabilities.get(capability)
        if evidence is None:
            return "unverified"
        return evidence.effective_state(at)


@dataclass(frozen=True)
class HarnessBinding:
    harness_id: str
    installation_id: str


@dataclass(frozen=True)
class ExecutionBackend:
    kind: str
    harness_id: Optional[str]
    installation_id: Optional[str]


@dataclass(frozen=True)
class WorkflowProfile:
    """A provider/model-preserving selection of toolchain components."""

    profile_id: str
    upstream: HarnessBinding
    mode: str
    execution_backend: ExecutionBackend
    roles: Sequence[Mapping[str, Any]]
    raw: Mapping[str, Any] = field(default_factory=dict, compare=False, repr=False)

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "WorkflowProfile":
        value = _mapping(value, "Workflow Profile", ProfileError)
        _schema_version(value, ProfileError)
        upstream = _mapping(value.get("upstream"), "upstream", ProfileError)
        backend = _mapping(
            value.get("executionBackend"), "executionBackend", ProfileError
        )
        mode = _nonempty(value.get("mode"), "mode", ProfileError)
        if mode not in MODES:
            raise ProfileError("invalid mode {!r}".format(mode))
        kind = _nonempty(
            backend.get("kind"), "executionBackend.kind", ProfileError
        )
        if kind not in BACKEND_KINDS:
            raise ProfileError("invalid execution backend {!r}".format(kind))

        roles = value.get("roles", [])
        if not isinstance(roles, list):
            raise ProfileError("roles must be an array")
        normalized_roles: List[Mapping[str, Any]] = []
        role_ids = set()
        for index, role in enumerate(roles):
            role = _mapping(role, "roles[{}]".format(index), ProfileError)
            role_id = _nonempty(
                role.get("id"), "roles[{}].id".format(index), ProfileError
            )
            if role_id in role_ids:
                raise ProfileError("duplicate role id {!r}".format(role_id))
            role_ids.add(role_id)
            model = role.get("model")
            if model is not None:
                model = _mapping(
                    model, "roles[{}].model".format(index), ProfileError
                )
                _nonempty(
                    model.get("providerId"),
                    "roles[{}].model.providerId".format(index),
                    ProfileError,
                )
                # Manual/unknown model IDs are intentionally accepted.
                _nonempty(
                    model.get("modelId"),
                    "roles[{}].model.modelId".format(index),
                    ProfileError,
                )
            normalized_roles.append(copy.deepcopy(dict(role)))

        backend_harness = backend.get("harnessId")
        backend_installation = backend.get("installationId")
        if backend_harness is not None:
            backend_harness = _nonempty(
                backend_harness, "executionBackend.harnessId", ProfileError
            )
        if backend_installation is not None:
            backend_installation = _nonempty(
                backend_installation,
                "executionBackend.installationId",
                ProfileError,
            )

        return cls(
            profile_id=_nonempty(value.get("id"), "id", ProfileError),
            upstream=HarnessBinding(
                harness_id=_nonempty(
                    upstream.get("harnessId"), "upstream.harnessId", ProfileError
                ),
                installation_id=_nonempty(
                    upstream.get("installationId"),
                    "upstream.installationId",
                    ProfileError,
                ),
            ),
            mode=mode,
            execution_backend=ExecutionBackend(
                kind=kind,
                harness_id=backend_harness,
                installation_id=backend_installation,
            ),
            roles=tuple(normalized_roles),
            raw=copy.deepcopy(dict(value)),
        )


@dataclass(frozen=True)
class ModelCatalogEntry:
    """One model identity with source provenance, never an availability claim."""

    provider_id: str
    model_id: str
    display_name: str
    lifecycle: str
    source: str
    observed_at: Optional[datetime]
    harness_id: Optional[str] = None
    reasoning_efforts: Sequence[str] = ()
    capabilities: Mapping[str, Any] = field(default_factory=dict)
    raw: Mapping[str, Any] = field(default_factory=dict, compare=False, repr=False)

    @property
    def identity(self) -> tuple:
        return (self.provider_id, self.harness_id, self.model_id)


@dataclass(frozen=True)
class ModelCatalog:
    """A versioned snapshot from one discovery source."""

    catalog_id: str
    provider_id: str
    source: str
    observed_at: Optional[datetime]
    models: Sequence[ModelCatalogEntry]
    harness_id: Optional[str] = None
    raw: Mapping[str, Any] = field(default_factory=dict, compare=False, repr=False)

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "ModelCatalog":
        value = _mapping(value, "Model Catalog", ModelCatalogError)
        _schema_version(value, ModelCatalogError)
        source = _nonempty(value.get("source"), "source", ModelCatalogError)
        if source not in MODEL_SOURCE_PRIORITY:
            raise ModelCatalogError("invalid model catalog source {!r}".format(source))
        provider_id = _nonempty(
            value.get("providerId"), "providerId", ModelCatalogError
        )
        harness_id = value.get("harnessId")
        if harness_id is not None:
            harness_id = _nonempty(harness_id, "harnessId", ModelCatalogError)
        observed_value = value.get("observedAt")
        if source == "manual":
            observed_at = (
                _timestamp(observed_value, "observedAt", ModelCatalogError)
                if observed_value is not None
                else None
            )
        else:
            observed_at = _timestamp(
                observed_value, "observedAt", ModelCatalogError
            )
        models = value.get("models")
        if not isinstance(models, list):
            raise ModelCatalogError("models must be an array")
        normalized: List[ModelCatalogEntry] = []
        identities = set()
        for index, raw_model in enumerate(models):
            raw_model = _mapping(
                raw_model, "models[{}]".format(index), ModelCatalogError
            )
            model_id = _nonempty(
                raw_model.get("modelId"),
                "models[{}].modelId".format(index),
                ModelCatalogError,
            )
            if model_id in identities:
                raise ModelCatalogError(
                    "duplicate modelId {!r} in one catalog".format(model_id)
                )
            identities.add(model_id)
            lifecycle = raw_model.get("lifecycle", "unknown")
            if lifecycle not in MODEL_LIFECYCLES:
                raise ModelCatalogError(
                    "models[{}] has invalid lifecycle {!r}".format(
                        index, lifecycle
                    )
                )
            efforts = raw_model.get("reasoningEfforts", [])
            if not isinstance(efforts, list) or not all(
                isinstance(item, str) and item.strip() for item in efforts
            ):
                raise ModelCatalogError(
                    "models[{}].reasoningEfforts must be an array of strings".format(
                        index
                    )
                )
            model_capabilities = raw_model.get("capabilities", {})
            model_capabilities = _mapping(
                model_capabilities,
                "models[{}].capabilities".format(index),
                ModelCatalogError,
            )
            normalized.append(ModelCatalogEntry(
                provider_id=provider_id,
                harness_id=harness_id,
                model_id=model_id,
                display_name=_nonempty(
                    raw_model.get("displayName", model_id),
                    "models[{}].displayName".format(index),
                    ModelCatalogError,
                ),
                lifecycle=lifecycle,
                source=source,
                observed_at=observed_at,
                reasoning_efforts=tuple(efforts),
                capabilities=copy.deepcopy(dict(model_capabilities)),
                raw=copy.deepcopy(dict(raw_model)),
            ))
        return cls(
            catalog_id=_nonempty(value.get("id"), "id", ModelCatalogError),
            provider_id=provider_id,
            harness_id=harness_id,
            source=source,
            observed_at=observed_at,
            models=tuple(normalized),
            raw=copy.deepcopy(dict(value)),
        )


def manual_model_entry(
    provider_id: str,
    model_id: str,
    harness_id: Optional[str] = None,
    display_name: Optional[str] = None,
) -> ModelCatalogEntry:
    """Create a lossless entry for a model absent from every known catalog."""

    provider_id = _nonempty(provider_id, "provider_id", ModelCatalogError)
    model_id = _nonempty(model_id, "model_id", ModelCatalogError)
    if harness_id is not None:
        harness_id = _nonempty(harness_id, "harness_id", ModelCatalogError)
    return ModelCatalogEntry(
        provider_id=provider_id,
        harness_id=harness_id,
        model_id=model_id,
        display_name=display_name or model_id,
        lifecycle="unknown",
        source="manual",
        observed_at=None,
        raw={"modelId": model_id, "source": "manual"},
    )


def merge_model_catalogs(
    catalogs: Iterable[ModelCatalog],
    manual_entries: Iterable[ModelCatalogEntry] = (),
) -> List[ModelCatalogEntry]:
    """Merge catalogs by documented precedence without dropping manual IDs."""

    selected: Dict[tuple, ModelCatalogEntry] = {}
    for entry in manual_entries:
        selected[entry.identity] = entry
    for catalog in catalogs:
        for entry in catalog.models:
            previous = selected.get(entry.identity)
            if previous is None:
                selected[entry.identity] = entry
                continue
            new_priority = MODEL_SOURCE_PRIORITY[entry.source]
            previous_priority = MODEL_SOURCE_PRIORITY[previous.source]
            if new_priority > previous_priority:
                selected[entry.identity] = entry
            elif new_priority == previous_priority:
                new_time = entry.observed_at or datetime.min.replace(
                    tzinfo=timezone.utc
                )
                previous_time = previous.observed_at or datetime.min.replace(
                    tzinfo=timezone.utc
                )
                if new_time > previous_time:
                    selected[entry.identity] = entry
    return sorted(
        selected.values(),
        key=lambda item: (
            item.provider_id,
            item.harness_id or "",
            item.model_id,
        ),
    )


@dataclass(frozen=True)
class ActivationReceipt:
    """Minimal durable identity for transactional activation and rollback."""

    receipt_id: str
    profile_id: str
    state: str
    created_at: datetime
    adapter_versions: Mapping[str, str]
    changes: Sequence[Mapping[str, Any]]
    backup: Mapping[str, Any]
    verification: Mapping[str, Any]
    raw: Mapping[str, Any] = field(default_factory=dict, compare=False, repr=False)

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "ActivationReceipt":
        value = _mapping(value, "Activation Receipt", ActivationReceiptError)
        _schema_version(value, ActivationReceiptError)
        state = value.get("state")
        if state not in {"committed", "failed", "rolled-back"}:
            raise ActivationReceiptError("invalid activation state {!r}".format(state))
        changes = value.get("changes")
        if not isinstance(changes, list):
            raise ActivationReceiptError("changes must be an array")
        for index, change in enumerate(changes):
            change = _mapping(
                change, "changes[{}]".format(index), ActivationReceiptError
            )
            for key in (
                "path", "operation", "beforeHash", "afterHash", "ownedByReceipt"
            ):
                if key not in change:
                    raise ActivationReceiptError(
                        "changes[{}] missing {!r}".format(index, key)
                    )
            _nonempty(
                change["path"],
                "changes[{}].path".format(index),
                ActivationReceiptError,
            )
            if change["operation"] not in {"create", "update", "delete"}:
                raise ActivationReceiptError(
                    "changes[{}] has invalid operation {!r}".format(
                        index, change["operation"]
                    )
                )
            _boolean(
                change["ownedByReceipt"],
                "changes[{}].ownedByReceipt".format(index),
                ActivationReceiptError,
            )

        adapter_versions = _mapping(
            value.get("adapterVersions"),
            "adapterVersions",
            ActivationReceiptError,
        )
        if not adapter_versions:
            raise ActivationReceiptError("adapterVersions must not be empty")
        for harness_id, version in adapter_versions.items():
            _nonempty(harness_id, "adapterVersions key", ActivationReceiptError)
            _nonempty(
                version,
                "adapterVersions.{}".format(harness_id),
                ActivationReceiptError,
            )

        backup = _mapping(value.get("backup"), "backup", ActivationReceiptError)
        for key in ("available", "location", "contentHash"):
            if key not in backup:
                raise ActivationReceiptError("backup missing {!r}".format(key))
        _boolean(backup["available"], "backup.available", ActivationReceiptError)
        for key in ("location", "contentHash"):
            if backup[key] is not None:
                _nonempty(
                    backup[key], "backup.{}".format(key), ActivationReceiptError
                )

        verification = _mapping(
            value.get("verification"), "verification", ActivationReceiptError
        )
        if verification.get("status") not in {"passed", "failed", "unknown"}:
            raise ActivationReceiptError(
                "invalid verification status {!r}".format(
                    verification.get("status")
                )
            )
        if not isinstance(verification.get("checks"), list):
            raise ActivationReceiptError("verification.checks must be an array")
        return cls(
            receipt_id=_nonempty(
                value.get("id"), "id", ActivationReceiptError
            ),
            profile_id=_nonempty(
                value.get("profileId"), "profileId", ActivationReceiptError
            ),
            state=state,
            created_at=_timestamp(
                value.get("createdAt"), "createdAt", ActivationReceiptError
            ),
            adapter_versions=copy.deepcopy(dict(adapter_versions)),
            changes=tuple(copy.deepcopy(changes)),
            backup=copy.deepcopy(dict(backup)),
            verification=copy.deepcopy(dict(verification)),
            raw=copy.deepcopy(dict(value)),
        )


class HarnessAdapter(Protocol):
    """Minimum implementation boundary for a Harness plugin.

    Methods use mappings so adapters can evolve independently while their wire
    artifacts remain governed by versioned JSON Schemas.
    """

    @property
    def manifest(self) -> HarnessManifest:
        ...

    def detect(self) -> Sequence[Mapping[str, Any]]:
        ...

    def probe(self, installation: Mapping[str, Any]) -> CapabilityReport:
        ...

    def discover_models(
        self, installation: Mapping[str, Any]
    ) -> ModelCatalog:
        ...

    def read_configuration(
        self, installation: Mapping[str, Any]
    ) -> Mapping[str, Any]:
        ...

    def plan_activation(self, profile: WorkflowProfile) -> Mapping[str, Any]:
        ...

    def validate_activation(self, plan: Mapping[str, Any]) -> Mapping[str, Any]:
        ...

    def apply_activation(self, plan: Mapping[str, Any]) -> ActivationReceipt:
        ...

    def rollback(self, receipt: ActivationReceipt) -> ActivationReceipt:
        ...


class ProviderAdapter(Protocol):
    """Optional model discovery boundary independent of any Harness."""

    @property
    def provider_id(self) -> str:
        ...

    def discover_models(
        self, context: Optional[Mapping[str, Any]] = None
    ) -> ModelCatalog:
        ...


class DownstreamHarnessAdapter(HarnessAdapter, Protocol):
    """Optional execution surface for Overnight and Balanced downstreams."""

    def dispatch(self, request: Mapping[str, Any]) -> Mapping[str, Any]:
        ...

    def resume(self, handle: Mapping[str, Any]) -> Mapping[str, Any]:
        ...

    def status(self, handle: Mapping[str, Any]) -> Mapping[str, Any]:
        ...

    def interrupt(self, handle: Mapping[str, Any]) -> Mapping[str, Any]:
        ...

    def collect_usage(
        self, handle: Mapping[str, Any]
    ) -> Sequence[Mapping[str, Any]]:
        ...


class HarnessRegistry:
    """Deterministic registry for declarative and executable extensions."""

    def __init__(self) -> None:
        self._manifests: Dict[str, HarnessManifest] = {}
        self._adapters: Dict[str, HarnessAdapter] = {}

    def register_manifest(self, manifest: HarnessManifest) -> None:
        if manifest.harness_id in self._manifests:
            raise DuplicateHarnessError(
                "Harness {!r} is already registered".format(manifest.harness_id)
            )
        self._manifests[manifest.harness_id] = manifest

    def register_adapter(self, adapter: HarnessAdapter) -> None:
        manifest = adapter.manifest
        if not isinstance(manifest, HarnessManifest):
            raise ManifestError("adapter.manifest must be a HarnessManifest")
        self.register_manifest(manifest)
        self._adapters[manifest.harness_id] = adapter

    def manifest(self, harness_id: str) -> Optional[HarnessManifest]:
        return self._manifests.get(harness_id)

    def adapter(self, harness_id: str) -> Optional[HarnessAdapter]:
        return self._adapters.get(harness_id)

    def list_manifests(self, position: Optional[str] = None) -> List[HarnessManifest]:
        if position not in {None, "upstream", "downstream"}:
            raise ValueError("position must be upstream, downstream, or None")
        values = list(self._manifests.values())
        if position == "upstream":
            values = [value for value in values if value.can_be_upstream]
        elif position == "downstream":
            values = [value for value in values if value.can_be_downstream]
        return sorted(values, key=lambda value: value.harness_id)


@dataclass(frozen=True)
class CompatibilityIssue:
    severity: str
    code: str
    message: str
    harness_id: Optional[str] = None
    capability: Optional[str] = None


@dataclass(frozen=True)
class CompatibilityResult:
    issues: Sequence[CompatibilityIssue]

    @property
    def compatible(self) -> bool:
        return not any(issue.severity == "error" for issue in self.issues)


def _latest_reports(
    reports: Iterable[CapabilityReport],
) -> Dict[tuple, CapabilityReport]:
    latest: Dict[tuple, CapabilityReport] = {}
    for report in reports:
        key = (report.harness_id, report.installation_id)
        current = latest.get(key)
        if current is None or report.observed_at > current.observed_at:
            latest[key] = report
    return latest


def _capability_issue(
    manifest: HarnessManifest,
    installation_id: str,
    report: Optional[CapabilityReport],
    capability: str,
    at: Optional[datetime],
) -> Optional[CompatibilityIssue]:
    declared = manifest.capabilities.get(capability, "unverified")
    if declared == "unsupported":
        state = "unsupported"
    elif declared in {"unverified", "degraded"}:
        state = declared
    elif report is None or report.adapter_version != manifest.adapter_version:
        state = "unverified"
    else:
        state = report.capability_state(capability, at)
    if state == "supported":
        return None
    return CompatibilityIssue(
        severity="error",
        code="required-capability-{}".format(state),
        message=(
            "Harness {!r} installation {!r} requires capability {!r}, "
            "but its effective state is {!r}."
        ).format(manifest.harness_id, installation_id, capability, state),
        harness_id=manifest.harness_id,
        capability=capability,
    )


def evaluate_profile_compatibility(
    profile: WorkflowProfile,
    registry: HarnessRegistry,
    reports: Iterable[CapabilityReport] = (),
    at: Optional[datetime] = None,
) -> CompatibilityResult:
    """Fail closed when a Profile lacks current, installation-bound evidence."""

    issues: List[CompatibilityIssue] = []
    report_index = _latest_reports(reports)
    upstream_manifest = registry.manifest(profile.upstream.harness_id)
    if upstream_manifest is None:
        issues.append(CompatibilityIssue(
            "error", "upstream-not-registered",
            "Upstream Harness {!r} is not registered.".format(
                profile.upstream.harness_id
            ),
            profile.upstream.harness_id,
        ))
        return CompatibilityResult(tuple(issues))
    if not upstream_manifest.can_be_upstream:
        issues.append(CompatibilityIssue(
            "error", "upstream-role-unsupported",
            "Harness {!r} cannot be used as an upstream.".format(
                upstream_manifest.harness_id
            ),
            upstream_manifest.harness_id,
        ))

    upstream_report = report_index.get(
        (profile.upstream.harness_id, profile.upstream.installation_id)
    )
    for capability in MODE_CAPABILITY_REQUIREMENTS[profile.mode]["upstream"]:
        issue = _capability_issue(
            upstream_manifest,
            profile.upstream.installation_id,
            upstream_report,
            capability,
            at,
        )
        if issue:
            issues.append(issue)

    backend = profile.execution_backend
    if profile.mode == "interactive":
        if backend.kind != "native-subagents":
            issues.append(CompatibilityIssue(
                "error", "interactive-requires-native-subagents",
                "Interactive mode requires the native-subagents execution backend.",
                upstream_manifest.harness_id,
                "nativeSubagents",
            ))
        if backend.harness_id not in {None, profile.upstream.harness_id}:
            issues.append(CompatibilityIssue(
                "error", "interactive-cross-harness-backend",
                "Interactive native subagents must belong to the selected upstream Harness.",
                backend.harness_id,
                "nativeSubagents",
            ))
        return CompatibilityResult(tuple(issues))

    if backend.kind != "external-harness":
        issues.append(CompatibilityIssue(
            "error", "delegated-mode-requires-external-harness",
            "{} mode requires an external downstream Harness.".format(
                profile.mode.capitalize()
            ),
        ))
        return CompatibilityResult(tuple(issues))
    if backend.harness_id is None or backend.installation_id is None:
        issues.append(CompatibilityIssue(
            "error", "downstream-binding-missing",
            "External executionBackend requires harnessId and installationId.",
        ))
        return CompatibilityResult(tuple(issues))

    downstream_manifest = registry.manifest(backend.harness_id)
    if downstream_manifest is None:
        issues.append(CompatibilityIssue(
            "error", "downstream-not-registered",
            "Downstream Harness {!r} is not registered.".format(backend.harness_id),
            backend.harness_id,
        ))
        return CompatibilityResult(tuple(issues))
    if not downstream_manifest.can_be_downstream:
        issues.append(CompatibilityIssue(
            "error", "downstream-role-unsupported",
            "Harness {!r} cannot be used as a downstream.".format(
                downstream_manifest.harness_id
            ),
            downstream_manifest.harness_id,
        ))

    downstream_report = report_index.get(
        (backend.harness_id, backend.installation_id)
    )
    for capability in MODE_CAPABILITY_REQUIREMENTS[profile.mode]["downstream"]:
        issue = _capability_issue(
            downstream_manifest,
            backend.installation_id,
            downstream_report,
            capability,
            at,
        )
        if issue:
            issues.append(issue)
    return CompatibilityResult(tuple(issues))
