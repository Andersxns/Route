// Installs dependencies and produces a minified build next to vscode/.
//
//   node scripts/build.mjs [--target win32-x64] [--installer]
//                          [--skip-install | --install-only | --package-only]
//
// On slow machines run --install-only first; the package step then skips
// the install because the lockfile hasn't changed. --package-only repackages
// the output of an earlier compile, e.g. after changing icons or product.json.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { appliedMarker, capture, config, fail, log, npm, requireUpstreamCheckout, root, vscodeDir } from './lib.mjs';

const { values: options } = parseArgs({
	options: {
		'target': { type: 'string', default: defaultTarget() },
		'installer': { type: 'boolean', default: false },
		'skip-install': { type: 'boolean', default: false },
		'install-only': { type: 'boolean', default: false },
		'package-only': { type: 'boolean', default: false },
	},
});
const [platform, arch] = options.target.split('-');
const outputDir = path.join(root, `VSCode-${options.target}`);

requireUpstreamCheckout();
if (!fs.existsSync(appliedMarker)) {
	fail('The distribution changes are not applied to vscode/. Run `npm run apply` first.');
}
checkNodeVersion();

if (!options['skip-install'] && !options['package-only']) {
	installDependencies();
}
if (options['install-only']) {
	process.exit(0);
}

const gulpOptions = { cwd: vscodeDir, env: platform === 'win32' ? withWindowsSdkOnPath(process.env) : process.env };
if (options['package-only']) {
	log(`packaging ${options.target} from the last compile`);
	npm(['run', 'gulp', `vscode-${options.target}-min-ci`], gulpOptions);
} else {
	log(`compiling and packaging ${options.target} (this takes a while)`);
	npm(['run', 'gulp', `vscode-${options.target}-min`], gulpOptions);
}
stripElectronLocales();
stripSourceMaps();

if (options.installer) {
	if (platform !== 'win32') {
		fail('--installer is only implemented for Windows targets');
	}
	npm(['run', 'gulp', `vscode-win32-${arch}-inno-updater`], gulpOptions);
	npm(['run', 'gulp', `vscode-win32-${arch}-user-setup`], gulpOptions);
	copyInstaller();
}

log(`build: ${outputDir} (${formatSize(directorySize(outputDir))})`);

function defaultTarget() {
	const arch = process.arch === 'arm' ? 'armhf' : process.arch;
	return `${process.platform}-${arch}`;
}

function checkNodeVersion() {
	const required = fs.readFileSync(path.join(vscodeDir, '.nvmrc'), 'utf8').trim();
	if (required.split('.')[0] !== process.versions.node.split('.')[0]) {
		fail(`upstream needs Node ${required} (from vscode/.nvmrc); this is Node ${process.versions.node}`);
	}
}

function installDependencies() {
	// npm ci wipes node_modules, so only run it when the lockfile or the list
	// of install folders changed since the last successful install.
	const hash = crypto.createHash('sha256')
		.update(fs.readFileSync(path.join(vscodeDir, 'package-lock.json')))
		.update(fs.readFileSync(path.join(vscodeDir, 'build/npm/dirs.ts')))
		.digest('hex');
	const stamp = path.join(vscodeDir, 'node_modules', '.distro-install');
	if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === hash) {
		log('dependencies are up to date');
		return;
	}

	const env = { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
	if (process.platform === 'win32') {
		// Upstream's preinstall check only looks under Program Files; this
		// variable is how it accepts an install somewhere else.
		env.vs2022_install ??= findWindowsBuildTools();
	}
	log('installing dependencies (native modules are compiled against Electron)');
	npm(['ci', '--no-audit', '--no-fund'], { cwd: vscodeDir, env });
	fs.writeFileSync(stamp, hash);
}

function findWindowsBuildTools() {
	const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
	const components = [
		'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
		'Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre',
	];
	const found = fs.existsSync(vswhere) && capture(vswhere, ['-latest', '-products', '*', '-requires', ...components, '-property', 'installationPath']);
	if (!found) {
		fail([
			'Visual Studio Build Tools with the C++ toolchain are required to compile native modules.',
			'Install "Desktop development with C++" plus "MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)".',
			'See README.md#windows-prerequisites.',
		].join('\n'));
	}
	return found;
}

// Upstream's Windows packaging calls signtool.exe and expects it on PATH, as it
// is on Microsoft's build agents. It ships with the Windows SDK.
function withWindowsSdkOnPath(env) {
	const binRoot = path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
	if (!fs.existsSync(binRoot)) {
		return env;
	}
	const newestFirst = fs.readdirSync(binRoot)
		.filter(name => /^\d+(\.\d+){3}$/.test(name))
		.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
	const toolsDir = newestFirst.map(version => path.join(binRoot, version, 'x64')).find(dir => fs.existsSync(path.join(dir, 'signtool.exe')));
	if (!toolsDir) {
		return env;
	}
	// Windows environment names are case-insensitive; reuse the existing key.
	const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
	return { ...env, [pathKey]: `${toolsDir};${env[pathKey] ?? ''}` };
}

function stripElectronLocales() {
	const keep = config.electronLocales;
	const localesDir = path.join(outputDir, 'locales');
	if (!keep?.length || platform === 'darwin' || !fs.existsSync(localesDir)) {
		return;
	}
	let removed = 0;
	for (const file of fs.readdirSync(localesDir)) {
		if (file.endsWith('.pak') && !keep.includes(path.basename(file, '.pak'))) {
			fs.rmSync(path.join(localesDir, file));
			removed++;
		}
	}
	log(`removed ${removed} Chromium locale files (kept ${keep.join(', ')})`);
}

// Upstream removes source maps only on its CI agents. They are only useful for
// debugging the editor itself and add about 300 MB to the installed app.
function stripSourceMaps() {
	let removed = 0;
	let bytes = 0;
	for (const entry of fs.readdirSync(outputDir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile() && entry.name.endsWith('.map')) {
			const file = path.join(entry.parentPath, entry.name);
			bytes += fs.statSync(file).size;
			fs.rmSync(file);
			removed++;
		}
	}
	log(`removed ${removed} source maps (${formatSize(bytes)})`);
}

function copyInstaller() {
	const setupDir = path.join(vscodeDir, '.build', `win32-${arch}`, 'user-setup');
	const distDir = path.join(root, 'dist');
	fs.mkdirSync(distDir, { recursive: true });
	for (const file of fs.readdirSync(setupDir).filter(f => f.endsWith('.exe'))) {
		fs.copyFileSync(path.join(setupDir, file), path.join(distDir, file));
		log(`installer: dist/${file}`);
	}
}

function directorySize(dir) {
	let total = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile()) {
			total += fs.statSync(path.join(entry.parentPath, entry.name)).size;
		}
	}
	return total;
}

function formatSize(bytes) {
	return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}
