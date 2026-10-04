import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages';

export type ProviderId = 'anthropic' | 'openai' | 'openai-compatible';

// `display`, `contextLabel` and `meta` are only used to redraw the chat panel.
export interface UserTurn {
	role: 'user';
	/** The full message sent to the model, including any attached code. */
	text: string;
	display?: string;
	contextLabel?: string;
}

export interface AssistantTurn {
	role: 'assistant';
	text: string;
	meta?: string;
	/**
	 * The content blocks an Anthropic model returned, replayed verbatim on the
	 * next request. Thinking blocks are signed against the conversation that
	 * produced them, so history must stay append-only and unedited.
	 */
	anthropicContent?: BetaContentBlockParam[];
}

export type Turn = UserTurn | AssistantTurn;

export interface ChatRequest {
	model: string;
	system: string;
	turns: Turn[];
	maxTokens: number;
	effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
	signal: AbortSignal;
}

export interface StreamHandlers {
	onText(delta: string): void;
	/** Short status line shown while waiting, e.g. "Thinking". */
	onStatus(status: string | undefined): void;
}

export type StopReason = 'end' | 'max_tokens' | 'refusal';

export interface ChatResult {
	text: string;
	anthropicContent?: BetaContentBlockParam[];
	stopReason: StopReason;
	/** The model that produced the reply (can differ from the request after a fallback). */
	model: string;
	inputTokens?: number;
	outputTokens?: number;
	/** Extra detail for refusals and fallbacks. */
	note?: string;
}

export interface ModelInfo {
	id: string;
	label: string;
}

export interface ChatProvider {
	stream(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult>;
	listModels(): Promise<ModelInfo[]>;
}
