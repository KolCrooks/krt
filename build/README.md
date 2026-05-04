# build/

VSCodium-style build pipeline for KRT. Manages a local `vscode/` clone
(gitignored — see `docs/upstream-vscode.md`): resets it to the pinned
tag and applies KRT's patches, then runs the upstream build.

## Files

- `upstream-pin` — single line, the upstream `microsoft/vscode` tag we
  vendor. Read by `prepare_vscode.sh` and `clean.sh`. See
  `docs/upstream-vscode.md` for the bump workflow.
- `product.json` — KRT branding + open-vsx gallery URLs. Phase 1 patches
  this onto `vscode/product.json` (currently sits unused; patching the
  branding lands as a Phase 1 patch).
- `prepare_vscode.sh` — resets `vscode/` to the pinned tag, applies all
  patches in `patches/krt/` in lexical order. Idempotent.
- `build.sh` — runs `prepare_vscode.sh`, then `npm install` and
  `npm run compile` inside `vscode/`. One-shot full build.
- `clean.sh` — destructively resets `vscode/` to the pinned tag and runs
  `git clean -xdf` inside the submodule.
- `patches/krt/` — the patch series. See the README inside.

## Usage

First time:

```sh
bash build/build.sh        # clones vscode/ if missing, then npm install + compile
./vscode/scripts/code.sh
```

Iterate:

```sh
# edit code inside vscode/, regenerate the patch from a vscode/ commit:
cd vscode
git format-patch HEAD~1..HEAD --output-directory ../build/patches/krt/

# rebuild from clean state:
cd ..
bash build/clean.sh
bash build/build.sh
```

See `docs/phases/phase-00-scaffold.md` for the Phase 0 checklist and
`docs/upstream-vscode.md` for the upstream pin workflow.
