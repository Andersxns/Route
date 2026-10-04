# Moving to a new upstream release

1. Look up the commit for the release tag:

   ```bash
   git ls-remote https://github.com/microsoft/vscode.git refs/tags/1.141.0
   ```

   Put the tag and commit in `distro.json` under `upstream`.

2. Reset and apply:

   ```bash
   npm run sync
   npm run apply
   ```

   `apply` stops at the first thing that no longer fits: a patch that does not
   apply, an extension in `removeExtensions` that upstream renamed or deleted,
   a branding string that moved, or a key that `product.json` deletes with
   `null` but upstream now requires. The message names the file or key.

3. If a patch fails, rebuild it on a clean checkout:

   ```bash
   npm run sync
   cd vscode
   git apply --reject ../patches/0002-default-telemetry-experiments-ai-off.patch
   ```

   Make the rejected hunks (`*.rej`) by hand, delete the `.rej` files, then
   write the patch back and start over:

   ```bash
   git diff > ../patches/0002-default-telemetry-experiments-ai-off.patch
   cd ..
   npm run sync
   npm run apply
   ```

4. `patches/0003-default-theme.patch` contains a color map generated from the
   theme (the colors painted before the theme extension loads). If upstream
   changed that map, print the new one and paste it over
   `COLOR_THEME_DARK_INITIAL_COLORS` in
   `vscode/src/vs/workbench/services/themes/common/workbenchThemeService.ts`
   before writing the patch back:

   ```bash
   node scripts/check-theme.mjs --initial-colors
   ```

   This and the next step read upstream's TypeScript from
   `vscode/node_modules`; run `npm ci --ignore-scripts` in `vscode/` if you
   have not built yet.

5. Check the theme against the new color registry:

   ```bash
   npm run check-theme
   ```

   Add any colors it reports to `extensions/route-theme/themes/route-dark.json`
   and remove theme keys that upstream deleted, until it reports nothing.

6. Build and try the parts Route IDE touches: the theme and icons, Route AI
   with each provider, installing an extension from Open VSX, the terminal,
   git, and the installer. Open a `.ts` file first: if the status bar says
   *Plain Text*, built-in extensions failed to load, and the window's log
   (**Developer: Show Logs**) says why.

When upstream adds a new Microsoft or GitHub service integration, VSCodium
usually patches it first; its
[patches folder](https://github.com/VSCodium/vscodium/tree/master/patches) is
the place to look.
