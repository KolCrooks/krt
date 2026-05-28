# KRT

A fast, cross-platform desktop app for reviewing pull requests.

## Features

- Search and open PRs as tabs, each switchable between Overview, Review, and Editor modes
- Performant diff experience
- AI assisted reviews that give user's context and a deeper understanding of PRs
- LSP support within reviews
- Light API-only mode for quick skims

## Getting Started

__NOTE:__ There currently isn't a distribution of KRT. One day it will exist but while it is in development, you will have to build it yourself.


```bash
npm install
npm run dev
```

## Build

```bash
npm run build      # type-check and build
npm run dist:mac   # package a macOS app
```

## Testing

```bash
npm test           # unit/integration tests (Vitest)
npm run test:ui    # UI tests (Playwright)
```
