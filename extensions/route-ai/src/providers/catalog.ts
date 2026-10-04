import type { ProviderId } from './types.ts';

// Kept free of SDK imports: this file is part of the small activation bundle.

export const PROVIDER_LABELS: Record<ProviderId, string> = {
	'anthropic': 'Anthropic',
	'openai': 'OpenAI',
	'openai-compatible': 'OpenAI-compatible',
};

export const DEFAULT_MODELS: Record<ProviderId, string | undefined> = {
	'anthropic': 'claude-opus-5-5',
	'openai': undefined,
	'openai-compatible': undefined,
};
