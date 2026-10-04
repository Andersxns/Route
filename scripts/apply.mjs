// Applies this distribution's changes to a clean upstream checkout in vscode/:
// source patches, removed built-in extensions, product.json, the bundled
// extensions from extensions/, and branding.

import fs from 'node:fs';
import path from 'node:path';
import { appliedMarker, capture, config, fail, log, npm, readJson, requireUpstreamCheckout, root, run, vscodeDir, writeJson } from './lib.mjs';

requireUpstreamCheckout();

const head = capture('git', ['rev-parse', 'HEAD'], { cwd: vscodeDir });
if (head !== config.upstream.commit) {
	fail(`vscode/ is at ${head.slice(0, 10)} but distro.json pins ${config.upstream.commit.slice(0, 10)}. Run \`npm run sync\`.`);
}
if (fs.existsSync(appliedMarker) || capture('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: vscodeDir })) {
	fail('vscode/ already has changes. Run `npm run sync` to reset it, then apply again.');
}

applyPatches();
removeExtensions();
updateProductJson();
addBundledExtensions();
replaceBranding();
copyBrandingAssets();

fs.writeFileSync(appliedMarker, `${config.upstream.commit}\n`);
log('done. Next: `npm run build`');

function applyPatches() {
	const dir = path.join(root, 'patches');
	for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.patch')).sort()) {
		log(`patch ${name}`);
		run('git', ['apply', '--whitespace=nowarn', path.join(dir, name)], { cwd: vscodeDir });
	}
}

function removeExtensions() {
	const names = Object.keys(config.removeExtensions);
	for (const name of names) {
		const dir = path.join(vscodeDir, 'extensions', name);
		if (!fs.existsSync(dir)) {
			fail(`extensions/${name} is not in this upstream version; remove it from distro.json`);
		}
		fs.rmSync(dir, { recursive: true, force: true });
		log(`removed extensions/${name}: ${config.removeExtensions[name]}`);
	}

	// The build keeps hard-coded lists of extension folders (npm install
	// targets, tsconfig paths). Drop the list entries for removed folders.
	const isRemovedEntry = line => {
		const match = /^\s*'extensions\/([^/']+)[^']*',?\s*$/.exec(line);
		return match !== null && names.includes(match[1]);
	};
	for (const file of ['build/npm/dirs.ts', 'build/gulpfile.extensions.ts']) {
		editFile(file, text => {
			const eol = text.includes('\r\n') ? '\r\n' : '\n';
			return text.split(eol).filter(line => !isRemovedEntry(line)).join(eol);
		});
	}
}

function updateProductJson() {
	const file = path.join(vscodeDir, 'product.json');
	const product = readJson(file);

	const dropped = Object.keys(config.removeBuiltInExtensions);
	for (const name of dropped) {
		if (!product.builtInExtensions.some(extension => extension.name === name)) {
			fail(`${name} is not in upstream builtInExtensions; remove it from distro.json`);
		}
	}
	product.builtInExtensions = product.builtInExtensions.filter(extension => !dropped.includes(extension.name));

	// Deleting a key that IProductConfiguration declares as required breaks the
	// app at runtime: without builtInExtensionsEnabledWithAutoUpdates, for
	// example, extension scanning throws and no extension loads.
	const overlay = readJson(path.join(root, 'product.json'));
	const productType = fs.readFileSync(path.join(vscodeDir, 'src', 'vs', 'base', 'common', 'product.ts'), 'utf8');
	for (const [key, value] of Object.entries(overlay)) {
		if (value === null && new RegExp(`\\breadonly ${key}:`).test(productType)) {
			fail(`product.json: "${key}" is required upstream; give it an empty value instead of null`);
		}
	}

	writeJson(file, merge(product, overlay));
	log('merged product.json');
}

// Objects merge recursively, anything else replaces, and null deletes the key.
function merge(base, overlay) {
	const result = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		if (value === null) {
			delete result[key];
		} else if (isPlainObject(value) && isPlainObject(result[key])) {
			result[key] = merge(result[key], value);
		} else {
			result[key] = value;
		}
	}
	return result;
}

function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addBundledExtensions() {
	const sourceRoot = path.join(root, 'extensions');
	for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
		const name = entry.name;
		const dir = path.join(sourceRoot, name);
		const manifest = readJson(path.join(dir, 'package.json'));

		if (manifest.scripts?.build) {
			if (isOlder(path.join(dir, 'node_modules'), path.join(dir, 'package-lock.json'))) {
				npm(['ci', '--no-audit', '--no-fund'], { cwd: dir });
			}
			npm(['run', 'build'], { cwd: dir });
		}

		const target = path.join(vscodeDir, 'extensions', name);
		fs.mkdirSync(target, { recursive: true });
		for (const file of manifest.files ?? []) {
			fs.cpSync(path.join(dir, file), path.join(target, file), { recursive: true });
		}

		// Ship the manifest without build metadata. Dependencies are bundled into
		// dist/, and the upstream packaging step runs `npm list` on this folder,
		// which would fail on dependencies that are declared but not installed.
		const shipped = { ...manifest };
		for (const key of ['scripts', 'dependencies', 'devDependencies', 'allowScripts', 'files']) {
			delete shipped[key];
		}
		writeJson(path.join(target, 'package.json'), shipped);
		log(`added extensions/${name}`);
	}
}

function isOlder(file, than) {
	return !fs.existsSync(file) || fs.statSync(file).mtimeMs < fs.statSync(than).mtimeMs;
}

function replaceBranding() {
	const { company, url } = config;
	if (!/^[\w .,&-]+$/.test(company)) {
		fail('distro.json "company" may only contain letters, digits, spaces and . , & -');
	}
	// Inno Setup expands {...} as constants, so braces can't appear in the URL.
	if (url !== undefined && !/^https:\/\/[^\s{}"]+$/.test(url)) {
		fail('distro.json "url" must be an https URL without spaces, braces or quotes');
	}
	const copyright = [/Copyright \(C\) (\d{4}) Microsoft\. All rights reserved/g, `Copyright (C) $1 ${company}. All rights reserved`];

	replaceIn('build/lib/electron.ts', [
		[`companyName: 'Microsoft Corporation'`, `companyName: '${company}'`],
		copyright,
	]);
	replaceIn('build/gulpfile.vscode.ts', [
		[`'CompanyName': 'Microsoft Corporation'`, `'CompanyName': '${company}'`],
		copyright,
	]);
	replaceIn('build/win32/code.iss', [
		[/^AppPublisher=[^\r\n]*/m, `AppPublisher=${company}`],
		// The links Windows shows for the app under Settings > Apps.
		url
			? [/^App(Publisher|Support|Updates)URL=[^\r\n]*/gm, `App$1URL=${url}`]
			: [/^App(Publisher|Support|Updates)URL=[^\r\n]*\r?\n/gm, ''],
		[/^OutputBaseFilename=VSCodeSetup/m, 'OutputBaseFilename={#ApplicationName}-setup'],
		[
			'install VS Code for all users in this system, download the System Installer instead from https://code.visualstudio.com',
			'install {#NameLong} for all users in this system, use the System Installer instead',
		],
	]);
	replaceIn('resources/win32/VisualElementsManifest.xml', [
		[/BackgroundColor="#[0-9A-Fa-f]{6}"/, 'BackgroundColor="#000000"'],
	]);
	log(`branded build metadata for "${company}"`);
}

function copyBrandingAssets() {
	const destinations = {
		'win32': 'resources/win32',
		'linux': 'resources/linux',
		'letterpress': 'src/vs/workbench/browser/parts/editor/media',
	};
	for (const [from, to] of Object.entries(destinations)) {
		const sourceDir = path.join(root, 'branding', from);
		if (!fs.existsSync(sourceDir)) {
			continue;
		}
		for (const name of fs.readdirSync(sourceDir)) {
			const target = path.join(vscodeDir, to, name);
			if (!fs.existsSync(target)) {
				fail(`${to}/${name} no longer exists upstream; update branding/${from}`);
			}
			fs.copyFileSync(path.join(sourceDir, name), target);
		}
		log(`copied branding/${from} -> ${to}`);
	}

	// The product icon in the title bar, banner and Welcome page, and on the
	// page GitHub sign-in ends on. The logo's black tile keeps it visible on
	// light themes too.
	for (const productIcon of ['src/vs/workbench/browser/media/code-icon.svg', 'extensions/github-authentication/media/code-icon.svg']) {
		if (!fs.existsSync(path.join(vscodeDir, productIcon))) {
			fail(`${productIcon} no longer exists upstream; update copyBrandingAssets`);
		}
		fs.copyFileSync(path.join(root, 'branding', 'logo.svg'), path.join(vscodeDir, productIcon));
		log(`copied branding/logo.svg -> ${productIcon}`);
	}
}

// Every replacement must match: if upstream changes one of these files we want
// the apply step to stop instead of silently shipping Microsoft branding.
function replaceIn(file, replacements) {
	editFile(file, text => {
		for (const [pattern, replacement] of replacements) {
			const matched = typeof pattern === 'string' ? text.includes(pattern) : new RegExp(pattern).test(text);
			if (!matched) {
				fail(`${file}: pattern ${pattern} not found; upstream changed this file`);
			}
			text = typeof pattern === 'string' ? text.replaceAll(pattern, replacement) : text.replace(pattern, replacement);
		}
		return text;
	});
}

function editFile(file, edit) {
	const fullPath = path.join(vscodeDir, file);
	fs.writeFileSync(fullPath, edit(fs.readFileSync(fullPath, 'utf8')));
}
