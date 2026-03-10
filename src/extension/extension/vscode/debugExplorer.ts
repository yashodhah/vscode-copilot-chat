/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * [DEBUG EXPLORATION UTILITY]
 *
 * A zero-dependency tracer for reverse-engineering the Copilot extension internals.
 * Enabled by setting the environment variable: COPILOT_EXPLORER_TRACE=1
 *
 * Usage (anywhere in the codebase):
 *   import { explorerTrace } from '../../extension/vscode/debugExplorer';
 *   explorerTrace('CategoryName', 'What happened', { key: 'optional data' });
 *
 * Then launch with the "Launch Copilot Extension (Exploration)" config in launch.json
 * and grep the Debug Console output for "[EXPLORE]" to see the trace.
 *
 * Categories in use:
 *   ACTIVATION      - Extension startup, DI setup, contributions loading
 *   CONVERSATION    - Turn creation, conversation state transitions
 *   PROMPT          - Prompt construction via @vscode/prompt-tsx
 *   ENDPOINT        - Model selection, routing, API requests
 *   TOOL            - Tool registration, invocation, validation
 *   TOOL_ROUND      - Agent loop tool call rounds
 *   CONTEXT         - Context resolution, workspace chunk search
 *   INLINE_EDIT     - NES / next-edit-suggestion lifecycle
 *   CLAUDE_AGENT    - Claude Code session management
 *   CLAUDE_HTTP     - HTTP bridge server (Anthropic ↔ VS Code LM API)
 */

const ENABLED = typeof process !== 'undefined' && process.env['COPILOT_EXPLORER_TRACE'] === '1';

let _sequenceNumber = 0;

/**
 * Emit a structured exploration trace line.
 * No-op unless COPILOT_EXPLORER_TRACE=1 is set in the environment.
 */
export function explorerTrace(category: string, message: string, data?: Record<string, unknown>): void {
	if (!ENABLED) {
		return;
	}

	const seq = ++_sequenceNumber;
	const timestamp = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
	const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
	// eslint-disable-next-line no-console
	console.log(`[EXPLORE #${seq}] [${timestamp}] [${category}] ${message}${dataStr}`);
}

/**
 * Wraps an async function to automatically trace entry and exit.
 *
 * @example
 *   async handleRequest(req) {
 *     return traceAsync('CONVERSATION', 'handleRequest', { prompt: req.prompt }, async () => {
 *       // ... original implementation
 *     });
 *   }
 */
export async function traceAsync<T>(
	category: string,
	name: string,
	inputData: Record<string, unknown>,
	fn: () => Promise<T>
): Promise<T> {
	if (!ENABLED) {
		return fn();
	}

	const start = Date.now();
	explorerTrace(category, `→ ${name}`, inputData);
	try {
		const result = await fn();
		explorerTrace(category, `← ${name} (${Date.now() - start}ms)`);
		return result;
	} catch (err) {
		explorerTrace(category, `✗ ${name} THREW (${Date.now() - start}ms)`, { error: String(err) });
		throw err;
	}
}

/**
 * Wraps a sync function to automatically trace entry and exit.
 */
export function traceSync<T>(
	category: string,
	name: string,
	inputData: Record<string, unknown>,
	fn: () => T
): T {
	if (!ENABLED) {
		return fn();
	}

	const start = Date.now();
	explorerTrace(category, `→ ${name}`, inputData);
	try {
		const result = fn();
		explorerTrace(category, `← ${name} (${Date.now() - start}ms)`);
		return result;
	} catch (err) {
		explorerTrace(category, `✗ ${name} THREW (${Date.now() - start}ms)`, { error: String(err) });
		throw err;
	}
}
