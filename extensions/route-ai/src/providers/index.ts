// Everything that needs the Anthropic or OpenAI SDK. Bundled on its own as
// dist/providers.js and loaded with loadProviders() on first use.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AnthropicProvider } from './anthropic.ts';
import { OpenAIProvider } from './openai.ts';
import type { ChatProvider, ProviderId } from './types.ts';

export function createProvider(provider: ProviderId, apiKey: string | undefined, baseUrl: string | undefined): ChatProvider {
	switch (provider) {
		case 'anthropic':
			return new AnthropicProvider(apiKey ?? '', { baseUrl });
		case 'openai':
			return new OpenAIProvider(apiKey, baseUrl, true);
		case 'openai-compatible':
			return new OpenAIProvider(apiKey, baseUrl, false);
	}
}

export function isAbortError(error: unknown): boolean {
	return error instanceof Anthropic.APIUserAbortError
		|| error instanceof OpenAI.APIUserAbortError
		|| (error instanceof Error && error.name === 'AbortError');
}

export function describeError(error: unknown): string {
	if (error instanceof Anthropic.AuthenticationError || error instanceof OpenAI.AuthenticationError) {
		return 'The API key was rejected. Run "Route AI: Set API Key" to replace it.';
	}
	if (error instanceof Anthropic.RateLimitError || error instanceof OpenAI.RateLimitError) {
		return 'The provider is rate limiting requests. Wait a moment and try again.';
	}
	if (error instanceof Anthropic.APIConnectionError || error instanceof OpenAI.APIConnectionError) {
		return `Could not reach the API: ${error.message}`;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
