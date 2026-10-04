import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ChatProvider, ChatRequest, ChatResult, ModelInfo, StreamHandlers } from './types.ts';

// Talks to OpenAI itself or to any server implementing the Chat Completions
// API (Ollama, LM Studio, vLLM, OpenRouter, ...).
export class OpenAIProvider implements ChatProvider {
	private readonly client: OpenAI;
	private readonly isOpenAI: boolean;

	constructor(apiKey: string | undefined, baseUrl: string | undefined, isOpenAI: boolean) {
		this.client = new OpenAI({
			// Local servers ignore the key, but the SDK refuses to start without one.
			apiKey: apiKey || 'unused',
			// Explicit so an OPENAI_BASE_URL environment variable cannot redirect the key.
			baseURL: baseUrl ?? 'https://api.openai.com/v1',
		});
		this.isOpenAI = isOpenAI;
	}

	async stream(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
		const messages: ChatCompletionMessageParam[] = [
			{ role: 'system', content: request.system },
			...request.turns.map(turn => ({ role: turn.role, content: turn.text })),
		];

		const stream = await this.client.chat.completions.create({
			model: request.model,
			messages,
			stream: true,
			// Current OpenAI models only accept max_completion_tokens, while most
			// compatible servers only understand max_tokens.
			...(this.isOpenAI
				? { max_completion_tokens: request.maxTokens, stream_options: { include_usage: true } }
				: { max_tokens: request.maxTokens }),
		}, { signal: request.signal });

		let text = '';
		let refused = false;
		let finishReason: string | null = null;
		let model = request.model;
		let usage: OpenAI.CompletionUsage | undefined;
		for await (const chunk of stream) {
			model = chunk.model || model;
			usage = chunk.usage ?? usage;
			const choice = chunk.choices[0];
			const delta = choice?.delta.content ?? choice?.delta.refusal;
			if (delta) {
				refused ||= !!choice?.delta.refusal;
				text += delta;
				handlers.onText(delta);
			}
			finishReason = choice?.finish_reason ?? finishReason;
		}
		// The SDK ends the iteration quietly when the request is aborted; report
		// it as an abort, the same way the Anthropic SDK does.
		if (request.signal.aborted) {
			throw new OpenAI.APIUserAbortError();
		}

		return {
			text,
			stopReason: refused || finishReason === 'content_filter' ? 'refusal' : finishReason === 'length' ? 'max_tokens' : 'end',
			model,
			inputTokens: usage?.prompt_tokens,
			outputTokens: usage?.completion_tokens,
		};
	}

	async listModels(): Promise<ModelInfo[]> {
		const models: ModelInfo[] = [];
		for await (const model of this.client.models.list()) {
			models.push({ id: model.id, label: model.id });
		}
		return models.sort((a, b) => a.id.localeCompare(b.id));
	}
}
