import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { ApiKeys } from './apiKeys.ts';
import { checkBaseUrl } from './baseUrl.ts';
import { loadProviders } from './loadProviders.ts';
import { PROVIDER_LABELS } from './providers/catalog.ts';
import type { ChatResult, Turn } from './providers/types.ts';
import { readSettings, type AiSettings } from './settings.ts';

const HISTORY_KEY = 'route.ai.history';

// Must stay identical for the whole conversation: prompt caching and Anthropic's
// signed thinking blocks both depend on an unchanged prefix.
const SYSTEM_PROMPT = 'You are the coding assistant built into Route IDE, a code editor. Be concise. '
	+ 'Format answers in Markdown and put code in fenced blocks with a language tag. '
	+ 'Code the user attaches from their editor appears before their question.';

type FromWebview =
	| { type: 'ready' }
	| { type: 'send'; text: string }
	| { type: 'stop' }
	| { type: 'selectModel' }
	| { type: 'setApiKey' }
	| { type: 'copy'; code: string }
	| { type: 'insert'; code: string };

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = 'route.ai.chat';

	private readonly extensionUri: vscode.Uri;
	private readonly workspaceState: vscode.Memento;
	private readonly keys: ApiKeys;
	private readonly disposables: vscode.Disposable[] = [];
	private view: vscode.WebviewView | undefined;
	private turns: Turn[];
	private conversation = 0;
	private pending: AbortController | undefined;
	private contextTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(context: vscode.ExtensionContext, keys: ApiKeys) {
		this.extensionUri = context.extensionUri;
		this.workspaceState = context.workspaceState;
		this.keys = keys;
		this.turns = this.workspaceState.get<Turn[]>(HISTORY_KEY, []);

		this.disposables.push(
			vscode.window.onDidChangeTextEditorSelection(() => this.postContextSoon()),
			vscode.window.onDidChangeActiveTextEditor(() => this.postContextSoon()),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('route.ai')) {
					void this.postState();
					this.postContextSoon();
				}
			}),
			keys.onDidChange(() => void this.postState()),
		);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, 'dist'),
				vscode.Uri.joinPath(this.extensionUri, 'media'),
			],
		};
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage((message: FromWebview) => this.onMessage(message), undefined, this.disposables);
		view.onDidDispose(() => this.view = undefined, undefined, this.disposables);
	}

	newChat(): void {
		this.conversation++;
		this.pending?.abort();
		this.turns = [];
		void this.workspaceState.update(HISTORY_KEY, undefined);
		this.post({ type: 'restore', turns: [] });
	}

	dispose(): void {
		this.pending?.abort();
		clearTimeout(this.contextTimer);
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private async onMessage(message: FromWebview): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.post({ type: 'restore', turns: this.turns.map(toDisplay) });
				this.postContext();
				await this.postState();
				break;
			case 'send':
				await this.send(message.text);
				break;
			case 'stop':
				this.pending?.abort();
				break;
			case 'selectModel':
				await vscode.commands.executeCommand('route.ai.selectModel');
				break;
			case 'setApiKey':
				await vscode.commands.executeCommand('route.ai.setApiKey', readSettings().provider);
				break;
			case 'copy':
				await vscode.env.clipboard.writeText(message.code);
				break;
			case 'insert':
				await insertIntoEditor(message.code);
				break;
		}
	}

	private async send(text: string): Promise<void> {
		const question = text.trim();
		if (!question || this.pending) {
			return;
		}
		// Claim the slot before the first await so a double click cannot start two requests.
		const controller = new AbortController();
		this.pending = controller;
		const conversation = this.conversation;
		const isCurrent = () => conversation === this.conversation;

		try {
			const settings = readSettings();
			const apiKey = await this.keys.get(settings.provider);
			const problem = setupProblem(settings, apiKey);
			if (problem) {
				this.post({ type: 'failed', error: problem, text });
				return;
			}

			const attachment = settings.includeSelection ? describeSelection() : undefined;
			this.turns.push({
				role: 'user',
				text: attachment ? `${attachment.prompt()}\n\n${question}` : question,
				display: question,
				contextLabel: attachment?.label,
			});
			this.post({ type: 'start', text: question, contextLabel: attachment?.label });
			void this.postState();

			const { createProvider, describeError, isAbortError } = loadProviders();
			let streamed = '';
			try {
				const provider = createProvider(settings.provider, apiKey, settings.provider === 'openai-compatible' ? settings.baseUrl : undefined);
				const result = await provider.stream({
					model: settings.model!,
					system: SYSTEM_PROMPT,
					turns: this.turns,
					maxTokens: settings.maxTokens,
					effort: settings.provider === 'anthropic' ? settings.effort : undefined,
					signal: controller.signal,
				}, {
					onText: delta => {
						streamed += delta;
						if (isCurrent()) {
							this.post({ type: 'delta', text: delta });
						}
					},
					onStatus: status => {
						if (isCurrent()) {
							this.post({ type: 'status', text: status });
						}
					},
				});
				if (isCurrent()) {
					this.finish(result, text);
				}
			} catch (error) {
				if (!isCurrent()) {
					return; // "New Chat" was pressed while this request was running
				}
				if (isAbortError(error) && streamed.trim()) {
					// Keep what arrived before Stop so the user can refer back to it.
					this.turns.push({ role: 'assistant', text: streamed, meta: 'stopped' });
					this.post({ type: 'end', meta: 'stopped' });
				} else {
					this.turns.pop();
					this.post({ type: 'failed', error: isAbortError(error) ? undefined : describeError(error), text });
				}
			}
			if (isCurrent()) {
				void this.workspaceState.update(HISTORY_KEY, this.turns);
			}
		} finally {
			if (this.pending === controller) {
				this.pending = undefined;
			}
			void this.postState();
		}
	}

	private finish(result: ChatResult, text: string): void {
		if (result.stopReason === 'refusal' || !result.text.trim()) {
			// The unanswered question is dropped from history and put back in the input box.
			this.turns.pop();
			const error = result.stopReason === 'refusal'
				? `The model declined to answer${result.note ? ` (${result.note})` : ''}. Rephrase the request or choose another model.`
				: 'The model returned an empty reply.';
			this.post({ type: 'failed', error, text });
			return;
		}

		const meta = [result.model, tokenSummary(result)].filter(Boolean).join(' · ');
		this.turns.push({ role: 'assistant', text: result.text, anthropicContent: result.anthropicContent, meta });
		const notice = result.stopReason === 'max_tokens' ? 'The reply reached route.ai.maxTokens and was cut off.' : result.note;
		this.post({ type: 'end', meta, notice });
	}

	private async postState(): Promise<void> {
		const settings = readSettings();
		const hasKey = settings.provider === 'openai-compatible' || !!(await this.keys.get(settings.provider));
		this.post({
			type: 'state',
			provider: PROVIDER_LABELS[settings.provider],
			model: settings.model,
			hasKey,
			busy: !!this.pending,
		});
	}

	private postContextSoon(): void {
		clearTimeout(this.contextTimer);
		this.contextTimer = setTimeout(() => this.postContext(), 150);
	}

	private postContext(): void {
		const label = readSettings().includeSelection ? describeSelection()?.label : undefined;
		this.post({ type: 'context', label });
	}

	private post(message: object): void {
		void this.view?.webview.postMessage(message);
	}

	private html(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${style}">
	<title>Route AI</title>
</head>
<body>
	<header>
		<button id="model" class="model" type="button" title="Select model"></button>
	</header>
	<main id="messages" aria-live="polite"></main>
	<form id="composer">
		<div id="context" class="context" hidden></div>
		<textarea id="input" rows="1" placeholder="Ask about your code" aria-label="Message"></textarea>
		<div class="composer-row">
			<span class="hint">Enter to send · Shift+Enter for a new line</span>
			<button id="send" type="submit">Send</button>
		</div>
	</form>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}

function setupProblem(settings: AiSettings, apiKey: string | undefined): string | undefined {
	if (settings.provider === 'openai-compatible') {
		if (!settings.baseUrl) {
			return 'Set route.ai.baseUrl to your server, for example http://localhost:11434/v1 for Ollama.';
		}
		const problem = checkBaseUrl(settings.baseUrl);
		if (problem) {
			return problem;
		}
	} else if (!apiKey) {
		return `No ${PROVIDER_LABELS[settings.provider]} API key is set. Run "Route AI: Set API Key".`;
	}
	if (!settings.model) {
		return 'Choose a model with "Route AI: Select Model".';
	}
	return undefined;
}

function toDisplay(turn: Turn) {
	return turn.role === 'user'
		? { role: turn.role, text: turn.display ?? turn.text, contextLabel: turn.contextLabel }
		: { role: turn.role, text: turn.text, meta: turn.meta };
}

function describeSelection() {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.selection.isEmpty) {
		return undefined;
	}
	const { document, selection } = editor;
	const path = vscode.workspace.asRelativePath(document.uri);
	const first = selection.start.line + 1;
	const last = selection.end.character === 0 ? selection.end.line : selection.end.line + 1;
	const range = first >= last ? `${first}` : `${first}-${last}`;

	return {
		label: `${path}:${range}`,
		prompt: () => {
			const code = document.getText(selection);
			// The fence must be longer than any run of backticks inside the code.
			const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map(run => run.length));
			const fence = '`'.repeat(Math.max(3, longestRun + 1));
			return `From \`${path}\`, line${first >= last ? '' : 's'} ${range}:\n${fence}${document.languageId}\n${code}\n${fence}`;
		},
	};
}

async function insertIntoEditor(code: string): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		void vscode.window.showInformationMessage('Open a file to insert the code into.');
		return;
	}
	await editor.edit(builder => builder.replace(editor.selection, code));
	await vscode.window.showTextDocument(editor.document, editor.viewColumn);
}

function tokenSummary(result: ChatResult): string | undefined {
	if (result.inputTokens === undefined || result.outputTokens === undefined) {
		return undefined;
	}
	return `${formatCount(result.inputTokens)} in / ${formatCount(result.outputTokens)} out`;
}

function formatCount(count: number): string {
	return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}
