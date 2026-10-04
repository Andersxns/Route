// The SDKs are bundled separately (see esbuild.mjs) and only loaded when the
// first request is made, so opening the panel does not pay for parsing them.
export function loadProviders(): typeof import('./providers/index.ts') {
	return require('./providers.js');
}
