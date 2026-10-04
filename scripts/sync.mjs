// Puts vscode/ at the upstream commit pinned in distro.json and discards any
// local changes there. Ignored files (node_modules, build output) are kept so
// the next build does not have to reinstall everything.

import fs from 'node:fs';
import path from 'node:path';
import { capture, config, fail, log, run, vscodeDir } from './lib.mjs';

const { repo, tag, commit } = config.upstream;
const git = (args, options) => run('git', args, { cwd: vscodeDir, ...options });

if (!fs.existsSync(path.join(vscodeDir, '.git'))) {
	log(`cloning ${repo} at ${tag}`);
	run('git', ['-c', 'core.longpaths=true', 'clone', '--depth', '1', '--branch', tag, repo, vscodeDir]);
	git(['config', 'core.longpaths', 'true']);
} else {
	log(`fetching ${tag}`);
	git(['fetch', '--depth', '1', 'origin', `+refs/tags/${tag}:refs/tags/${tag}`]);
}

const resolved = capture('git', ['rev-parse', `${tag}^{commit}`], { cwd: vscodeDir });
if (resolved !== commit) {
	fail(`tag ${tag} points to ${resolved}, but distro.json pins ${commit}`);
}

git(['checkout', '--quiet', '--force', '--detach', commit]);
git(['clean', '-fd', '--quiet']);

log(`vscode/ is at ${tag} (${commit.slice(0, 10)})`);
