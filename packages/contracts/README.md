# Contracts

Versioned workflow-Skill contracts shared by the UI, product-owned mode
registry, Skill catalog, projection engine, and target adapters. The product
resolves one mode plus its selected agent bindings into a minimal effective
Skill variant; inactive modes and unused adapters are excluded. It does not
supervise agent runs.

Current public surface:

- immutable Overnight, Balanced, and Interactive mode Skill templates;
- versioned Balanced tuned-window policies;
- agent, profile, role-binding, and effective-Skill contracts;
- fail-closed compatibility and raw-credential validation;
- deterministic single-mode `SKILL.md` rendering;
- pure activation planning that deactivates other managed workflow Skills.

```bash
npm run typecheck
npm test
npm run build
```
