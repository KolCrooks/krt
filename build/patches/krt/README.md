# build/patches/krt/

Patches applied on top of the pinned `microsoft/vscode` submodule by
`build/prepare_vscode.sh`. Lexical order — name them `NNNN-short-slug.patch`.

Generate with `git format-patch` from inside the `vscode/` submodule once
your change is committed there locally:

```sh
cd vscode
git format-patch HEAD~1..HEAD --output-directory ../build/patches/krt/
```

Each patch should do **one** focused thing. Keep the set as small as we can —
PLAN.md §6 calls upstream rebase rot a top risk, and small patches rebase more
cleanly than large invasive ones.

The first patch (added in Phase 0) lands the trivial KRT status-bar
contribution that proves the wiring works.
