# Context Injection Analysis: VS Code Copilot Chat Extension

> **Purpose**: Deep-dive analysis of how context (code, files, diagnostics, selections, workspace info, etc.) is collected and injected into LLM prompts across the extension's three primary modes: **Chat Panel**, **Inline Chat/Edit**, and **Agent Mode**.

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Context Types Inventory](#2-context-types-inventory)
3. [Chat Panel Mode](#3-chat-panel-mode)
4. [Inline Chat/Edit Mode](#4-inline-chatedit-mode)
5. [Agent Mode](#5-agent-mode)
6. [Token Budget & Prioritization (prompt-tsx)](#6-token-budget--prioritization-prompt-tsx)
7. [Context Engineering Patterns Analysis](#7-context-engineering-patterns-analysis)
8. [Flow Diagrams](#8-flow-diagrams)

---

## 1. High-Level Architecture

Every chat request in the extension follows the same fundamental pipeline:

```
User Input
  → ChatParticipantRequestHandler (selects intent, infers document context)
    → IntentDetector (classifies: ask, fix, explain, agent, inline, etc.)
      → Intent.invoke() → IIntentInvocation (builds prompt via prompt-tsx)
        → PromptRenderer (fits context to token budget using priority/flex)
          → LLM API Call
            → Response Processing (streaming edits, markdown, tool calls)
```

### Key Orchestration Files

| File | Role |
|------|------|
| `src/extension/prompt/node/chatParticipantRequestHandler.ts` | Main request orchestrator — selects intent, infers `IDocumentContext`, creates `Conversation` |
| `src/extension/prompt/node/intentDetector.tsx` | Classifies user intent (explain, fix, edit, agent, etc.) using a fast LLM call |
| `src/extension/prompt/node/defaultIntentRequestHandler.ts` | Runs intent invocation + tool-calling loop |
| `src/extension/prompt/node/documentContext.ts` | `IDocumentContext` — captures active document, selection, visible ranges, indent info |
| `src/extension/prompts/node/base/promptRenderer.ts` | Wraps `@vscode/prompt-tsx` renderer with dependency injection |

### The `IBuildPromptContext` Interface

Every prompt component receives an `IBuildPromptContext` object (defined in `src/extension/prompt/common/intents.ts`) containing:

- `query` — the user's message text
- `history` — previous conversation turns
- `chatVariables` — resolved `#file`, `#selection`, `#codebase` references (a `ChatVariablesCollection`)
- `tools` — available tool information, tool references, and invocation tokens
- `toolCallRounds` / `toolCallResults` — accumulated tool call history (agent mode)
- `conversation` — full `Conversation` object with all turns and metadata
- `modeInstructions` — custom mode instructions (e.g., from `.github/copilot-instructions.md`)
- `editedFileEvents` — files the user manually edited since last agent action
- `request` — the raw VS Code `ChatRequest`

---

## 2. Context Types Inventory

### Static Context (included at prompt construction time)

| Context Type | Source | Collection Mechanism | Injected Via | Priority |
|---|---|---|---|---|
| **System identity + safety rules** | Hardcoded | Prompt component | `<SystemMessage>` | 1000 |
| **Active file path + cursor position** | Editor API | `ITabsAndEditorsService.activeTextEditor` | `CurrentEditorContext` component | — |
| **Active file content + selection** | Editor API | `IDocumentContext.inferDocumentContext()` from `request.location2` | Varies by mode | — |
| **File indent info** | Editor API | `editor.options.insertSpaces/tabSize` | `IDocumentContext.fileIndentInfo` | — |
| **Visible range / whole range** | Editor API | `editor.visibleRanges` union | `IDocumentContext.wholeRange` | — |
| **Code around selection (inline)** | TreeSitter + line expansion | `getSelectionAndCodeAroundSelection()` | `SummarizedDocumentWithSelection` | 900 |
| **File outline (collapsed bodies)** | TreeSitter AST | `removeBodiesOutsideRange()` | `SummarizedDocumentSplit` | — |
| **Chat variables (#file, #selection, etc.)** | User attachments via VS Code UI | `ChatVariablesCollection` from `request.references` | `ChatVariables` / `ChatVariablesAndQuery` component | 898-900 |
| **Conversation history** | Prior turns | `Conversation` object reconstructed from `rawHistory` | `ConversationHistory` / `HistoryWithInstructions` | 700 |
| **User preferences** | Persistent file | `copilotUserPreferences.md` in global storage | `UserPreferences` component | 800 |
| **Custom instructions** | `.github/copilot-instructions.md`, settings, prompt instructions variable | `ICustomInstructionsService` | `CustomInstructions` component | 725-750 |
| **Mode instructions** | VS Code chat modes | `promptContext.modeInstructions` | `<Tag name='modeInstructions'>` in agent prompt | — |
| **Workspace structure** | File tree walk | `AgentMultirootWorkspaceStructure` | `GlobalAgentContext` component | — |
| **Workspace folders** | `IWorkspaceService.getWorkspaceFolders()` | Direct service call | `WorkspaceFoldersHint` component | 800 |
| **OS info** | `IEnvService.OS` | Direct service call | `UserOSPrompt` component | — |
| **Current date** | `new Date()` | Direct | `CurrentDatePrompt` component | — |
| **Project labels** | Experiment-gated | `ProjectLabels` component | Panel/inline prompts | 600 |
| **Memory (user/session/repo)** | Persistent file storage + Copilot API | `MemoryContextPrompt` (max 200 lines for user memory) | `GlobalAgentContext` (agent mode only) | — |
| **Terminal state** | Terminal API | `TerminalStatePromptElement` | Agent user message | — |
| **Todo list** | Session state | `TodoListContextPrompt` | Agent user message | — |
| **Edited file events** | VS Code file watcher | `request.editedFileEvents` | `EditedFileEvents` component | — |
| **Language server context** | LSP | `LanguageServerContextPrompt` | Inline prompts | 700 |
| **Notebook cell context** | Notebook API | `generateNotebookCellContext()` | Notebook-specific inline prompts | — |
| **Task definitions** | `.vscode/tasks.json` | `ITasksService.getTasks()` | `AgentTasksInstructions` (2000 token limit) | — |

### Dynamic Context (fetched on-demand via tools in Agent Mode)

| Tool Name | What It Provides | Tool ID |
|---|---|---|
| `read_file` | File contents with line numbers | `ReadFile` |
| `file_search` | Find files by glob pattern | `FindFiles` |
| `grep_search` | Search file contents by regex | `FindTextInFiles` |
| `list_dir` | Directory listing | `ListDirectory` |
| `get_errors` | LSP diagnostics | `GetErrors` |
| `get_changed_files` | Git SCM changes | `GetScmChanges` |
| `search_workspace_symbols` | Symbol search across workspace | `SearchWorkspaceSymbols` |
| `semantic_search` | Codebase semantic search | `Codebase` |
| `read_project_structure` | Project structure overview | `ReadProjectStructure` |
| `run_in_terminal` | Terminal command execution + output | `CoreRunInTerminal` |
| `get_terminal_output` | Read terminal output | `CoreGetTerminalOutput` |
| `fetch_webpage` | Web page content | `FetchWebPage` |
| `github_repo` | GitHub repository data | `GithubRepo` |
| `memory` | Read/write persistent memory | `Memory` |
| `runTests` | Test execution results | `CoreRunTest` |
| `get_task_output` | VS Code task output | `CoreGetTaskOutput` |
| `runSubagent` | Spawn sub-agent for isolated tasks | `CoreRunSubagent` |

---

## 3. Chat Panel Mode

**Intent**: `Intent.Unknown` (default ask) or specific intents like `Intent.Fix`
**Prompt class**: `PanelChatBasePrompt` (`src/extension/prompts/node/panel/panelChatBasePrompt.tsx`)
**Invocation**: `GenericPanelIntentInvocation` (`src/extension/context/node/resolvers/genericPanelIntentInvocation.ts`)

### Prompt Structure

```
┌─ SystemMessage (priority=1000) ─────────────────────────────┐
│  "You are an AI programming assistant."                      │
│  CopilotIdentityRules                                        │
│  SafetyRules                                                 │
│  Capabilities (location=Panel)                               │
│  WorkspaceFoldersHint (priority=800, flexGrow=1)             │
│  Current date                                                │
└──────────────────────────────────────────────────────────────┘
┌─ HistoryWithInstructions ────────────────────────────────────┐
│  InstructionMessage (priority=1000):                         │
│    - Markdown formatting rules                               │
│    - Code block rules                                        │
│    - IDE context description                                 │
│    - Response translation rules                              │
│    - Codebase tool instructions (if #codebase attached)      │
│  ConversationHistory (priority=700):                         │
│    - TokenLimit max=32768                                    │
│    - PrioritizedList, descending=false (oldest first)        │
│    - Deduplicates variables across turns                     │
└──────────────────────────────────────────────────────────────┘
┌─ UserMessage (flexGrow=2) ──────────────────────────────────┐
│  ProjectLabels (priority=600, experiment-gated)              │
│  CustomInstructions (priority=750)                           │
│  ChatToolReferences (priority=899, flexGrow=2):              │
│    - Invokes #-referenced tools, renders results inline      │
│  ChatVariablesAndQuery (priority=900, flexGrow=3):           │
│    - File attachments with content in fenced code blocks     │
│    - Folder attachments with file trees                      │
│    - Image attachments                                       │
│    - Diagnostic attachments                                  │
│    - Prompt files (.prompt.md)                               │
│    - User query text                                         │
└──────────────────────────────────────────────────────────────┘
```

### Context Collection Flow

1. **Document context**: `IDocumentContext.inferDocumentContext()` checks `request.location2`:
   - If `ChatRequestEditorData` → captures document URI, wholeRange, selection
   - If `ChatRequestNotebookData` → captures notebook cell
   - Otherwise → uses `activeTextEditor` (file path + cursor shown to model but NOT file content)

2. **Chat variables**: User attaches context via `#file`, `#selection`, `#codebase`, `#problems`, etc. These are resolved in `renderChatVariables()`:
   - **URI/Location values** → `FileVariable` (reads file, creates fenced code block with file path comment)
   - **Directory URIs** → `FolderVariable` (renders file tree, max 2000 chars)
   - **String values** → rendered in `<attachment>` tags
   - **Binary data** → `Image` component (multimodal)
   - **Diagnostics** → `DiagnosticVariable` (error messages with file path, line, severity)

3. **Conversation history**: `ConversationHistory` component:
   - Filters out prompt-filtered turns
   - For each turn: renders `ChatVariablesAndQuery` (historical variables + query) + `AssistantMessage`
   - **Deduplication**: `removeDuplicateVars()` removes variables that appear in later turns or current turn
   - **Token limit**: Hard cap at 32,768 tokens
   - **Ordering**: `PrioritizedList` with `descending=false` — oldest turns pruned first under budget pressure

4. **Tool references**: `ChatToolReferences` component eagerly invokes any `#`-referenced tools (e.g., `#codebase`) and injects their results inline in the prompt.

### Key Insight: Panel mode is **statically contextual** — all context is gathered upfront before the LLM call. There is no tool-calling loop.

---

## 4. Inline Chat/Edit Mode

**Intent**: `Intent.InlineChat` or `Intent.Edit`
**Prompt classes**: Multiple, selected by document type and edit strategy:
- `InlineChatEditCodePrompt` / `InlineChatGenerateCodePrompt` (code files)
- `InlineChatEditMarkdownPrompt` / `InlineChatGenerateMarkdownPrompt` (markdown)
- `InlineChatNotebookEditPrompt` / `InlineChatNotebookGeneratePrompt` (notebooks)
**Invocation**: `GenericInlineIntentInvocation` (`src/extension/context/node/resolvers/genericInlineIntentInvocation.ts`)

### Prompt Structure (InlineChatEditCodePrompt example)

```
┌─ SystemMessage (priority=1000) ──────────────────────────────┐
│  "You are an AI programming assistant."                       │
│  Identity, safety, language expertise                         │
└───────────────────────────────────────────────────────────────┘
┌─ HistoryWithInstructions (inline=true) ──────────────────────┐
│  InstructionMessage (priority=1000):                          │
│    - Code in ``` blocks                                       │
│    - Selection placeholder explanation                        │
│  ConversationHistory (inline mode):                           │
│    - Collapsed into single message:                           │
│      "The current code is a result of a previous interaction  │
│       with you. Here are my previous messages: ..."           │
└───────────────────────────────────────────────────────────────┘
┌─ UserMessage ────────────────────────────────────────────────┐
│  CustomInstructions (priority=725)                            │
│  LanguageServerContextPrompt (priority=700)                   │
└───────────────────────────────────────────────────────────────┘
┌─ ChatToolReferences (priority=750) ──────────────────────────┐
│  ChatVariables (priority=750)                                 │
└───────────────────────────────────────────────────────────────┘
┌─ UserMessage (priority=900, flexGrow=2) ─────────────────────┐
│  flexReserve = modelMaxPromptTokens / 3                       │
│  SummarizedDocumentWithSelection (flexGrow=1):                │
│    - File outline (collapsed function bodies)                 │
│    - Code above selection                                     │
│    - SELECTED CODE (with placeholder marker)                  │
│    - Code below selection                                     │
│  <userPrompt> tag with query                                  │
│  "The modified [PLACEHOLDER] code with ``` is:"              │
└───────────────────────────────────────────────────────────────┘
```

### Context Collection Flow — The Critical Difference

Inline mode has the **richest editor-aware context collection**:

#### Step 1: Document Context Creation
`IDocumentContext.fromEditor()` (`src/extension/prompt/node/documentContext.ts:24-45`):
```typescript
// Captures: document snapshot, indent info, language, selection, wholeRange
const { options, document, selection, visibleRanges } = editor;
// wholeRange = union of visible ranges, or just the selection
```

#### Step 2: Selection Expansion via TreeSitter
`getSelectionAndCodeAroundSelection()` (`src/extension/context/node/resolvers/inlineChatSelection.ts:27-94`):

This is the most sophisticated context gathering in the extension:

1. **Range parameter**: The selection is first expanded to encompassing function(s) using TreeSitter AST analysis
2. **3:1 above:below ratio**: For every line added below the selection, 3 lines are added above (line 108: `step % 4 === 3` triggers below)
3. **100-line limit**: Maximum of 100 lines of surrounding context (line 106: `step < 100`)
4. **Bottom-up iteration**: Selection is iterated from bottom to top to ensure the most relevant code fits (line 77)
5. **Completeness tracking**: `aboveInfo.isComplete` / `belowInfo.isComplete` flags indicate if all available context was included

#### Step 3: File Outline via Body Removal
`removeBodiesOutsideRange()` (`src/extension/context/node/resolvers/inlineChatSelection.ts:130-169`):

- Uses TreeSitter to identify function bodies outside the selection range
- Replaces function bodies with a placeholder (e.g., `/* ... */`)
- Creates a **file outline** showing the structure without implementation details
- Splits into `outlineAbove` and `outlineBelow` relative to the selection

#### Step 4: SummarizedDocumentWithSelection
`SummarizedDocumentData.create()` (`src/extension/intents/node/testIntent/summarizedDocumentWithSelection.ts`):

Combines the TreeSitter-expanded selection with the file outline into a structured document representation:
```
[outline above - collapsed function bodies]
[code above selection - full implementation]
[SELECTED CODE - marked with placeholder]
[code below selection - full implementation]
[outline below - collapsed function bodies]
```

#### Step 5: Notebook Cell Context (for notebooks)
`generateNotebookCellContext()` (`src/extension/context/node/resolvers/inlineChatSelection.ts:171-287`):
- Adds cells above and below the current cell
- Prefers cells above over cells below
- Uses the same 100-step limit shared with the intra-cell context

#### Step 6: Language Server Context
`LanguageServerContextPrompt` (`src/extension/prompts/node/inline/languageServerContextPrompt.tsx`):
- Gathers LSP-provided context at the cursor position
- Source: `KnownSources.chat`

### Key Insight: Inline mode is **surgery-focused** — it provides maximum local context (file outline + expanded selection + surrounding code) to enable precise edits, while minimizing distant context.

---

## 5. Agent Mode

**Intent**: `Intent.Agent`
**Prompt class**: `AgentPrompt` (`src/extension/prompts/node/agent/agentPrompt.tsx`)
**Tool-calling loop**: `DefaultIntentRequestHandler` → `ToolCallingLoop` (`src/extension/intents/node/toolCallingLoop.ts`)

### Prompt Structure

```
┌─ SystemMessage ──────────────────────────────────────────────┐
│  "You are an expert AI programming assistant..."              │
│  CopilotIdentityRules (customizable per model)                │
│  SafetyRules (customizable per model)                         │
│  MemoryInstructionsPrompt (how to use memory tool)            │
└───────────────────────────────────────────────────────────────┘
┌─ SystemMessage (custom instructions) ────────────────────────┐
│  CustomInstructions (from .github/copilot-instructions.md)    │
│  Mode instructions (if custom mode active)                    │
└───────────────────────────────────────────────────────────────┘
┌─ UserMessage (GlobalAgentContext — cached on first turn) ────┐
│  <environment_info>                                           │
│    UserOSPrompt (e.g., "macOS", "Linux", "Windows")           │
│  </environment_info>                                          │
│  <workspace_info>                                             │
│    AgentTasksInstructions (TokenLimit max=2000)               │
│    WorkspaceFoldersHint                                        │
│    AgentMultirootWorkspaceStructure (maxSize=2000)            │
│  </workspace_info>                                            │
│  UserPreferences (priority=800)                               │
│  MemoryContextPrompt (user/session/repo memory, new chats)   │
│  [cacheBreakpoint]                                            │
└───────────────────────────────────────────────────────────────┘
┌─ SummarizedConversationHistory (priority=900, flexGrow=1) ───┐
│  OR AgentConversationHistory (priority=700, flexGrow=1)       │
│  (includes all prior turns with tool calls)                   │
└───────────────────────────────────────────────────────────────┘
┌─ AgentUserMessage (priority=900, flexGrow=2) ────────────────┐
│  NotebookFormat (priority=810, if notebook tools available)   │
│  ChatVariables (priority=898, TokenLimit = budget/6)          │
│  ToolReferencesHint                                           │
│  <context>                                                    │
│    CurrentDatePrompt                                          │
│    EditedFileEvents (files user manually changed)             │
│    NotebookSummaryChange                                      │
│    TerminalStatePromptElement                                 │
│    TodoListContextPrompt                                      │
│    AdditionalHookContextPrompt                                │
│  </context>                                                   │
│  CurrentEditorContext (file path + cursor, NOT content)        │
│  <reminderInstructions>                                       │
│    ReminderInstructions (edit tool usage, todo usage)          │
│    NotebookReminderInstructions                               │
│    SkillAdherenceReminder (if skills available)               │
│  </reminderInstructions>                                      │
│  <userRequest priority=900 flexGrow=7>                        │
│    UserQuery (prompt files + query text)                      │
│  </userRequest>                                               │
│  [cacheBreakpoint]                                            │
└───────────────────────────────────────────────────────────────┘
┌─ ChatToolCalls (priority=899, flexGrow=2) ───────────────────┐
│  Tool call rounds (request + result pairs)                    │
│  truncateAt = modelMaxPromptTokens * 0.5                     │
└───────────────────────────────────────────────────────────────┘
```

### Context Collection Flow

#### Phase 1: Static Context (one-time, on first request)

1. **Global Agent Context** (cached per conversation via `GlobalContextMessageMetadata`):
   - OS info, workspace folders, workspace file tree (max 2000 tokens)
   - Task definitions from `.vscode/tasks.json`
   - User preferences from `copilotUserPreferences.md`
   - Memory context (user memory: first 200 lines, session memory file listing, repo memories with citations)
   - Cache breakpoint after this block for efficient prompt caching

2. **Custom instructions**: Resolved from `.github/copilot-instructions.md`, VS Code settings, and prompt instruction variables

3. **Mode instructions**: If a custom chat mode is active (e.g., from `.github/copilot-modes/`), its instructions take precedence

#### Phase 2: Per-Turn Context (updated each request)

4. **Chat variables**: User `#file`, `#folder`, `#selection` attachments (capped at `budget/6` tokens)
5. **Current editor context**: Just the file path and cursor line (NOT file content — agent should use `read_file` tool)
6. **Edited file events**: Notifications about files the user manually edited or undid since the last agent action
7. **Terminal state**: Current terminal content
8. **Todo list**: Agent's todo list state
9. **Reminder instructions**: Critical reminders about edit tool usage placed right next to user message for maximum salience

#### Phase 3: Dynamic Context (tool-calling loop)

The agent accumulates context through iterative tool calls managed by `ToolCallingLoop`:

```
while (not done && iterations < maxToolCallIterations) {
  1. Render prompt with all accumulated context
  2. Send to LLM
  3. LLM responds with tool calls or final answer
  4. Execute tool calls, collect results
  5. Add tool call round to conversation
  6. Re-render prompt for next iteration
}
```

Key properties:
- **Max iterations**: 15 by default (`maxToolCallIterations: 15`)
- **Tool result cap**: Each individual tool result truncated to 50% of total model token budget (`MAX_TOOL_RESPONSE_PCT = 0.5`)
- **Summarization trigger**: When prompt exceeds token budget → `BudgetExceededError` → triggers conversation summarization

#### Phase 4: Conversation Summarization

`SummarizedConversationHistory` (`src/extension/prompts/node/agent/summarizedConversationHistory.tsx`) manages long conversations:

1. When token budget exceeded → triggers summarization via separate LLM call
2. Summary replaces older turns with a structured summary containing:
   - Conversation overview (objectives, session context, intent evolution)
   - Technical foundation (technologies, frameworks, configurations)
   - Codebase status (files modified, changes made, current state)
   - Progress tracking (completed vs pending tasks)
   - Recent commands analysis (last tool calls and results)
3. Fallback: If summarization itself fails → `SimpleSummarizedHistory` (simpler format)
4. Cache breakpoints placed strategically for efficient prompt caching across turns

### Key Insight: Agent mode uses **dynamic context accumulation** — minimal upfront context with on-demand tool-based context fetching, plus conversation summarization for long sessions.

---

## 6. Token Budget & Prioritization (prompt-tsx)

The `@vscode/prompt-tsx` library manages fitting context into the model's token budget through a priority and flex system.

### Priority System (higher number = higher priority = kept under budget pressure)

| Priority | Content | Pruning Behavior |
|---|---|---|
| **1000** | System messages, instruction messages | Never pruned |
| **900** | Current user query, current tool calls | Almost never pruned |
| **899** | Tool call results | Pruned after query |
| **898** | Chat variable attachments | Pruned after tool results |
| **810** | Notebook format instructions | Pruned early |
| **800** | User preferences, workspace folders | Pruned before variables |
| **750** | Custom instructions, chat variables (inline) | Middle priority |
| **725** | Custom instructions (inline) | Lower custom instructions |
| **700** | Conversation history, language server context | First major pruning target |
| **600** | Project labels | Pruned first |

### Flex System

- `flexGrow` — proportional token allocation weight (higher = gets more tokens)
- `flexReserve` — minimum tokens reserved before element can be eliminated

Example from agent prompt:
```tsx
<SummarizedConversationHistory flexGrow={1} priority={900} />
<AgentUserMessage flexGrow={2} priority={900} />
<ChatToolCalls priority={899} flexGrow={2} />
```
This allocates the budget roughly: 20% history, 40% user message, 40% tool calls.

### Hard Limits

| Limit | Value | Location |
|---|---|---|
| Conversation history (panel) | 32,768 tokens | `ConversationHistory` → `TokenLimit max={32768}` |
| Workspace structure | 2,000 tokens | `AgentMultirootWorkspaceStructure maxSize={2000}` |
| Task definitions | 2,000 tokens | `AgentTasksInstructions` → `TokenLimit max={2000}` |
| Chat variables (agent) | `budget / 6` tokens | `AgentUserMessage` → `TokenLimit max={sizing.tokenBudget / 6}` |
| Single tool result | 50% of model max | `MAX_TOOL_RESPONSE_PCT = 0.5` |
| User memory | 200 lines | `MAX_USER_MEMORY_LINES = 200` in `memoryContextPrompt.tsx` |
| Inline code reserve | `modelMaxPromptTokens / 3` | `InlineChatEditCodePrompt` → `flexReserve` |

### Variable Deduplication

`ConversationHistory.removeDuplicateVars()` prevents the same file attachment from appearing multiple times across conversation turns:
- If a variable appears in a later turn → remove from earlier turn
- If a variable appears in the current turn → remove from all historical turns

---

## 7. Context Engineering Patterns Analysis

### Mapping to Anthropic's Principles

[Reference: Anthropic — Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

| Anthropic Principle | Implementation in Copilot Chat |
|---|---|
| **"Smallest possible set of high-signal tokens"** | Priority system ensures only highest-signal context survives budget pressure. Inline mode's 3:1 above:below ratio prioritizes the most relevant surrounding code. Agent mode starts with minimal workspace context and fetches on-demand via tools. |
| **"Context as a finite resource"** | `@vscode/prompt-tsx` treats context as a strictly finite resource with priority-based pruning, hard token limits per section, and flex-based proportional allocation. |
| **"Tool design — intentional, clear, combinable"** | 30+ tools each serve a specific purpose (file reading, searching, diagnostics, terminal, etc.). Tools are categorized (`ToolCategory` enum) and some are grouped into "virtual tools" for model comprehension. |
| **"Token efficiency in tool responses"** | `MAX_TOOL_RESPONSE_PCT = 0.5` caps any single tool result. Tool results have dedicated truncation. Agent mode favors `read_file` with line ranges over dumping entire files. |
| **"Code execution for scalability"** | `run_in_terminal` and `run_task` tools allow the agent to execute code and gather output dynamically, rather than pre-loading all possible information. |

### Mapping to LangChain's Four Strategies (Write, Select, Compress, Isolate)

[Reference: LangChain — Context Engineering for Agents](https://blog.langchain.com/context-engineering-for-agents/)

#### 1. Write — Saving context outside the context window

| Pattern | Implementation |
|---|---|
| **Memory tool** | Three-tier persistent memory: user memory (global), session memory (per-conversation), repo memory (per-workspace). Memory is written via the `memory` tool and loaded into `MemoryContextPrompt`. |
| **Todo list** | `TodoListContextPrompt` maintains a structured task list that persists across tool-calling turns, serving as an external scratchpad. |
| **Conversation store** | `IConversationStore` persists conversation state to disk, enabling resume across VS Code restarts. |
| **Frozen user messages** | `RenderedUserMessageMetadata` "freezes" rendered user messages after first render, preventing re-computation and ensuring prompt cache hits. |

#### 2. Select — Pulling relevant context into the window

| Pattern | Implementation |
|---|---|
| **Chat variables (#file, #selection)** | Users explicitly select context via `#` references. `ChatVariablesCollection` resolves these into file contents, selections, diagnostics, etc. |
| **Intent-based context selection** | `IntentDetector` classifies user intent, routing to different prompt templates that include different context. Fix intent includes diagnostics; inline edit includes surrounding code; agent includes tool definitions. |
| **Automatic document context** | `IDocumentContext.inferDocumentContext()` automatically captures the active editor context — different information depending on whether the request comes from the panel, editor, or notebook. |
| **On-demand tool context (Agent)** | Agent mode uses tools to selectively fetch only the context needed: `read_file` for specific files, `grep_search` for targeted content, `get_errors` for current diagnostics. |
| **Global agent context caching** | `GlobalContextMessageMetadata` caches the workspace structure / environment info from the first turn, avoiding re-computation. A cache key invalidates when workspace state changes. |

#### 3. Compress — Retaining only essential tokens

| Pattern | Implementation |
|---|---|
| **Conversation summarization** | `SummarizedConversationHistory` compresses long conversations into structured summaries when budget exceeded, with fallback to `SimpleSummarizedHistory`. |
| **Function body collapsing** | `removeBodiesOutsideRange()` replaces function bodies outside the selection with placeholders, creating a file outline that preserves structure without implementation noise. |
| **Priority-based pruning** | Lower-priority content (history at 700, project labels at 600) is automatically pruned when budget is tight. |
| **Variable deduplication** | `removeDuplicateVars()` removes redundant file attachments across conversation turns. |
| **Inline history collapse** | In inline mode, full conversation history is collapsed into a single message: "The current code is a result of a previous interaction with you. Here are my previous messages: ..." |
| **Tool result truncation** | Individual tool results capped at 50% of model budget. |

#### 4. Isolate — Splitting context across sub-agents

| Pattern | Implementation |
|---|---|
| **Sub-agents** | `runSubagent` tool spawns isolated sub-agents with their own context windows for complex sub-tasks, preventing context pollution of the main conversation. |
| **Search sub-agent** | `SearchSubagent` tool delegates codebase searches to a specialized agent with a focused context. |
| **Tool-calling loop isolation** | Each tool call round's results are scoped and summarized before being added back to the conversation context. |

### Context Engineering Anti-Patterns Avoided

| Anti-Pattern (from guides) | How Copilot Chat Avoids It |
|---|---|
| **Context Poisoning** (irrelevant data) | Priority system prunes low-signal content first. Intent detection routes to appropriate context. |
| **Context Distraction** (critical info buried) | User query placed at priority 900 with `flexGrow=7`. Reminder instructions placed adjacent to query for maximum salience. |
| **Context Confusion** (unrelated data) | Mode-specific prompts (inline vs. panel vs. agent) include only relevant context types. Inline mode doesn't include workspace structure; panel mode doesn't include code around selection. |
| **Context Clash** (contradictions) | Frozen user messages prevent re-rendering. Cache breakpoints ensure consistency. Mode instructions explicitly override base instructions. |

---

## 8. Flow Diagrams

### Chat Panel Request Flow

```
User types message in Chat Panel
  │
  ├─→ VS Code resolves #references → ChatVariablesCollection
  │
  ├─→ ChatParticipantRequestHandler
  │     ├─→ inferDocumentContext(request, activeEditor, turns)
  │     │     └─→ IDocumentContext { document, selection, wholeRange, fileIndentInfo }
  │     ├─→ IntentDetector.detectIntent()
  │     │     └─→ Fast LLM call → Intent.Unknown / Intent.Fix / etc.
  │     └─→ Intent.invoke() → GenericPanelIntentInvocation
  │
  ├─→ PromptRenderer.render(PanelChatBasePrompt, promptContext)
  │     ├─→ SystemMessage: identity, safety, capabilities, workspace
  │     ├─→ HistoryWithInstructions: formatting rules + conversation history
  │     ├─→ UserMessage: custom instructions + tool references + variables + query
  │     └─→ Priority-based fitting to token budget
  │
  └─→ LLM Call → Stream response → Render markdown
```

### Inline Chat/Edit Request Flow

```
User presses Ctrl+I in editor
  │
  ├─→ IDocumentContext.fromEditor(editor, wholeRange)
  │     └─→ { document, selection, visibleRanges, fileIndentInfo, language }
  │
  ├─→ GenericInlineIntentInvocation.buildPrompt()
  │     ├─→ Determine prompt class:
  │     │     ├─→ Notebook cell? → InlineChatNotebook{Edit|Generate}Prompt
  │     │     ├─→ Markdown? → InlineChatEditMarkdownPrompt
  │     │     └─→ Code? → InlineChatEditCodePrompt
  │     │
  │     └─→ Determine edit strategy:
  │           ├─→ ForceInsertion → Generate prompts (empty selection)
  │           └─→ Edit → Edit prompts (has selection)
  │
  ├─→ SummarizedDocumentData.create(parserService, document, indentInfo, wholeRange)
  │     ├─→ TreeSitter: expand selection to encompassing function(s)
  │     ├─→ getSelectionAndCodeAroundSelection():
  │     │     ├─→ Iterate selection bottom-up
  │     │     ├─→ Add context: 3 lines above per 1 line below
  │     │     └─→ Max 100 lines total
  │     └─→ removeBodiesOutsideRange():
  │           └─→ File outline with collapsed function bodies
  │
  ├─→ PromptRenderer.render(InlineChatEditCodePrompt, ...)
  │     ├─→ SystemMessage: identity, safety, language expertise
  │     ├─→ HistoryWithInstructions (inline=true, collapsed history)
  │     ├─→ CustomInstructions + LanguageServerContext
  │     ├─→ ChatVariables + ChatToolReferences
  │     └─→ SummarizedDocumentWithSelection + UserQuery
  │           └─→ flexReserve = modelMaxPromptTokens / 3
  │
  └─→ LLM Call → ReplyInterpreter
        └─→ Streaming edit application (replaceSelectionStreaming)
```

### Agent Mode Request Flow

```
User sends message in Agent Mode
  │
  ├─→ ChatParticipantRequestHandler
  │     ├─→ inferDocumentContext()
  │     ├─→ IntentDetector → Intent.Agent
  │     └─→ DefaultIntentRequestHandler.getResult()
  │
  ├─→ Intent.invoke() → AgentIntentInvocation
  │     └─→ Resolves prompt customizations from PromptRegistry
  │           (model-specific: OpenAI, Anthropic, Gemini prompts)
  │
  ├─→ [FIRST TURN ONLY] Build GlobalAgentContext:
  │     ├─→ OS info, workspace folders, workspace file tree (2K tokens)
  │     ├─→ Task definitions from .vscode/tasks.json
  │     ├─→ UserPreferences from copilotUserPreferences.md
  │     ├─→ MemoryContextPrompt (user ≤200 lines, session listing, repo facts)
  │     └─→ Cache and freeze via GlobalContextMessageMetadata
  │
  ├─→ ToolCallingLoop.run()
  │     │
  │     ├─→ ITERATION 1:
  │     │     ├─→ Render AgentPrompt with:
  │     │     │     ├─→ System: instructions + custom instructions + memory instructions
  │     │     │     ├─→ GlobalAgentContext (cached)
  │     │     │     ├─→ History (or SummarizedConversationHistory)
  │     │     │     ├─→ AgentUserMessage: variables, context, editor, reminders, query
  │     │     │     └─→ ChatToolCalls (empty on first iteration)
  │     │     ├─→ LLM Call → Tool calls: [read_file("src/main.ts"), grep_search("TODO")]
  │     │     └─→ Execute tools → Collect results
  │     │
  │     ├─→ ITERATION 2:
  │     │     ├─→ Re-render AgentPrompt with accumulated tool call rounds
  │     │     ├─→ LLM Call → More tool calls or final answer
  │     │     └─→ Execute tools → Collect results
  │     │
  │     ├─→ ... (up to 15 iterations)
  │     │
  │     ├─→ [IF BUDGET EXCEEDED]:
  │     │     └─→ SummarizedConversationHistory triggers summarization
  │     │           ├─→ Separate LLM call to summarize conversation
  │     │           ├─→ Summary replaces old turns
  │     │           └─→ Fallback: SimpleSummarizedHistory
  │     │
  │     └─→ FINAL: LLM produces answer (no more tool calls)
  │
  └─→ Response → Stream markdown + apply edits + render code blocks
```

---

## Appendix: Mode Comparison Matrix

| Dimension | Chat Panel | Inline Chat/Edit | Agent Mode |
|---|---|---|---|
| **Primary use** | Ask questions, explain code | Edit code in-place | Multi-step autonomous tasks |
| **Context strategy** | Static: all upfront | Static: editor-focused | Dynamic: tool-based accumulation |
| **File content** | Only via #file attachment | Full file with TreeSitter analysis | Via read_file tool on demand |
| **Selection handling** | Via #selection variable | Expanded to encompassing function, 3:1 above:below ratio, 100-line limit | Cursor position only (file path + line) |
| **Code outline** | None | Function body collapsing via TreeSitter | None (agent reads files directly) |
| **History** | Full turns, 32K cap, oldest-first pruning | Collapsed to single message | Full turns with tool calls, summarization when budget exceeded |
| **Tool calling** | None (single LLM call) | None (single LLM call) | Up to 15 iterations |
| **Workspace structure** | Workspace folders hint | None | File tree (2K tokens) + task definitions (2K tokens) |
| **Memory** | None | None | User/session/repo memory (200 line cap) |
| **Custom instructions** | Priority 750 | Priority 725 | Priority varies (system or user message) |
| **Budget allocation** | History 1/3, variables + query 2/3 | Code context 1/3 reserved, rest flexible | History 1/5, user message 2/5, tool calls 2/5 |
| **Cache breakpoints** | None | None | Yes (after global context + after user message) |
| **Response processing** | Markdown streaming | Streaming edit application (replaceSelectionStreaming) | Markdown + edits + tool call UI |

---

*Analysis performed on the VS Code Copilot Chat extension codebase. All file paths are relative to the repository root.*
