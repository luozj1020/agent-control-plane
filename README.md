# Agent Control Plane

Agent Control Plane is a local-first product for composing, running, recovering,
and reviewing teams of interchangeable coding agents.

The product separates five concerns that must not be conflated:

- agent runtimes such as Codex, Claude Code, Gemini CLI, OpenCode, or custom ACP clients;
- model and connection profiles, including gateways such as CC-Switch;
- task roles such as main agent, subagent, reviewer, tester, and planner;
- team templates that bind profiles to roles;
- declarative execution modes such as Overnight, Balanced, and Interactive.

The initial implementation is web-first and desktop-ready. Runtime protocols and
domain contracts are stabilized before choosing a Tauri or other desktop shell.

## Status

Early product development. The first milestone defines the versioned contracts
used by the daemon, UI, CLI, and runtime adapters.

