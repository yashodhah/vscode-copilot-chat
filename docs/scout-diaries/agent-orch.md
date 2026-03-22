

Great question — this touches on the intersection of the Azure AI agent design patterns and how the VS Code Copilot Chat extension's agent system is architected. Let me examine the actual agent orchestration in the codebase first.

Search complete: Agent orchestration patterns

Searched for regex `agent.*register|registerAgent|agent.*participant`, 30 results

Searched for regex `sub.?agent|subAgent|sub_agent`, 30 results

Searched for regex `agent.*mode|agentMode|agent_mode`, 30 results

Searched for files matching `**/chatParticipants.ts`, 1 match

Searched for files matching `**/chatAgents.ts`, 1 match

Searched for files matching `**/toolCallingLoop*`, 4 matches

Searched for files matching `**/*subagent*`, 1 match

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/src/platform/chat/common/chatAgents.ts)

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/src/extension/conversation/vscode-node/chatParticipants.ts#1-1), lines 1 to 100

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/src/extension/intents/node/toolCallingLoop.ts#1-1), lines 1 to 100

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/src/extension/chatSessions/claude/node/hooks/subagentHooks.ts)

Search complete: Sub-agent and switch agent

Searched for text `runSubagent`, 44 results

Searched for text `switch_agent`, 3 results

Searched for regex `subagent`, 200 results

Searched for regex `SwitchAgent|switch_agent` (`**/src/**/*.ts`), 16 results

Searched for regex `CoreRunSubagent|runSubagent` (`**/src/extension/tools/**/*.ts`), 5 results

Searched for regex `search_subagent|SearchSubagent` (`**/src/extension/tools/**/*.ts`), 23 results

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/src/extension/tools/vscode-node/switchAgentTool.ts)

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/src/extension/tools/node/searchSubagentTool.ts)

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/src/extension/tools/common/toolNames.ts#55-55), lines 55 to 80

Search complete: Custom agent .agent.md files

Searched for files matching `**/*.agent.md`, no matches

Searched for regex `agent\.md`, 62 results

Searched for text `agentProvider`, 87 results

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/assets/prompts/skills/agent-customization/references/agents.md#1-1), lines 1 to 100

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/src/extension/vscode.proposed.chatPromptFiles.d.ts#1-1), lines 1 to 160

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/src/platform/customInstructions/common/promptTypes.ts)

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/src/extension/agents/vscode-node/promptFileContrib.ts#1-1), lines 1 to 80

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/src/extension/agents/vscode-node/agentTypes.ts#1-1), lines 1 to 100

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/src/extension/agents/vscode-node/agentTypes.ts#100-100), lines 100 to 121

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/src/extension/agents/vscode-node/askAgentProvider.ts)

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/src/extension/agents/vscode-node/planAgentProvider.ts)

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/src/extension/agents/vscode-node/exploreAgentProvider.ts)

Read [](file:///Users/yashodhah/TheCloudPlumbingCo/AI/copilot/vscode-copilot-chat/src/extension/agents/vscode-node/githubOrgCustomAgentProvider.ts#1-1), lines 1 to 120

This is a great question. Let me map the **Azure AI agent design patterns** to what's actually available in the VS Code Copilot extension, and clarify what's built-in vs. what you'd build yourself.

---

## Who Provides What?

The orchestration is a **layered system** — some patterns are provided by Copilot/VS Code core, while others you build via custom agents:

| Layer | Provider | What It Gives You |
|-------|----------|-------------------|
| **Tool-calling loop** | Copilot Chat extension (built-in) | The core `ToolCallingLoop` in toolCallingLoop.ts — handles LLM → tool → LLM cycles, token budgets, conversation compaction |
| **Intent detection** | Copilot Chat extension (built-in) | Classifies user messages into 24+ intents, routes to the right prompt/handler |
| **Custom agents (`.agent.md`)** | **You** (workspace/user level) | `.github/agents/*.agent.md` files with tool restrictions, custom prompts, model selection |
| **Sub-agent spawning** | VS Code core + Copilot extension | `runSubagent` and `search_subagent` tools, the `agents` attribute on `.agent.md` |
| **Hooks** | VS Code core | Lifecycle hooks (`SessionStart`, `Stop`, `SubagentStart`, etc.) via `.github/hooks/` |

---

## Agent Design Patterns You Can Use

Here's how the [Azure AI agent design patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns) map to what's available:

### 1. **Single Agent (ReAct / Tool-Use Loop)** — Built-in

This is what the default **Agent Mode** already does. The `ToolCallingLoop` implements a classic ReAct pattern:

```
LLM reasons → calls tool(s) → observes results → reasons again → repeats
```

The built-in agent has access to 40+ tools (file read/write, terminal, search, etc.) and handles up to 200 iterations with conversation compaction. **You don't need custom agents for this.**

### 2. **Multi-Agent / Delegation (Orchestrator Pattern)** — Custom Agents

This is where custom agents shine. The extension already implements this pattern with built-in agents:

| Agent | Role | Defined In |
|-------|------|-----------|
| **Plan** | Read-only planner, delegates to Explore | planAgentProvider.ts |
| **Explore** | Fast read-only search subagent | exploreAgentProvider.ts |
| **Ask** | Read-only Q&A | askAgentProvider.ts |
| **Edit** | Restricted to active file only | editModeAgentProvider.ts |

The orchestration mechanism is the `agents` frontmatter attribute + the `agent` tool alias:

```yaml
# .github/agents/orchestrator.agent.md
---
description: "Coordinates complex multi-step tasks"
tools: [read, edit, search, agent]    # 'agent' enables subagent invocation
agents: [Explore, Reviewer, Tester]   # restrict which subagents can be called
---
```

The LLM dynamically decides when to delegate to a subagent based on the subagent's `description`.

`★ Insight ─────────────────────────────────────`
The `agents: [...]` attribute is a **security/scope boundary**, not just routing. It prevents the orchestrator from invoking arbitrary subagents. Omitting it allows all agents; `agents: []` blocks all subagent calls. The Explore agent sets `agents: []` and `user-invocable: false` — it's a pure worker that can't delegate further or be selected by users directly.
`─────────────────────────────────────────────────`

### 3. **Handoff Pattern** — Built-in via `handoffs`

Agents can define explicit handoffs to other agents, which render as buttons in the UI:

```yaml
handoffs:
  - label: Start Implementation
    agent: agent                   # hand off to default Agent Mode
    prompt: 'Start implementation'
    send: true                     # auto-send the prompt
    model: gpt-4o                  # optionally override model
```

The Plan agent uses this: it researches and plans, then offers a "Start Implementation" button that hands off to the full Agent Mode. This is a **structured transition** rather than dynamic delegation.

### 4. **Specialization (Tool-Restricted Agents)** — Custom Agents

The key reason to create custom agents is **tool restriction for safety and focus**:

```yaml
# Read-only research agent — can NEVER modify files
tools: [read, search, web]

# Edit-only agent — restricted to active file
tools: [read, edit]

# CI integration agent — only terminal + search
tools: [execute, search, read]
```

`★ Insight ─────────────────────────────────────`
Tool restriction is the single most impactful pattern for custom agents. The built-in Agent Mode has access to **everything** (40+ tools). A custom agent that can only `[read, search]` is fundamentally safer for tasks like code review — it literally cannot edit files or run commands, providing a hard guarantee no side effects occur.
`─────────────────────────────────────────────────`

### 5. **Parallelism** — Built-in for Subagents

The extension supports parallel subagent invocation. From toolCalling.tsx, `runSubagent` is in the `toolsCalledInParallel` set. The Plan agent's body explicitly says:

> *"When the task spans multiple independent areas, launch 2-3 Explore subagents in parallel"*

Each subagent gets its own conversation, own tool loop, and own trajectory tracking (linked back to the parent via `subAgentInvocationId`).

### 6. **Hooks (Guardrails / Policy Enforcement)** — VS Code Core

The hook system provides lifecycle interception:

| Hook | Pattern | Use Case |
|------|---------|----------|
| `SessionStart` | Pre-flight injection | Add context before agent starts |
| `Stop` | Guardrail / quality gate | Block agent from stopping if tests fail |
| `PreToolUse` | Policy enforcement | Block dangerous tool calls |
| `SubagentStart/Stop` | Subagent lifecycle | Inject context into subagents |

---

## Why Custom Agents Over the Built-in Agent?

| Need | Built-in Agent | Custom Agent |
|------|---------------|--------------|
| General coding tasks | ✅ Full tool access, intent detection | Unnecessary overhead |
| **Safety boundaries** (read-only review) | ❌ Can't restrict tools | ✅ `tools: [read, search]` |
| **Domain specialization** (security auditor, DB migration) | ❌ Generic prompt | ✅ Custom system prompt + tool set |
| **Multi-step workflows** (plan → explore → implement) | ❌ Single agent does everything | ✅ Orchestrator delegates to specialists |
| **Model optimization** (use cheap model for search) | ❌ Same model for everything | ✅ `model: 'Claude Haiku 4.5'` per agent |
| **Org-wide policy** (standard agents across repos) | ❌ Per-user only | ✅ GitHub org agents via githubOrgCustomAgentProvider.ts |
| **Context isolation** (subagent gets clean conversation) | ❌ Everything in one context window | ✅ Subagents have separate conversations |

`★ Insight ─────────────────────────────────────`
Context isolation is an underappreciated benefit. The built-in agent's context window accumulates **all** tool results, which can hit token limits on complex tasks (triggering expensive conversation compaction). Delegating search-heavy work to an Explore subagent keeps the parent's context clean — only the subagent's final answer flows back, not the 20 intermediate `grep_search` results.
`─────────────────────────────────────────────────`

---

## Summary

The **orchestration infrastructure** (tool-calling loop, sub-agent spawning, hooks, trajectory tracking) is **provided by VS Code + Copilot**. What you define as a custom agent is the **policy layer on top**: which tools are available, what the system prompt says, which model to use, and how agents delegate to each other. Think of it as:

- **Copilot provides**: the engine (tool loop, token management, context injection)
- **You provide**: the blueprints (`.agent.md` files defining roles, constraints, and workflows)