# Distribution

Packaging uses `electron-builder` with macOS-first defaults.

- `npm run pack` creates an unsigned unpacked app in `release/`.
- `npm run dist:mac` creates DMG and ZIP artifacts.
- Signing uses the local macOS keychain when a Developer ID certificate is available.
- Notarization is opt-in: set `KRT_NOTARIZE=true`, `APPLE_ID`, `APPLE_ID_PASSWORD`, and `APPLE_TEAM_ID`.
- Auto-update support is wired through Electron's main-process updater and is disabled until a signed update feed URL is configured in Settings.

Local CI-style packaging checks should use `CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack` so no signing identity is required.
