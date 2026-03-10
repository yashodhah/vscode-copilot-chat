# VS Code Copilot Chat Extension — Internals Exploration Guide

This document is a living guide for reverse-engineering the Copilot Chat extension. It maps
out why design decisions were made, where the key execution paths live, and how to observe
the system in action.

---

## How to Use This Guide

### Enable Exploration Tracing

Launch with the **"Launch Copilot Extension (Exploration)"** config in `.vscode/launch.json`.
This sets `COPILOT_EXPLORER_TRACE=1`, enabling the `explorerTrace()` calls throughout the code.

In the **Debug Console**, filter for `[EXPLORE]` to see the trace output:
```
[EXPLORE #1] [12:34:56.789] [CONVERSATION] ChatParticipantRequestHandler.getResult() called | {"agent":"copilot","intentId":"unknown","location":"panel","promptLength":42,"historyTurns":0}
[EXPLORE #2] [12:34:56.890] [CONVERSATION] Intent selected | {"intentId":"unknown","hasHandleRequest":false}
[EXPLORE #3] [12:34:57.012] [PROMPT] PromptRenderer.render(): PanelChatBasePrompt | {"model":"gpt-4o"}
[EXPLORE #4] [12:34:57.890] [PROMPT] PromptRenderer.render() done | {"tokenCount":1234,"messageCount":3,"referenceCount":0}
```

### Set Breakpoints

Key files for breakpoints (listed in order of execution for a chat turn):

| Step | File | Location |
|------|------|----------|
| 1 | `src/extension/conversation/vscode-node/chatParticipants.ts` | `getChatParticipantHandler()` |
| 2 | `src/extension/prompt/node/chatParticipantRequestHandler.ts` | `getResult()` |
| 3 | `src/extension/prompt/node/intentDetector.ts` | `detectIntent()` |
| 4 | `src/extension/prompts/node/base/promptRenderer.ts` | `render()` |
| 5 | `src/extension/endpoint/` | model request dispatch |
| 6 (agent mode) | `src/extension/tools/vscode-node/toolsService.ts` | `invokeTool()` |

---

## Architecture Map

### Extension Activation Flow

```
vscode activates extension
  └─ baseActivate() [src/extension/extension/vscode/extension.ts]
       ├─ createInstantiationService()     ← DI container setup
       ├─ expService.hasTreatments()       ← wait for A/B experiments to load
       └─ ContributionCollection.waitForActivationBlockers()
              └─ ConversationFeature      [src/extension/conversation/vscode-node/conversationFeature.ts]
                   └─ waits for copilot token → then registers chat participants
```

**WHY contributions?** The contribution system (not raw DI) is used so that features can
declare async activation blockers. `ConversationFeature` blocks activation until the Copilot
token is available, preventing race conditions.

---

### Chat Request Lifecycle (Panel Chat)

```
User types message → Enter
  └─ VS Code calls ChatParticipant handler
       └─ ChatParticipantRequestHandler.getResult()   [chatParticipantRequestHandler.ts]
            ├─ sanitizeVariables()      ← filter .copilotignore'd files
            ├─ selectIntent()           ← detect /command or use default
            ├─ intent.handleRequest()   ← intent-specific logic
            │    └─ DefaultIntentRequestHandler.getResult()
            │         ├─ buildPromptContext()
            │         └─ PromptRenderer.render()      ← @vscode/prompt-tsx renders messages
            │              └─ TSX component tree → Raw messages array
            └─ endpoint.makeChatRequest2()             ← HTTP to model API
```

**WHY @vscode/prompt-tsx?** Prompts are complex: they have dynamic parts (history, context,
tools), token budgets, and priority ordering (drop lower-priority content when over budget).
TSX provides a declarative component model for this, similar to React for UI. The `render()`
method handles token counting, priority-based truncation, and reference collection.

**WHERE to find prompt components:**
- Panel chat base: `src/extension/prompts/node/panel/panelChatBasePrompt.tsx`
- Agent mode: `src/extension/prompts/node/agent/`
- Inline chat: `src/extension/prompts/node/inline/`

---

### Agent Mode Tool Call Loop

```
Model response arrives with tool_calls
  └─ DefaultIntentRequestHandler (or AgentIntent handler)
       └─ for each tool call:
            ├─ ToolsService.invokeTool()              [tools/vscode-node/toolsService.ts]
            │    ├─ fires onWillInvokeTool event
            │    ├─ starts OTel span
            │    └─ vscode.lm.invokeTool()            ← VS Code API
            ├─ result appended to ToolCallRound        [prompt/common/toolCallRound.ts]
            └─ loop: re-build prompt with tool results → model again
```

**WHY ToolCallRound?** Each round of tool calls is stored so that:
1. The full tool execution history can be included in subsequent prompts
2. Rounds can be summarized when conversations get long (token compression)
3. Telemetry can track exactly how many rounds of tool use occurred

**Tool registration** (at module load, not runtime):
```typescript
// In each tool file:
ToolRegistry.registerTool(MyTool);

// ToolsService lazily instantiates via DI:
new Lazy(() => new Map(ToolRegistry.getTools().map(t => [t.toolName, _instantiationService.createInstance(t)])))
```

---

### Claude Agent (Claude Code) Integration

```
User opens Claude chat participant
  └─ ClaudeAgentManager.handleRequest()               [chatSessions/claude/node/claudeCodeAgent.ts]
       ├─ getLangModelServer()                         ← lazy-start HTTP server
       │    └─ ClaudeLanguageModelServer.start()       [claudeLanguageModelServer.ts]
       │         └─ http.createServer() on port 0      ← random available port
       ├─ ClaudeCodeSession.invoke()
       │    └─ Claude Agent SDK Query()                ← from @anthropic-ai/claude-agent-sdk
       │         └─ HTTP POST /v1/messages → ClaudeLanguageModelServer
       │              └─ handleAuthedMessagesRequest()
       │                   ├─ parse Anthropic request format
       │                   ├─ endpointProvider.makeChatRequest2()  ← VS Code LM API
       │                   └─ convert response → Anthropic SSE format
       └─ stream results back to VS Code Chat UI
```

**WHY HTTP server?** The Claude Agent SDK was designed to call Anthropic's API at
`api.anthropic.com`. Rather than forking the SDK, the extension runs a local HTTP server
that:
- Speaks Anthropic's Messages API protocol (so the SDK needs no modification)
- Forwards requests to VS Code's language model abstraction
- Enables model swapping (use GPT-4, Gemini, etc. instead of Claude)
- Adds quota management, telemetry, and cancellation

**WHY nonce auth?** `vscode-lm-<uuid>` nonce ensures only the Claude Agent SDK process
(which receives the nonce) can call the local HTTP server. Prevents other local processes
from using the endpoint.

---

### Inline Edit Streaming (NES — Next Edit Suggestions)

```
User types in editor
  └─ InlineCompletionProvider triggered              [inlineEdits/vscode-node/inlineCompletionProvider.ts]
       └─ NextEditProvider.getNextEdit()             [inlineEdits/node/nextEditProvider.ts]
            ├─ check NextEditCache for rebase-compatible result
            ├─ _getNextEditCanThrow()
            │    └─ StatelessNextEditProvider.fetch()  ← calls model
            └─ suggestion shown to user
                 └─ handleShown() fires
                      └─ _createSpeculativeRequest()
                           └─ pre-fetches next edit as if user accepted ← KEY PATTERN
```

**WHY speculative prefetch?**
- LLM call latency: 500-2000ms
- User accept latency: <100ms
- Without prefetch: user sees blank gap after every accept
- With prefetch: the next suggestion is already cached when accept happens

The speculative request is pre-computed with the document state *after* the shown suggestion
is applied. If the user accepts, the speculative request result is used immediately.
If the user rejects, the speculative request is cancelled.

---

## Key Architectural Patterns

### 1. Dependency Injection via IInstantiationService

```typescript
// Define a service identifier
export const IMyService = createServiceIdentifier<IMyService>('IMyService');

// Inject in constructor
constructor(
  @IMyService private readonly myService: IMyService,
  @ILogService private readonly logService: ILogService,
) {}
```

**WHY DI?** Enables unit testing without VS Code host, supports web vs. node.js backends,
provides cross-platform abstractions.

### 2. Observable Pattern for Reactive State

```typescript
// Tool registry uses ObservableMap for model-specific tools
private _modelSpecificTools = new ObservableMap<string, ...>();

// Auto-updates when model changes
autorunIterableDelta(reader => ToolRegistry.modelSpecificTools.read(reader), ...)
```

### 3. Contribution System for Modular Features

Each feature implements `IExtensionContribution` with an optional `activationBlocker`.
This allows features to declare async preconditions (e.g., "wait for auth token")
without blocking the entire extension.

### 4. Platform Separation

- `src/platform/` — services that work in both node.js and web
- `src/extension/` — VS Code-specific extension code
- `vscode-node/` directories — node.js-specific implementations
- `common/` directories — shared interfaces and utilities

---

## Files Modified for Exploration

All exploration trace calls use `// [EXPLORE]` comments and `// [DEBUG EXPLORATION]`
import markers. They are **no-ops** unless `COPILOT_EXPLORER_TRACE=1` is set.

| File | What's traced |
|------|--------------|
| `src/extension/extension/vscode/debugExplorer.ts` | **Utility** — the tracer itself |
| `src/extension/prompt/node/chatParticipantRequestHandler.ts` | Chat turn entry + intent selection |
| `src/extension/tools/vscode-node/toolsService.ts` | Every tool invocation |
| `src/extension/prompts/node/base/promptRenderer.ts` | Prompt construction start/end |
| `src/extension/inlineEdits/node/nextEditProvider.ts` | NES trigger + speculative prefetch |
| `src/extension/chatSessions/claude/node/claudeCodeAgent.ts` | Claude session dispatch |
| `src/extension/chatSessions/claude/node/claudeLanguageModelServer.ts` | HTTP bridge requests |

---

## Questions to Investigate

- [ ] How does the token budget get allocated between history, context, and system prompt?
  → Set breakpoint in `PromptRenderer.render()`, inspect `result.messages` and `result.tokenCount`

- [ ] How does intent detection work? What signals decide which slash command / agent to use?
  → Read `src/extension/prompt/node/intentDetector.ts`

- [ ] How are semantic search results embedded into the prompt?
  → Trace `src/extension/workspaceSemanticSearch/` → `src/platform/embedding/`

- [ ] How does the agent loop know when to stop calling tools and return a final answer?
  → Read `src/extension/intents/node/agentIntent.ts` (if it exists) or the agent handler

- [ ] How does the conversation get summarized when it exceeds the context window?
  → Search for `normalizeSummariesOnRounds` in `conversation.ts`

- [ ] What happens when a tool call is rejected by the user?
  → Trace `IClaudeToolPermissionService` and `claudeToolPermissionService.ts`
