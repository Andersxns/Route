# Publishing a release

Route IDE doesn't update itself, so each release is published by hand on
GitHub, where [andersxn.com/route](https://andersxn.com/route/) picks it up.

1. Build the installer:

   ```bash
   npm run build -- --installer
   ```

2. Start `VSCode-win32-x64/Route IDE.exe`, open a folder and a `.ts` file. The
   status bar should say *TypeScript* (*Plain Text* means built-in extensions
   failed to load), and `Ctrl+Alt+I` should open Route AI.

3. Name the installer after the version and write its checksum. The version is
   upstream's, from `vscode/package.json`; if you rebuild the same upstream
   version, give the tag a suffix such as `v1.140.0-2`.

   ```bash
   cp dist/route-ide-setup.exe dist/Route-IDE-1.140.0-Setup-x64.exe
   cd dist && sha256sum Route-IDE-1.140.0-Setup-x64.exe > SHA256SUMS.txt
   ```

4. Publish it. While Route is in early access, releases are marked as
   pre-releases:

   ```bash
   gh release create v1.140.0 --repo Andersxns/Route --prerelease \
     --title "Route IDE 1.140.0 (early access)" --notes-file notes.md \
     dist/Route-IDE-1.140.0-Setup-x64.exe dist/SHA256SUMS.txt
   ```

5. The download page reads the newest release from GitHub when it loads. In
   the website folder, run `node scripts/snapshot-releases.mjs` and deploy, so
   the version it shows before that request finishes is current too.
