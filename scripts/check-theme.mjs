// Resolves every workbench color the way VS Code does for a theme and reports
// colors that are not grayscale. Upstream adds colors in most releases and
// their defaults are usually blue, so run this after bumping the pinned tag.
//
//   node scripts/check-theme.mjs [path/to/theme.json] [--all]
//
// Defaults are read statically from registerColor() calls in vscode/src and
// from contributes.colors in the built-in extensions; nothing is executed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fail, readJson, root, vscodeDir } from './lib.mjs';

const require = createRequire(path.join(vscodeDir, 'package.json'));
let ts;
try {
	ts = require('typescript');
} catch {
	fail('typescript was not found in vscode/node_modules. Run `npm ci --ignore-scripts` in vscode/ first.');
}

const args = process.argv.slice(2);
const themePath = args.find(arg => !arg.startsWith('--')) ?? path.join(root, 'extensions/route-theme/themes/route-dark.json');
const showAll = args.includes('--all');
const theme = readJson(themePath);
const themeType = theme.type ?? 'dark';
const themeColors = Object.fromEntries(Object.entries(theme.colors ?? {}).map(([id, value]) => [id, value]));

const { Color } = await loadVscodeColorModule();

// ---- collect defaults -------------------------------------------------------

const files = new Map(); // absolute path -> parsed file info
const registry = new Map(); // color id -> { node, info } | { json }

for (const file of walk(path.join(vscodeDir, 'src', 'vs'))) {
	if (fs.readFileSync(file, 'utf8').includes('registerColor(')) {
		getFileInfo(file);
	}
}
for (const dir of fs.readdirSync(path.join(vscodeDir, 'extensions'))) {
	const manifest = path.join(vscodeDir, 'extensions', dir, 'package.json');
	if (fs.existsSync(manifest)) {
		for (const color of readJson(manifest).contributes?.colors ?? []) {
			registry.set(color.id, { json: color.defaults });
		}
	}
}

function getFileInfo(file) {
	if (files.has(file)) {
		return files.get(file);
	}
	const info = { file, locals: new Map(), colorVars: new Map(), imports: new Map(), reexports: [] };
	files.set(file, info);
	if (!fs.existsSync(file)) {
		return info;
	}
	const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

	const visit = node => {
		if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
			const target = resolveModule(file, node.moduleSpecifier.text);
			for (const element of node.importClause.namedBindings.elements) {
				info.imports.set(element.name.text, { file: target, name: (element.propertyName ?? element.name).text });
			}
		} else if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier) {
			info.reexports.push(resolveModule(file, node.moduleSpecifier.text));
		} else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			info.locals.set(node.name.text, node.initializer);
			const id = registeredId(node.initializer);
			if (id) {
				info.colorVars.set(node.name.text, id);
			}
		}
		const id = registeredId(node);
		if (id && !registry.has(id)) {
			registry.set(id, { node: node.arguments[1], info });
		}
		// Tables registered in a loop, e.g. ansiColorMap = { 'terminal.ansiRed': { defaults: {...} } }
		if (ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.name) && ts.isObjectLiteralExpression(node.initializer)) {
			const defaults = node.initializer.properties.find(p => p.name?.getText() === 'defaults');
			if (defaults && !registry.has(node.name.text)) {
				registry.set(node.name.text, { node: defaults.initializer, info });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return info;
}

function registeredId(node) {
	if (ts.isCallExpression(node) && calleeName(node) === 'registerColor' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
		return node.arguments[0].text;
	}
	return undefined;
}

function calleeName(call) {
	const callee = call.expression;
	return ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

function resolveModule(fromFile, specifier) {
	return path.resolve(path.dirname(fromFile), specifier.replace(/\.js$/, '.ts'));
}

function findExportedColor(file, name, seen = new Set()) {
	if (seen.has(file)) {
		return undefined;
	}
	seen.add(file);
	const info = getFileInfo(file);
	if (info.colorVars.has(name)) {
		return info.colorVars.get(name);
	}
	if (info.imports.has(name)) {
		const imported = info.imports.get(name);
		return findExportedColor(imported.file, imported.name, seen);
	}
	for (const target of info.reexports) {
		const id = findExportedColor(target, name, seen);
		if (id) {
			return id;
		}
	}
	return undefined;
}

// ---- evaluate default expressions -----------------------------------------

const unresolved = new Set();

// Turns a TypeScript expression into the ColorValue shape colorUtils.ts uses:
// null | Color | '#hex' | 'color.id' | { op, ... }.
function evaluate(node, info) {
	if (!node) {
		return null;
	}
	if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node)) {
		return evaluate(node.expression, info);
	}
	if (node.kind === ts.SyntaxKind.NullKeyword) {
		return null;
	}
	if (ts.isStringLiteralLike(node)) {
		return node.text;
	}
	if (ts.isObjectLiteralExpression(node)) {
		const property = node.properties.find(p => p.name && (p.name.text ?? p.name.getText()) === themeType);
		if (!property) {
			return null;
		}
		return evaluate(ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer, info);
	}
	if (ts.isIdentifier(node)) {
		if (node.text === 'undefined') {
			return null;
		}
		if (info.colorVars.has(node.text)) {
			return info.colorVars.get(node.text);
		}
		if (info.locals.has(node.text)) {
			return evaluate(info.locals.get(node.text), info);
		}
		const imported = info.imports.get(node.text);
		const id = imported && findExportedColor(imported.file, imported.name);
		if (id) {
			return id;
		}
	}
	if (ts.isPropertyAccessExpression(node) && node.expression.getText() === 'Color') {
		const constant = Color[node.name.text];
		if (constant instanceof Color) {
			return constant;
		}
	}
	if (ts.isNewExpression(node) && node.expression.getText() === 'Color') {
		const rgba = node.arguments?.[0];
		if (rgba && ts.isNewExpression(rgba)) {
			const [r, g, b, a] = rgba.arguments.map(arg => number(arg, info));
			return Color.fromHex(toHex(r, g, b, a ?? 1));
		}
	}
	if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
		// Color instance methods, e.g. Color.black.lighten(0.2)
		const method = node.expression.name.text;
		const [a, b] = node.arguments;
		if (method === 'fromHex') {
			return Color.fromHex(a.text);
		}
		const value = evaluate(node.expression.expression, info);
		switch (method) {
			case 'darken':
			case 'lighten':
			case 'transparent': return { op: method, value, factor: number(a, info) };
			case 'makeOpaque': return { op: 'opaque', value, background: evaluate(a, info) };
			case 'mix': return { op: 'mix', color: value, with: evaluate(a, info), ratio: number(b, info) };
		}
	}
	if (ts.isCallExpression(node)) {
		const name = calleeName(node);
		const [a, b, c, d] = node.arguments;
		switch (name) {
			case 'registerColor': return registeredId(node);
			case 'darken':
			case 'lighten':
			case 'transparent': return { op: name, value: evaluate(a, info), factor: number(b, info) };
			case 'opaque': return { op: name, value: evaluate(a, info), background: evaluate(b, info) };
			case 'oneOf': return { op: name, values: node.arguments.map(arg => evaluate(arg, info)) };
			case 'ifDefinedThenElse': return { op: name, if: evaluate(a, info), then: evaluate(b, info), else: evaluate(c, info) };
			case 'lessProminent': return { op: name, value: evaluate(a, info), background: evaluate(b, info), factor: number(c, info), transparency: number(d, info) };
			case 'mix': return { op: name, color: evaluate(a, info), with: evaluate(b, info), ratio: c ? number(c, info) : undefined };
		}
	}
	if (ts.isConditionalExpression(node) && node.condition.getText() === 'isWeb') {
		return evaluate(node.whenFalse, info);
	}
	unresolved.add(`${path.relative(vscodeDir, info.file)}: ${node.getText().slice(0, 80)}`);
	return null;
}

function number(node, info) {
	if (!node) {
		return undefined;
	}
	if (ts.isNumericLiteral(node)) {
		return Number(node.text);
	}
	if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
		return -number(node.operand, info);
	}
	if (ts.isIdentifier(node) && info.locals.has(node.text)) {
		return number(info.locals.get(node.text), info);
	}
	unresolved.add(`${path.relative(vscodeDir, info.file)}: ${node.getText()}`);
	return 1;
}

// ---- resolve against the theme (mirrors colorUtils.ts) ---------------------

const cache = new Map();

function resolveId(id, stack = []) {
	if (Object.hasOwn(themeColors, id)) {
		return Color.fromHex(themeColors[id]);
	}
	if (cache.has(id)) {
		return cache.get(id);
	}
	if (stack.includes(id)) {
		return undefined;
	}
	const entry = registry.get(id);
	let value = null;
	if (entry?.json) {
		const key = { dark: 'dark', light: 'light', hcDark: 'highContrast', hcLight: 'highContrastLight' }[themeType];
		value = entry.json[key] ?? null;
	} else if (entry) {
		value = evaluate(entry.node, entry.info);
	}
	const color = resolveValue(value, [...stack, id]);
	cache.set(id, color);
	return color;
}

function resolveValue(value, stack) {
	if (value === null || value === undefined) {
		return undefined;
	}
	if (value instanceof Color) {
		return value;
	}
	if (typeof value === 'string') {
		return value.startsWith('#') ? Color.fromHex(value) : resolveId(value, stack);
	}
	const resolve = v => resolveValue(v, stack);
	switch (value.op) {
		case 'darken': return resolve(value.value)?.darken(value.factor);
		case 'lighten': return resolve(value.value)?.lighten(value.factor);
		case 'transparent': return resolve(value.value)?.transparent(value.factor);
		case 'mix': return (resolve(value.color) ?? Color.transparent).mix(resolve(value.with) ?? Color.transparent, value.ratio);
		case 'opaque': {
			const background = resolve(value.background);
			return background ? resolve(value.value)?.makeOpaque(background) : resolve(value.value);
		}
		case 'oneOf':
			for (const candidate of value.values) {
				const color = resolve(candidate);
				if (color) {
					return color;
				}
			}
			return undefined;
		case 'ifDefinedThenElse':
			return resolve(Object.hasOwn(themeColors, value.if) ? value.then : value.else);
		case 'lessProminent': {
			const from = resolve(value.value);
			if (!from) {
				return undefined;
			}
			const background = resolve(value.background);
			if (!background) {
				return from.transparent(value.factor * value.transparency);
			}
			return from.isDarkerThan(background)
				? Color.getLighterColor(from, background, value.factor).transparent(value.transparency)
				: Color.getDarkerColor(from, background, value.factor).transparent(value.transparency);
		}
	}
	return undefined;
}

// ---- initial colors -------------------------------------------------------------

// The workbench paints COLOR_THEME_DARK_INITIAL_COLORS before the theme
// extension has loaded (first launch). Print the same keys resolved for this
// theme so patches/0003 can be regenerated after an upstream bump.
if (args.includes('--initial-colors')) {
	const source = fs.readFileSync(path.join(vscodeDir, 'src/vs/workbench/services/themes/common/workbenchThemeService.ts'), 'utf8');
	const block = /COLOR_THEME_DARK_INITIAL_COLORS = \{([\s\S]*?)\n\};/.exec(source)[1];
	for (const [, id] of block.matchAll(/'([^']+)':/g)) {
		const color = resolveId(id);
		if (color) {
			console.log(`\t'${id}': '${Color.Format.CSS.formatHexA(color, true).toUpperCase()}',`);
		}
	}
	process.exit(0);
}

// ---- report -------------------------------------------------------------------

const chromatic = [];
for (const id of [...registry.keys()].sort()) {
	const color = resolveId(id);
	if (!color) {
		continue;
	}
	const { r, g, b, a } = color.rgba;
	const chroma = Math.max(r, g, b) - Math.min(r, g, b);
	if (showAll || (chroma > 12 && a > 0.03)) {
		chromatic.push(`${id.padEnd(58)} ${Color.Format.CSS.formatHexA(color, true)}${Object.hasOwn(themeColors, id) ? '  (set by theme)' : ''}`);
	}
}

const unknownKeys = Object.keys(themeColors).filter(id => !registry.has(id));

console.log(`${registry.size} registered colors, ${Object.keys(themeColors).length} set by ${path.relative(root, themePath)}`);
if (unknownKeys.length) {
	console.log(`\nTheme keys that are not registered colors (typo or removed upstream):\n  ${unknownKeys.join('\n  ')}`);
}
if (unresolved.size) {
	console.log(`\nDefault expressions this script could not evaluate:\n  ${[...unresolved].join('\n  ')}`);
}
console.log(showAll ? '\nAll resolved colors:' : `\nNon-grayscale colors: ${chromatic.length}`);
if (chromatic.length) {
	console.log(`  ${chromatic.join('\n  ')}`);
}
process.exitCode = !showAll && (chromatic.length || unknownKeys.length) ? 1 : 0;

// ---- helpers -------------------------------------------------------------------

function* walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'test') {
				yield* walk(full);
			}
		} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.includes('.test.')) {
			yield full;
		}
	}
}

function toHex(r, g, b, a) {
	const hex = n => Math.round(n).toString(16).padStart(2, '0');
	return `#${hex(r)}${hex(g)}${hex(b)}${hex(a * 255)}`;
}

// Uses upstream's own Color class so darken/lighten/mix match VS Code exactly.
async function loadVscodeColorModule() {
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-check-'));
	for (const name of ['color', 'charCode']) {
		const source = fs.readFileSync(path.join(vscodeDir, 'src/vs/base/common', `${name}.ts`), 'utf8');
		const { outputText } = ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, preserveConstEnums: true },
		});
		fs.writeFileSync(path.join(outDir, `${name}.js`), outputText);
	}
	fs.writeFileSync(path.join(outDir, 'package.json'), '{ "type": "module" }');
	try {
		return await import(pathToFileURL(path.join(outDir, 'color.js')).href);
	} finally {
		fs.rmSync(outDir, { recursive: true, force: true });
	}
}
