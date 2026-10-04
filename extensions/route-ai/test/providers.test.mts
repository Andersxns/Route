// Runs the provider classes against a local HTTP server that replays canned
// API responses, so the SDKs, SSE parsing and request shapes are exercised
// without a network connection or an API key.
//
//   npm test

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { checkBaseUrl } from '../src/baseUrl.ts';
import { AnthropicProvider, echoableContent } from '../src/providers/anthropic.ts';
import { isAbortError } from '../src/providers/index.ts';
import { OpenAIProvider } from '../src/providers/openai.ts';
import type { ChatRequest, StreamHandlers } from '../src/providers/types.ts';

interface Recorded {
	method: string;
	url: string;
	headers: http.IncomingHttpHeaders;
	body: any;
}

type Event = [name: string | undefined, data: unknown];

let server: http.Server;
let baseUrl: string;
let recorded: Recorded[];
let respond: (request: Recorded, response: http.ServerResponse) => void;

before(async () => {
	server = http.createServer((request, response) => {
		let raw = '';
		request.on('data', chunk => raw += chunk);
		request.on('end', () => {
			const entry = { method: request.method!, url: request.url!, headers: request.headers, body: raw ? JSON.parse(raw) : undefined };
			recorded.push(entry);
			respond(entry, response);
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
	server.closeAllConnections();
	server.close();
});

beforeEach(() => {
	recorded = [];
});

function sse(response: http.ServerResponse, events: Event[]): void {
	response.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const [name, data] of events) {
		response.write(`${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
	}
	response.end();
}

function json(response: http.ServerResponse, body: unknown): void {
	response.writeHead(200, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
}

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
	return {
		model: 'claude-opus-5-5',
		system: 'system prompt',
		turns: [{ role: 'user', text: 'hello' }],
		maxTokens: 1024,
		signal: new AbortController().signal,
		...overrides,
	};
}

function collect(): StreamHandlers & { text: string; statuses: (string | undefined)[] } {
	const handlers = {
		text: '',
		statuses: [] as (string | undefined)[],
		onText: (delta: string) => handlers.text += delta,
		onStatus: (status: string | undefined) => handlers.statuses.push(status),
	};
	return handlers;
}

// ---- Anthropic SSE helpers ----------------------------------------------------

const messageStart = (model = 'claude-opus-5-5'): Event => ['message_start', {
	type: 'message_start',
	message: {
		id: 'msg_1', type: 'message', role: 'assistant', model, content: [],
		stop_reason: null, stop_sequence: null, stop_details: null,
		usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 30 },
	},
}];
const blockStart = (index: number, block: object): Event => ['content_block_start', { type: 'content_block_start', index, content_block: block }];
const delta = (index: number, value: object): Event => ['content_block_delta', { type: 'content_block_delta', index, delta: value }];
const blockStop = (index: number): Event => ['content_block_stop', { type: 'content_block_stop', index }];
const messageDelta = (stopReason: string, extra: object = {}): Event => ['message_delta', {
	type: 'message_delta',
	delta: { stop_reason: stopReason, stop_sequence: null, stop_details: null, ...extra },
	usage: { output_tokens: 20 },
}];
const messageStop: Event = ['message_stop', { type: 'message_stop' }];

describe('AnthropicProvider', () => {
	it('streams text, keeps thinking blocks for replay and reports usage', async () => {
		respond = (_, response) => sse(response, [
			messageStart(),
			blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
			delta(0, { type: 'signature_delta', signature: 'sig-1' }),
			blockStop(0),
			blockStart(1, { type: 'text', text: '' }),
			delta(1, { type: 'text_delta', text: 'Hello ' }),
			delta(1, { type: 'text_delta', text: 'there.' }),
			blockStop(1),
			messageDelta('end_turn'),
			messageStop,
		]);
		const handlers = collect();
		const provider = new AnthropicProvider('test-key', { baseUrl, serverFallback: true });
		const result = await provider.stream(request({ effort: 'high' }), handlers);

		assert.equal(handlers.text, 'Hello there.');
		assert.deepEqual(handlers.statuses, ['Thinking', undefined]);
		assert.equal(result.text, 'Hello there.');
		assert.equal(result.stopReason, 'end');
		assert.equal(result.inputTokens, 42);
		assert.equal(result.outputTokens, 20);
		assert.deepEqual(result.anthropicContent?.map(block => block.type), ['thinking', 'text']);

		const [sent] = recorded;
		assert.equal(sent.url, '/v1/messages?beta=true');
		assert.equal(sent.headers['x-api-key'], 'test-key');
		assert.match(String(sent.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
		assert.equal(sent.body.fallbacks, 'default');
		assert.deepEqual(sent.body.output_config, { effort: 'high' });
		assert.deepEqual(sent.body.cache_control, { type: 'ephemeral' });
		assert.equal(sent.body.system, 'system prompt');
		assert.equal(sent.body.stream, true);
	});

	it('replays stored assistant content verbatim and omits fallbacks for other models', async () => {
		respond = (_, response) => sse(response, [
			messageStart('claude-haiku-4-5'),
			blockStart(0, { type: 'text', text: '' }),
			delta(0, { type: 'text_delta', text: 'ok' }),
			blockStop(0),
			messageDelta('end_turn'),
			messageStop,
		]);
		const previous = [{ type: 'thinking' as const, thinking: '', signature: 'sig-1' }, { type: 'text' as const, text: 'first answer' }];
		const provider = new AnthropicProvider('test-key', { baseUrl, serverFallback: true });
		await provider.stream(request({
			model: 'claude-haiku-4-5',
			turns: [
				{ role: 'user', text: 'one' },
				{ role: 'assistant', text: 'first answer', anthropicContent: previous },
				{ role: 'user', text: 'two' },
			],
		}), collect());

		const [sent] = recorded;
		assert.deepEqual(sent.body.messages[1], { role: 'assistant', content: previous });
		assert.equal(sent.body.fallbacks, undefined);
		assert.equal(sent.headers['anthropic-beta'], undefined);
		assert.equal(sent.body.output_config, undefined);
	});

	it('notes a server-side fallback and drops the declined attempt\'s internal blocks', async () => {
		respond = (_, response) => sse(response, [
			messageStart(),
			blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
			delta(0, { type: 'signature_delta', signature: 'declined' }),
			blockStop(0),
			blockStart(1, { type: 'text', text: '' }),
			delta(1, { type: 'text_delta', text: 'Partial ' }),
			blockStop(1),
			blockStart(2, { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal', category: 'cyber' } }),
			blockStop(2),
			blockStart(3, { type: 'text', text: '' }),
			delta(3, { type: 'text_delta', text: 'answer' }),
			blockStop(3),
			messageDelta('end_turn'),
			messageStop,
		]);
		const result = await new AnthropicProvider('test-key', { baseUrl }).stream(request(), collect());

		assert.equal(result.text, 'Partial answer');
		assert.match(result.note ?? '', /claude-opus-5-5 declined, claude-opus-4-8 answered/);
		assert.deepEqual(result.anthropicContent?.map(block => block.type), ['text', 'text']);
	});

	it('reports a refusal instead of returning partial text as an answer', async () => {
		respond = (_, response) => sse(response, [
			messageStart(),
			messageDelta('refusal', { stop_details: { type: 'refusal', category: 'cyber', explanation: null } }),
			messageStop,
		]);
		const result = await new AnthropicProvider('test-key', { baseUrl }).stream(request(), collect());

		assert.equal(result.stopReason, 'refusal');
		assert.equal(result.note, 'category: cyber');
		assert.equal(result.anthropicContent, undefined);
	});

	it('rejects with an abort error when the request is aborted', async () => {
		respond = (_, response) => {
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			for (const [name, data] of [messageStart(), blockStart(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: 'first' })]) {
				response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
			}
			// never finishes on its own
		};
		const controller = new AbortController();
		const handlers = { onText: () => controller.abort(), onStatus: () => { } };
		await assert.rejects(
			new AnthropicProvider('test-key', { baseUrl }).stream(request({ signal: controller.signal }), handlers),
			error => isAbortError(error),
		);
	});

	it('lists models with their display names', async () => {
		respond = (_, response) => json(response, {
			data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }],
			has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5',
		});
		const models = await new AnthropicProvider('test-key', { baseUrl }).listModels();
		assert.deepEqual(models, [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }]);
	});
});

describe('echoableContent', () => {
	it('keeps everything when there was no fallback', () => {
		const content = [{ type: 'thinking', thinking: '', signature: 'a' }, { type: 'text', text: 'x', citations: null }] as const;
		assert.deepEqual(echoableContent([...content]), [...content]);
	});
});

// ---- OpenAI -----------------------------------------------------------------------

const chunk = (content: string | undefined, finishReason: string | null = null, model = 'llama3.2') => [undefined, {
	id: 'c1', object: 'chat.completion.chunk', created: 0, model,
	choices: [{ index: 0, delta: content === undefined ? {} : { content }, finish_reason: finishReason }],
}] satisfies Event;

describe('OpenAIProvider', () => {
	it('talks to an OpenAI-compatible server with max_tokens and no key', async () => {
		respond = (_, response) => sse(response, [chunk('Hel'), chunk('lo'), chunk(undefined, 'stop'), [undefined, '[DONE]']]);
		const handlers = collect();
		const result = await new OpenAIProvider(undefined, `${baseUrl}/v1`, false).stream(request({ model: 'llama3.2' }), handlers);

		assert.equal(handlers.text, 'Hello');
		assert.equal(result.text, 'Hello');
		assert.equal(result.stopReason, 'end');
		assert.equal(result.model, 'llama3.2');

		const [sent] = recorded;
		assert.equal(sent.url, '/v1/chat/completions');
		assert.equal(sent.body.max_tokens, 1024);
		assert.equal(sent.body.max_completion_tokens, undefined);
		assert.equal(sent.body.stream_options, undefined);
		assert.deepEqual(sent.body.messages, [{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'hello' }]);
	});

	it('uses max_completion_tokens and reads usage from OpenAI', async () => {
		respond = (_, response) => sse(response, [
			chunk('Hi', null, 'gpt-5'),
			chunk(undefined, 'length', 'gpt-5'),
			[undefined, { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'gpt-5', choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }],
			[undefined, '[DONE]'],
		]);
		const result = await new OpenAIProvider('sk-test', `${baseUrl}/v1`, true).stream(request({ model: 'gpt-5' }), collect());

		assert.equal(result.stopReason, 'max_tokens');
		assert.equal(result.inputTokens, 9);
		assert.equal(result.outputTokens, 3);
		const [sent] = recorded;
		assert.equal(sent.headers.authorization, 'Bearer sk-test');
		assert.equal(sent.body.max_completion_tokens, 1024);
		assert.deepEqual(sent.body.stream_options, { include_usage: true });
	});

	it('stops when the request is aborted', async () => {
		respond = (_, response) => {
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.write(`data: ${JSON.stringify(chunk('first')[1])}\n\n`);
			// never finishes on its own
		};
		const controller = new AbortController();
		const handlers = { onText: () => controller.abort(), onStatus: () => { } };
		await assert.rejects(
			new OpenAIProvider(undefined, `${baseUrl}/v1`, false).stream(request({ signal: controller.signal }), handlers),
			error => isAbortError(error),
		);
	});
});

describe('checkBaseUrl', () => {
	it('allows https anywhere and http only on loopback', () => {
		assert.equal(checkBaseUrl('https://openrouter.ai/api/v1'), undefined);
		assert.equal(checkBaseUrl('http://localhost:11434/v1'), undefined);
		assert.equal(checkBaseUrl('http://127.0.0.1:1234/v1'), undefined);
		assert.equal(checkBaseUrl('http://[::1]:8000/v1'), undefined);
		assert.match(checkBaseUrl('http://192.168.1.20:11434/v1') ?? '', /must use https/);
		assert.match(checkBaseUrl('not a url') ?? '', /not a valid URL/);
	});
});
