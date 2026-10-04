import * as vscode from 'vscode';
import { ApiKeys } from './apiKeys.ts';
import { ChatViewProvider } from './chatView.ts';
import { loadProviders } from './loadProviders.ts';
import { PROVIDER_LABELS } from './providers/catalog.ts';
import type { ProviderId } from './providers/types.ts';
import { readSettings, updateSetting } from './settings.ts';

// Activated lazily: VS Code loads this file only when the chat view is opened
// or one of the commands runs, so it adds nothing to startup time.
export function activate(context: vscode.ExtensionContext): void {
	const keys = new ApiKeys(context.secrets);
	const chat = new ChatViewProvider(context, keys);

	context.subscriptions.push(
		chat,
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat),
		vscode.commands.registerCommand('route.ai.newChat', () => chat.newChat()),
		vscode.commands.registerCommand('route.ai.setApiKey', (provider?: ProviderId) => setApiKey(keys, provider)),
		vscode.commands.registerCommand('route.ai.clearApiKey', () => clearApiKey(keys)),
		vscode.commands.registerCommand('route.ai.selectModel', () => selectModel(keys)),
	);
}

const PROVIDERS = Object.keys(PROVIDER_LABELS) as ProviderId[];

async function pickProvider(title: string): Promise<ProviderId | undefined> {
	const current = readSettings().provider;
	const items = PROVIDERS.map(id => ({ id, label: PROVIDER_LABELS[id], description: id === current ? 'current' : undefined }));
	const picked = await vscode.window.showQuickPick(items, { title });
	return picked?.id;
}

async function setApiKey(keys: ApiKeys, provider?: ProviderId): Promise<boolean> {
	provider ??= await pickProvider('Set the API key for');
	if (!provider) {
		return false;
	}
	const key = await vscode.window.showInputBox({
		title: `${PROVIDER_LABELS[provider]} API key`,
		prompt: 'Saved in your operating system\'s credential store and only sent to this provider.',
		password: true,
		ignoreFocusOut: true,
		validateInput: value => value.trim() ? undefined : 'Enter a key',
	});
	if (!key) {
		return false;
	}
	await keys.set(provider, key.trim());
	return true;
}

async function clearApiKey(keys: ApiKeys): Promise<void> {
	const provider = await pickProvider('Remove the stored API key for');
	if (provider) {
		await keys.delete(provider);
		void vscode.window.showInformationMessage(`Removed the ${PROVIDER_LABELS[provider]} API key.`);
	}
}

interface ModelItem extends vscode.QuickPickItem {
	id: string;
}

async function selectModel(keys: ApiKeys): Promise<void> {
	const provider = await pickProvider('Choose a provider');
	if (!provider) {
		return;
	}

	const { baseUrl } = readSettings();
	if (provider === 'openai-compatible' && !baseUrl) {
		const choice = await vscode.window.showWarningMessage('Set route.ai.baseUrl to your server first.', 'Open Setting');
		if (choice) {
			await vscode.commands.executeCommand('workbench.action.openSettings', 'route.ai.baseUrl');
		}
		return;
	}
	if (provider !== 'openai-compatible' && !(await keys.get(provider)) && !(await setApiKey(keys, provider))) {
		return;
	}

	const picker = vscode.window.createQuickPick<ModelItem>();
	picker.title = `${PROVIDER_LABELS[provider]} model`;
	picker.placeholder = 'Pick a model, or type a model ID and press Enter';
	picker.matchOnDescription = true;
	picker.busy = true;
	picker.show();

	const { createProvider, describeError } = loadProviders();
	try {
		const client = createProvider(provider, await keys.get(provider), provider === 'openai-compatible' ? baseUrl : undefined);
		const models = await client.listModels();
		picker.items = models.map(model => ({ id: model.id, label: model.label, description: model.label === model.id ? undefined : model.id }));
	} catch (error) {
		picker.placeholder = `Could not list models (${describeError(error)}). Type a model ID instead.`;
	}
	picker.busy = false;

	const model = await new Promise<string | undefined>(resolve => {
		picker.onDidAccept(() => resolve(picker.selectedItems[0]?.id ?? (picker.value.trim() || undefined)));
		picker.onDidHide(() => resolve(undefined));
	});
	picker.dispose();

	if (model) {
		await updateSetting('provider', provider);
		await updateSetting('model', model);
	}
}
