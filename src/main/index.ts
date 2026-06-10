import { app, autoUpdater, BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppPaths } from "./appPaths.js";
import { openDatabase } from "./services/database.js";
import { SettingsStore } from "./services/settingsStore.js";
import { Keychain } from "./services/keychain.js";
import { ProviderRegistry } from "./providers/providerRegistry.js";
import { OperationService } from "./services/operationService.js";
import { RepoService } from "./services/repoService.js";
import { AiService } from "./services/aiService.js";
import { ChangeMapService } from "./services/changeMapService.js";
import { ExtensionService } from "./services/extensionService.js";
import { PerfService } from "./services/perfService.js";
import { registerIpcHandlers } from "./ipcHandlers.js";
import { LspService } from "./services/lspService.js";
import { PrCacheService } from "./services/prCacheService.js";
import { ProviderResponseCache } from "./services/providerResponseCache.js";
import { UpdateService } from "./services/updateService.js";
import { MaintenanceService } from "./services/maintenanceService.js";
import { DiagnosticsService } from "./services/diagnosticsService.js";
import { installApplicationMenu } from "./appMenu.js";
import { isAllowedAppNavigation, openExternalUrl } from "./externalLinks.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

let mainWindow: BrowserWindow | null = null;

async function createMainWindow(): Promise<void> {
  const appPaths = createAppPaths(app.getPath("userData"));
  const db = openDatabase(appPaths.database);
  const settings = new SettingsStore(db);
  const keychain = new Keychain();
  const providerCache = new ProviderResponseCache(db);
  const providers = new ProviderRegistry(keychain, providerCache, () => settings.get());
  const operations = new OperationService();
  const repos = new RepoService(appPaths, db, operations, {
    getSettings: () => settings.get(),
    getGitHubToken: () => providers.getGitHubToken()
  });
  const extensions = new ExtensionService(() => settings.get(), (update) => settings.update(update), {
    localExtensionDir: appPaths.extensions
  });
  const lsp = new LspService(repos, extensions);
  const ai = new AiService(db, keychain, () => settings.get(), repos, new ChangeMapService(lsp));
  const perf = new PerfService(db);
  const prCache = new PrCacheService(db);
  const updates = new UpdateService(() => settings.get(), app.getVersion(), autoUpdater);
  const maintenance = new MaintenanceService(db);
  const diagnostics = new DiagnosticsService(appPaths, app.getVersion(), settings, maintenance, repos, perf, operations, updates);
  app.once("before-quit", () => lsp.dispose());
  if (settings.get().updates.enabled) {
    void updates.checkForUpdates().catch(() => {
      // Startup should continue even if the updater cannot reach the release service.
    });
  }

  registerIpcHandlers({
    providers,
    settings,
    repos,
    ai,
    extensions,
    perf,
    operations,
    keychain,
    lsp,
    prCache,
    providerCache,
    updates,
    maintenance,
    diagnostics
  });

  const workArea = screen.getPrimaryDisplay().workArea;
  mainWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    minWidth: 1120,
    minHeight: 720,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 9 },
    backgroundColor: "#fbfaf8",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  operations.attachWindow(mainWindow);
  repos.attachWindow(mainWindow);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedAppNavigation(url, isDev ? process.env.VITE_DEV_SERVER_URL : undefined)) {
      event.preventDefault();
      void openExternalUrl(url);
    }
  });
  mainWindow.on("closed", () => {
    lsp.dispose();
    mainWindow = null;
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../../dist/renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  installApplicationMenu();
  await createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
