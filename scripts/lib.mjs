import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const vscodeDir = path.join(root, 'vscode');
export const appliedMarker = path.join(vscodeDir, '.distro-applied');
export const config = readJson(path.join(root, 'distro.json'));
const scriptName = path.basename(process.argv[1] ?? 'distro', '.mjs');

export function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
	fs.writeFileSync(file, JSON.stringify(value, null, '\t') + '\n');
}

export function log(message) {
	console.log(`[${scriptName}] ${message}`);
}

export function fail(message) {
	console.error(`[${scriptName}] error: ${message}`);
	process.exit(1);
}

export function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: 'inherit', ...options });
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		fail(`${command} ${args.join(' ')} exited with code ${result.status}`);
	}
}

export function capture(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: 'utf8', ...options });
	if (result.status !== 0) {
		fail(`${command} ${args.join(' ')} failed:\n${result.stderr}`);
	}
	return result.stdout.trim();
}

// Prefer the npm that launched us (npm_execpath) so no shell is involved;
// fall back to the npm on PATH. Arguments must not contain spaces on Windows.
export function npm(args, options = {}) {
	const npmCli = process.env.npm_execpath;
	if (npmCli && npmCli.endsWith('.js')) {
		run(process.execPath, [npmCli, ...args], options);
	} else {
		run('npm', args, { shell: process.platform === 'win32', ...options });
	}
}

export function requireUpstreamCheckout() {
	if (!fs.existsSync(path.join(vscodeDir, '.git'))) {
		fail('vscode/ does not exist. Run `npm run sync` first.');
	}
}
