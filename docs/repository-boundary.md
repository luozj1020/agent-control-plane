# Embedded Workflow Core Boundary

Agent Control Plane is one product and one repository. The former
`ai-coding-workflow` implementation now lives inside
`packages/workflow-core`; it is not a sibling repository or runtime dependency.

```text
agent-control-plane
  packages/workflow-core
    owns: modes, Task Card, runtime/review states, wake/evidence semantics,
          Python runtime tools, schemas, installation assets
           |
           | versioned embedded Workflow Contract
           v
  packages/contracts + apps/web
    owns: selection, profiles, agent/Harness binding, activation, rollback,
          usage, UI, compatibility checks and JS Runner projections
```

## Authority and compatibility

- `packages/workflow-core/contracts/workflow-contract-v1.json` is the canonical
  machine boundary inside the product.
- ACP supports Contract schema 1 and Contract 1.1 or newer within major version
  1. Contract 1.1 includes Task Card and Runner projections.
- Startup verifies every declared Schema hash and checks the embedded JS Runner
  protocol against the canonical projection.
- A missing core, unsupported Contract, invalid binding, or incompatible
  projection fails closed. There is no external source discovery and no second
  Web-owned Task Card Schema.
- Contract v1 is additive within its major version. Removing or changing a
  state, decision, invariant, or Schema binding requires a new major version.

## Maintenance rule

New workflow semantics are changed in `packages/workflow-core` first and
exported through its Contract. The Web control plane then consumes that
projection. Balanced and Overnight resolve lifecycle states, evidence outcomes,
terminal states, strategies, and review decisions from the embedded Contract;
run metadata records its version and SHA-256.

The constants in `apps/web/workflow-runtime-protocol.mjs` are only a safety
default for isolated module use. Synchronization checks make the product
incompatible if those constants drift from the embedded Contract.

The former standalone checkout may remain temporarily for history or migration,
but building, starting, testing, and using Agent Control Plane must not read it.
