import * as vscode from 'vscode';
import type { ProviderId } from './providers/types.ts';

// Keys live in VS Code's SecretStorage, which encrypts them with the OS
// credential store (DPAPI on Windows, Keychain on macOS, libsecret on Linux).
// They are only read in the extension host and never sent to the webview.
export class ApiKeys {
	private readonly secrets: vscode.SecretStorage;

	constructor(secrets: vscode.SecretStorage) {
		this.secrets = secrets;
	}

	get(provider: ProviderId): Thenable<string | undefined> {
		return this.secrets.get(secretName(provider));
	}

	set(provider: ProviderId, key: string): Thenable<void> {
		return this.secrets.store(secretName(provider), key);
	}

	delete(provider: ProviderId): Thenable<void> {
		return this.secrets.delete(secretName(provider));
	}

	onDidChange(listener: () => void): vscode.Disposable {
		return this.secrets.onDidChange(event => {
			if (event.key.startsWith('route.ai.apiKey.')) {
				listener();
			}
		});
	}
}

function secretName(provider: ProviderId): string {
	return `route.ai.apiKey.${provider}`;
}
