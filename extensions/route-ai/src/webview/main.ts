import MarkdownIt from 'markdown-it';

interface DisplayTurn {
	role: 'user' | 'assistant';
	text: string;
	contextLabel?: string;
	meta?: string;
}

type FromExtension =
	| { type: 'restore'; turns: DisplayTurn[] }
	| { type: 'state'; provider: string; model?: string; hasKey: boolean; busy: boolean }
	| { type: 'context'; label?: string }
	| { type: 'start'; text: string; contextLabel?: string }
	| { type: 'delta'; text: string }
	| { type: 'status'; text?: string }
	| { type: 'end'; meta?: string; notice?: string }
	| { type: 'failed'; error?: string; text: string };

interface Reply {
	element: HTMLElement;
	body: HTMLElement;
	status: HTMLElement;
	text: string;
}

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

// html: false escapes any HTML in model output, markdown-it refuses
// javascript: and data: links, and the page CSP blocks inline scripts.
const markdown = new MarkdownIt({ html: false, linkify: true });

const messages = byId<HTMLElement>('messages');
const composer = byId<HTMLFormElement>('composer');
const input = byId<HTMLTextAreaElement>('input');
const sendButton = byId<HTMLButtonElement>('send');
const modelButton = byId<HTMLButtonElement>('model');
const context = byId<HTMLElement>('context');

let busy = false;
let hasKey = true;
let reply: Reply | undefined;
let pendingUser: HTMLElement | undefined;
let renderScheduled = false;

window.addEventListener('message', (event: MessageEvent<FromExtension>) => handle(event.data));

function handle(message: FromExtension): void {
	switch (message.type) {
		case 'restore':
			reply = undefined;
			pendingUser = undefined;
			messages.replaceChildren();
			for (const turn of message.turns) {
				if (turn.role === 'user') {
					addUserMessage(turn.text, turn.contextLabel);
				} else {
					finishReply(startReply(turn.text), turn.meta);
				}
			}
			showEmptyState();
			messages.scrollTop = messages.scrollHeight;
			break;

		case 'state':
			busy = message.busy;
			hasKey = message.hasKey;
			modelButton.textContent = `${message.provider} · ${message.model ?? 'choose a model'}`;
			sendButton.textContent = busy ? 'Stop' : 'Send';
			showEmptyState();
			break;

		case 'context':
			context.hidden = !message.label;
			context.textContent = message.label ? `Attaching ${message.label}` : '';
			break;

		case 'start':
			removeTransient();
			pendingUser = addUserMessage(message.text, message.contextLabel);
			reply = startReply('');
			reply.status.textContent = 'Waiting for the model';
			messages.scrollTop = messages.scrollHeight;
			break;

		case 'delta':
			if (reply) {
				reply.text += message.text;
				reply.status.textContent = '';
				scheduleRender();
			}
			break;

		case 'status':
			if (reply && !reply.text) {
				reply.status.textContent = message.text ?? '';
			}
			break;

		case 'end':
			if (reply) {
				finishReply(reply, message.meta, message.notice);
				reply = undefined;
				pendingUser = undefined;
			}
			break;

		case 'failed':
			reply?.element.remove();
			pendingUser?.remove();
			reply = undefined;
			pendingUser = undefined;
			if (message.error) {
				addNotice(message.error);
			}
			if (!input.value) {
				input.value = message.text;
				resizeInput();
			}
			input.focus();
			showEmptyState();
			break;
	}
}

function addUserMessage(text: string, contextLabel?: string): HTMLElement {
	const element = create('article', 'message user');
	if (contextLabel) {
		element.append(create('div', 'attachment', contextLabel));
	}
	element.append(create('div', 'body', text));
	messages.append(element);
	return element;
}

function startReply(text: string): Reply {
	const element = create('article', 'message assistant');
	const status = create('div', 'status');
	const body = create('div', 'body markdown');
	element.append(status, body);
	messages.append(element);
	return { element, body, status, text };
}

function finishReply(target: Reply, meta?: string, notice?: string): void {
	renderMarkdown(target.body, target.text);
	target.status.remove();
	if (notice) {
		target.element.append(create('div', 'notice', notice));
	}
	if (meta) {
		target.element.append(create('div', 'meta', meta));
	}
}

// Streaming re-renders the whole reply, at most once per frame.
function scheduleRender(): void {
	if (renderScheduled) {
		return;
	}
	renderScheduled = true;
	requestAnimationFrame(() => {
		renderScheduled = false;
		if (reply) {
			const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
			renderMarkdown(reply.body, reply.text);
			if (nearBottom) {
				messages.scrollTop = messages.scrollHeight;
			}
		}
	});
}

function renderMarkdown(target: HTMLElement, text: string): void {
	target.innerHTML = markdown.render(text);
	for (const pre of target.querySelectorAll('pre')) {
		const block = create('div', 'code-block');
		const actions = create('div', 'code-actions');
		actions.append(actionButton('Copy', 'copy'), actionButton('Insert', 'insert'));
		pre.replaceWith(block);
		block.append(actions, pre);
	}
}

function showEmptyState(): void {
	messages.querySelector('.empty')?.remove();
	if (messages.querySelector('.message, .notice')) {
		return;
	}
	const empty = create('div', 'empty');
	empty.append(create('p', '', 'Ask about your code. Selected code in the editor is attached to your message.'));
	if (!hasKey) {
		const button = create('button', 'secondary', 'Set API key');
		button.dataset.command = 'setApiKey';
		empty.append(button);
	}
	messages.append(empty);
}

function addNotice(text: string): void {
	const notice = create('div', 'notice error transient', text);
	notice.setAttribute('role', 'alert');
	messages.append(notice);
	messages.scrollTop = messages.scrollHeight;
}

function removeTransient(): void {
	messages.querySelectorAll('.transient, .empty').forEach(element => element.remove());
}

function actionButton(label: string, action: 'copy' | 'insert'): HTMLButtonElement {
	const button = create('button', 'code-action', label);
	button.type = 'button';
	button.dataset.action = action;
	return button;
}

function create<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (className) {
		element.className = className;
	}
	if (text !== undefined) {
		element.textContent = text;
	}
	return element;
}

function byId<T extends HTMLElement>(id: string): T {
	return document.getElementById(id) as T;
}

function resizeInput(): void {
	const maxHeight = 200;
	input.style.height = 'auto';
	// scrollHeight excludes the border, height includes it (border-box).
	const height = input.scrollHeight + input.offsetHeight - input.clientHeight;
	input.style.height = `${Math.min(height, maxHeight)}px`;
	input.style.overflowY = height > maxHeight ? 'auto' : 'hidden';
}

messages.addEventListener('click', event => {
	const target = event.target as HTMLElement;
	const action = target.closest<HTMLElement>('[data-action]');
	if (action) {
		const code = action.closest('.code-block')?.querySelector('code')?.textContent ?? '';
		vscode.postMessage({ type: action.dataset.action, code });
		if (action.dataset.action === 'copy') {
			action.textContent = 'Copied';
			setTimeout(() => action.textContent = 'Copy', 1200);
		}
		return;
	}
	const command = target.closest<HTMLElement>('[data-command]');
	if (command) {
		vscode.postMessage({ type: command.dataset.command });
	}
});

modelButton.addEventListener('click', () => vscode.postMessage({ type: 'selectModel' }));

composer.addEventListener('submit', event => {
	event.preventDefault();
	if (busy) {
		vscode.postMessage({ type: 'stop' });
		return;
	}
	const text = input.value;
	if (!text.trim()) {
		return;
	}
	vscode.postMessage({ type: 'send', text });
	input.value = '';
	resizeInput();
});

input.addEventListener('keydown', event => {
	if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		if (!busy) {
			composer.requestSubmit();
		}
	}
});

input.addEventListener('input', resizeInput);

vscode.postMessage({ type: 'ready' });
