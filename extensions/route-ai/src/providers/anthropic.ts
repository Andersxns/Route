import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam, BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages';
import type { ChatProvider, ChatRequest, ChatResult, ModelInfo, StreamHandlers, Turn } from './types.ts';

// Models that accept `fallbacks: "default"`: when a safety classifier declines
// a request, the API re-runs it on a model Anthropic picks for that category
// instead of returning an empty refusal. Only available on api.anthropic.com.
const SERVER_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export interface AnthropicOptions {
	/** Only overridden in tests. */
	baseUrl?: string;
	/** Defaults to true when talking to api.anthropic.com. */
	serverFallback?: boolean;
}

export class AnthropicProvider implements ChatProvider {
	private readonly client: Anthropic;
	private readonly serverFallback: boolean;

	constructor(apiKey: string, options: AnthropicOptions = {}) {
		// Passing the default URL explicitly keeps an ANTHROPIC_BASE_URL
		// environment variable from redirecting the key.
		this.client = new Anthropic({ apiKey, baseURL: options.baseUrl ?? 'https://api.anthropic.com' });
		this.serverFallback = options.serverFallback ?? !options.baseUrl;
	}

	async stream(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
		const useFallback = this.serverFallback && SERVER_FALLBACK_MODELS.has(request.model);
		const stream = this.client.beta.messages.stream({
			model: request.model,
			max_tokens: request.maxTokens,
			system: request.system,
			messages: request.turns.map(toMessageParam),
			// Caches the conversation prefix; history is append-only so it keeps hitting.
			cache_control: { type: 'ephemeral' },
			...(request.effort ? { output_config: { effort: request.effort } } : {}),
			...(useFallback ? { fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] } : {}),
		}, { signal: request.signal });

		let fallbackNote: string | undefined;
		for await (const event of stream) {
			if (event.type === 'content_block_start') {
				const block = event.content_block;
				if (block.type === 'thinking' || block.type === 'redacted_thinking') {
					handlers.onStatus('Thinking');
				} else if (block.type === 'fallback') {
					fallbackNote = `${block.from.model} declined, ${block.to.model} answered`;
				} else if (block.type === 'text') {
					handlers.onStatus(undefined);
				}
			} else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
				handlers.onText(event.delta.text);
			}
		}

		const message = await stream.finalMessage();
		const text = textOf(message.content);
		if (message.stop_reason === 'refusal') {
			const category = message.stop_details?.category;
			return { text, stopReason: 'refusal', model: message.model, note: category ? `category: ${category}` : undefined };
		}
		return {
			text,
			anthropicContent: echoableContent(message.content),
			stopReason: message.stop_reason === 'max_tokens' ? 'max_tokens' : 'end',
			model: message.model,
			inputTokens: inputTokens(message.usage),
			outputTokens: message.usage.output_tokens,
			note: fallbackNote,
		};
	}

	async listModels(): Promise<ModelInfo[]> {
		const models: ModelInfo[] = [];
		for await (const model of this.client.models.list()) {
			models.push({ id: model.id, label: model.display_name });
		}
		return models;
	}
}

function toMessageParam(turn: Turn): BetaMessageParam {
	if (turn.role === 'assistant') {
		return { role: 'assistant', content: turn.anthropicContent ?? turn.text };
	}
	return { role: 'user', content: turn.text };
}

function textOf(content: BetaContentBlock[]): string {
	let text = '';
	for (const block of content) {
		if (block.type === 'text') {
			text += block.text;
		}
	}
	return text;
}

// After a fallback mid-reply, only text blocks from before the last `fallback`
// marker may be sent back; the declined attempt's model-internal blocks are
// rejected. Everything after the marker is replayed unchanged.
export function echoableContent(content: BetaContentBlock[]): BetaContentBlockParam[] {
	const boundary = content.findLastIndex(block => block.type === 'fallback');
	return content.filter((block, index) => index > boundary || block.type === 'text');
}

function inputTokens(usage: BetaUsage): number {
	return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}
