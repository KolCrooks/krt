# KRT

Desktop code-review app, shipped as a fork of `microsoft/vscode`. The
upstream source is vendored at [`vscode/`](./vscode/) — edit it directly,
no patches.

See [`PLAN.md`](./PLAN.md) for the full design and roadmap,
[`docs/phases/`](./docs/phases/) for per-phase working checklists, and
[`docs/upstream-vscode.md`](./docs/upstream-vscode.md) for the
upstream-bump workflow.

## Quick start

```sh
brew install node@22
bash build/build.sh
./vscode/scripts/code.sh
```

See [`build/README.md`](./build/README.md) for build details.
