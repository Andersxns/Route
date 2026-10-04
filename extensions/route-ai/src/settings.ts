import * as vscode from 'vscode';
import { DEFAULT_MODELS } from './providers/catalog.ts';
import type { ChatRequest, ProviderId } from './providers/types.ts';

export interface AiSettings {
	provider: ProviderId;
	model: string | undefined;
	baseUrl: string | undefined;
	maxTokens: number;
	effort: ChatRequest['effort'];
	includeSelection: boolean;
}

export function readSettings(): AiSettings {
	const config = vscode.workspace.getConfiguration('route.ai');
	const provider = config.get<ProviderId>('provider', 'anthropic');
	return {
		provider,
		model: config.get<string>('model')?.trim() || DEFAULT_MODELS[provider],
		baseUrl: config.get<string>('baseUrl')?.trim() || undefined,
		maxTokens: config.get<number>('maxTokens', 16000),
		effort: config.get<ChatRequest['effort'] | ''>('effort') || undefined,
		includeSelection: config.get<boolean>('includeSelection', true),
	};
}

export async function updateSetting(key: 'provider' | 'model', value: string): Promise<void> {
	await vscode.workspace.getConfiguration('route.ai').update(key, value, vscode.ConfigurationTarget.Global);
}
