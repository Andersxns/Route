// Bundles the extension host code and the webview script into dist/.
//
//   node esbuild.mjs           production build
//   node esbuild.mjs --watch   rebuild on change, with source maps

import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');

const common = {
	bundle: true,
	minify: !watch,
	sourcemap: watch ? 'inline' : false,
	logLevel: 'info',
	metafile: true,
};

const builds = [
	{
		...common,
		entryPoints: ['src/extension.ts'],
		outfile: 'dist/extension.js',
		platform: 'node',
		format: 'cjs',
		target: 'node22',
		// providers.js holds both SDKs and is required on first use (src/loadProviders.ts).
		external: ['vscode', './providers.js'],
	},
	{
		...common,
		entryPoints: ['src/providers/index.ts'],
		outfile: 'dist/providers.js',
		platform: 'node',
		format: 'cjs',
		target: 'node22',
	},
	{
		...common,
		entryPoints: ['src/webview/main.ts'],
		outfile: 'dist/webview.js',
		platform: 'browser',
		format: 'iife',
		target: 'chrome130',
	},
];

if (watch) {
	for (const options of builds) {
		await (await esbuild.context(options)).watch();
	}
} else {
	fs.rmSync('dist', { recursive: true, force: true });
	const results = await Promise.all(builds.map(options => esbuild.build(options)));
	writeThirdPartyLicenses(results.map(result => result.metafile));
}

// The bundles include code from npm packages (MIT and Apache-2.0); ship their
// license texts next to them.
function writeThirdPartyLicenses(metafiles) {
	const packages = new Map();
	for (const metafile of metafiles) {
		for (const input of Object.keys(metafile.inputs)) {
			const match = /^(.*node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(input);
			if (match && !packages.has(match[1])) {
				packages.set(match[1], JSON.parse(fs.readFileSync(path.join(match[1], 'package.json'), 'utf8')));
			}
		}
	}

	const sections = [...packages].sort(([, a], [, b]) => a.name.localeCompare(b.name)).map(([dir, manifest]) => {
		const licenseFile = fs.readdirSync(dir).find(file => /^(licen[cs]e|copying)(\.|$)/i.test(file));
		const text = licenseFile ? fs.readFileSync(path.join(dir, licenseFile), 'utf8').trim() : `License: ${manifest.license}`;
		return `${manifest.name}@${manifest.version}\n\n${text}`;
	});
	fs.writeFileSync('dist/THIRD_PARTY_LICENSES.txt', sections.join(`\n\n${'-'.repeat(72)}\n\n`) + '\n');
	console.log(`  dist/THIRD_PARTY_LICENSES.txt (${packages.size} packages)`);
}
