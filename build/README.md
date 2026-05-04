# build/

VSCodium-style build pipeline for KRT. Wraps the upstream `vscode/`
submodule: applies KRT's branding (`product.json`) and patches, then runs
the upstream build.

## Files

- `product.json` — KRT branding + open-vsx gallery URLs. Overlaid onto
  `vscode/product.json` by `prepare_vscode.sh`. Phase 1 finalizes the
  contents (icon paths, signed bundle IDs, license/issue URLs).
- `prepare_vscode.sh` — overlays `product.json` and applies patches.
  Currently a stub; fleshed out in Phase 0.
- `patches/krt/` — patches we apply on top of the pinned upstream tag. See
  the README inside.

## Usage (once Phase 0 is done)

```sh
git submodule update --init --recursive   # first time only
bash build/prepare_vscode.sh              # overlay + apply patches
cd vscode && yarn && yarn watch           # or whatever the pinned tag uses
./scripts/code.sh                         # launch the dev build
```

See `docs/phases/phase-00-scaffold.md` for the per-phase checklist.
