const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Returns a problem description, or undefined if the URL is safe to send an API key to. */
export function checkBaseUrl(url: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return `route.ai.baseUrl "${url}" is not a valid URL.`;
	}
	if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
		return undefined;
	}
	return 'route.ai.baseUrl must use https. Plain http is only allowed for localhost, so API keys never travel unencrypted.';
}
