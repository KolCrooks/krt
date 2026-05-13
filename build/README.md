# build/

Build pipeline for KRT.

`vscode/` is vendored source, not a clone-on-build. Edit it directly and
commit — there are no patches to regenerate.

## Files

- `build.sh` — runs `npm install` + `npm run compile` inside `vscode/`,
  rebuilds native modules against the bundled Electron. One-shot full
  build.
- `clean.sh` — wipes build artifacts under `vscode/` (node_modules, out,
  .build, etc.). Does **not** touch source — every other file in `vscode/`
  is committed work.
- `check-no-ms-endpoints.sh` — greps the shipping source for Microsoft
  telemetry / marketplace endpoints. Run as part of `build.sh` before
  compile.
- `icons/` — KRT placeholder icons (`.icns`, `.png`). These are committed
  in place at `vscode/resources/{darwin,linux}/`. The originals here are
  kept for regeneration via `build-icns.sh`.

## Usage

Prerequisites (one-time):

```sh
brew install node@22   # upstream pins Node 22; nodenv users get it via .node-version
```

Full build:

```sh
bash build/build.sh
./vscode/scripts/code.sh    # launch the dev binary
```

Iterate:

```sh
# edit vscode/ source as usual, then either run the full build or
# the incremental compile inside vscode/:
cd vscode
npm run watch     # or: npm run compile
```

Reset build artifacts without losing source changes:

```sh
bash build/clean.sh
```

See `docs/upstream-vscode.md` for the upstream-bump workflow.
