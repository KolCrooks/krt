import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Cog,
  Download,
  FileCode2,
  Github,
  Info,
  KeyRound,
  Keyboard,
  Palette,
  Plug,
  RefreshCw,
  Terminal,
  X,
} from "lucide-react";
import { useId, useState } from "react";
import { krtClient } from "../api/client.js";
import { ModalBackdrop } from "./ExtensionsView.js";
import type { IpcInput } from "../../shared/ipc.js";
import type {
  AiProvider,
  AiKeyProvider,
  AppSettings,
  GitHubKeyProvider,
} from "../../shared/schemas.js";

type SettingsUpdateInput = IpcInput<"settings:update">;

interface SettingsSection {
  id:
    | "general"
    | "appearance"
    | "editor"
    | "ai"
    | "integrations"
    | "keybindings"
    | "updates"
    | "about";
  label: string;
  Icon: React.ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
}

const SECTIONS: SettingsSection[] = [
  { id: "general", label: "General", Icon: Cog },
  { id: "appearance", label: "Appearance", Icon: Palette },
  { id: "editor", label: "Editor", Icon: FileCode2 },
  { id: "ai", label: "AI Review", Icon: Bot },
  { id: "integrations", label: "Integrations", Icon: Plug },
  { id: "keybindings", label: "Keybindings", Icon: Keyboard },
  { id: "updates", label: "Updates", Icon: RefreshCw },
  { id: "about", label: "About", Icon: Info },
];

interface ModelSuggestion {
  value: string;
  label: string;
}

const MODEL_SUGGESTIONS: Record<AiProvider, ModelSuggestion[]> = {
  disabled: [],
  anthropic: [
    { value: "claude-sonnet-4-5", label: "Default, tool-capable" },
    { value: "claude-3-7-sonnet-latest", label: "Tool-capable, thinking-capable" },
    { value: "claude-3-5-sonnet-20241022", label: "Tool-capable" }
  ],
  openai: [
    { value: "gpt-5-mini", label: "Default, tool-capable" },
    { value: "gpt-5", label: "Tool-capable" },
    { value: "gpt-4.1", label: "Tool-capable" },
    { value: "gpt-4.1-mini", label: "Tool-capable" }
  ],
  google: [
    { value: "gemini-2.5-flash", label: "Default, tool-capable" },
    { value: "gemini-2.5-pro", label: "Tool-capable" }
  ],
  "azure-openai": [
    { value: "gpt-5-mini", label: "Use your Azure deployment name" },
    { value: "gpt-5", label: "Use your Azure deployment name" },
    { value: "gpt-4.1", label: "Use your Azure deployment name" }
  ],
  bedrock: [
    { value: "anthropic.claude-3-5-sonnet-20241022-v2:0", label: "Default, tool-capable" },
    { value: "anthropic.claude-3-7-sonnet-20250219-v1:0", label: "Tool-capable" }
  ],
  ollama: [
    { value: "llama3.1", label: "Requires tool support in local runtime" },
    { value: "qwen2.5-coder", label: "Requires tool support in local runtime" },
    { value: "mistral-nemo", label: "Requires tool support in local runtime" }
  ]
};

interface SettingsViewProps {
  onClose: () => void;
}

export function SettingsView({
  onClose,
}: SettingsViewProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [section, setSection] = useState<SettingsSection["id"]>("general");
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => krtClient.settings.get(),
  });
  const authQuery = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => krtClient.auth.getStatus(),
  });
  const updatesQuery = useQuery({
    queryKey: ["updates-status"],
    queryFn: () => krtClient.updates.getStatus(),
  });

  const updateMutation = useMutation({
    mutationFn: krtClient.settings.update,
    onSuccess: (settings) => {
      queryClient.setQueryData(["settings"], settings);
      void queryClient.invalidateQueries({ queryKey: ["auth-status"] });
      void queryClient.invalidateQueries({ queryKey: ["updates-status"] });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const updateSettings = (input: SettingsUpdateInput): void => {
    queryClient.setQueryData<AppSettings>(["settings"], (current) =>
      current ? mergeSettings(current, input) : current,
    );
    updateMutation.mutate(input);
  };

  const settings = settingsQuery.data;
  const authStatus = authQuery.data;
  const updateStatus = updatesQuery.data;
  const active = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0];

  return (
    <ModalBackdrop onClose={onClose} label="Settings">
      <section className="modal-pane settings-view" aria-label="Settings">
        <h1 className="modal-pane-srhead">Settings</h1>
        <nav className="modal-rail" aria-label="Settings sections">
          <div className="modal-rail-title">Settings</div>
          {SECTIONS.map(({ id, label, Icon }) => {
            const isActive = section === id;
            return (
              <button
                type="button"
                key={id}
                className={
                  isActive ? "modal-rail-item is-active" : "modal-rail-item"
                }
                onClick={() => setSection(id)}
              >
                <Icon size={14} aria-hidden />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
        <section
          className="modal-detail modal-detail-wide"
          aria-label={active.label}
        >
          <div className="modal-detail-header">
            <span className="modal-detail-title">{active.label}</span>
            <button
              type="button"
              className="modal-close"
              aria-label="Close"
              title="Close"
              onClick={onClose}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
          <div className="modal-detail-body">
            {!settings ? <SettingsSkeleton /> : null}
            {settings && section === "general" ? (
              <GeneralSection
                settings={settings}
                updateSettings={updateSettings}
              />
            ) : null}
            {settings && section === "appearance" ? (
              <AppearanceSection
                settings={settings}
                updateSettings={updateSettings}
              />
            ) : null}
            {settings && section === "editor" ? <EditorSection /> : null}
            {settings && section === "ai" ? (
              <AiSection
                settings={settings}
                authConfigured={Boolean(authStatus?.ai.configured)}
                updateSettings={updateSettings}
              />
            ) : null}
            {settings && section === "integrations" ? (
              <IntegrationsSection
                settings={settings}
                authStatus={authStatus}
                updateSettings={updateSettings}
              />
            ) : null}
            {section === "keybindings" ? <KeybindingsSection /> : null}
            {settings && section === "updates" ? (
              <UpdatesSection
                settings={settings}
                statusMessage={
                  updateStatus?.message ?? updateStatus?.state ?? "Not checked"
                }
                stateReady={updateStatus?.state === "downloaded"}
                updateSettings={updateSettings}
              />
            ) : null}
            {section === "about" ? (
              <AboutSection version={updateStatus?.currentVersion} />
            ) : null}
          </div>
        </section>
      </section>
    </ModalBackdrop>
  );
}

interface SettingsGroupProps {
  title: string;
  hint?: string;
  children: React.ReactNode;
}

function SettingsGroup({
  title,
  hint,
  children,
}: SettingsGroupProps): React.JSX.Element {
  return (
    <section className="settings-group">
      <div className="settings-group-title">{title}</div>
      {hint ? <div className="settings-group-hint">{hint}</div> : null}
      <div className="settings-group-body">{children}</div>
    </section>
  );
}

interface SettingsRowProps {
  label: string;
  hint?: string;
  last?: boolean;
  children: React.ReactNode;
}

function SettingsRow({
  label,
  hint,
  last,
  children,
}: SettingsRowProps): React.JSX.Element {
  return (
    <div className={last ? "settings-row is-last" : "settings-row"}>
      <div className="settings-row-main">
        <div className="settings-row-label">{label}</div>
        {hint ? <div className="settings-row-hint">{hint}</div> : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

interface ToggleProps {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

function Toggle({ on, onChange, disabled }: ToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={on ? "settings-toggle is-on" : "settings-toggle"}
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="settings-toggle-thumb" aria-hidden="true" />
    </button>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: SegmentedProps<T>): React.JSX.Element {
  return (
    <div className="settings-segmented" role="radiogroup">
      {options.map((option) => {
        const isActive = option.value === value;
        return (
          <button
            type="button"
            key={option.value}
            role="radio"
            aria-checked={isActive}
            className={
              isActive
                ? "settings-segmented-item is-active"
                : "settings-segmented-item"
            }
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

interface SettingsSectionProps {
  settings: AppSettings;
  updateSettings: (input: SettingsUpdateInput) => void;
}

function GeneralSection({
  settings,
  updateSettings,
}: SettingsSectionProps): React.JSX.Element {
  return (
    <>
      <SettingsGroup
        title="Data"
        hint="Where KRT fetches and stores pull request data."
      >
        <SettingsRow
          label="Mode"
          hint="Light uses the API only; Managed clones a worktree for full review."
        >
          <select
            className="settings-select"
            value={settings.data.preferredMode}
            onChange={(event) =>
              updateSettings({
                data: {
                  ...settings.data,
                  preferredMode: event.target
                    .value as AppSettings["data"]["preferredMode"],
                },
              })
            }
          >
            <option value="auto">Auto</option>
            <option value="light">Light · API only</option>
            <option value="managed">Managed worktree</option>
          </select>
        </SettingsRow>
        <SettingsRow
          label="Storage location"
          hint="Folder used to store managed worktrees."
        >
          <input
            className="settings-input"
            value={settings.data.managedRepoStorage ?? ""}
            placeholder="~/Library/Application Support/krt"
            onChange={(event) =>
              updateSettings({
                data: {
                  ...settings.data,
                  managedRepoStorage: event.target.value.trim() || null,
                },
              })
            }
          />
        </SettingsRow>
        <SettingsRow
          last
          label="Worktree cache size"
          hint="Maximum disk used by cached worktrees, in GB."
        >
          <input
            className="settings-input settings-input-narrow"
            type="number"
            min={1}
            value={settings.data.worktreeCacheSizeGb}
            onChange={(event) =>
              updateSettings({
                data: {
                  ...settings.data,
                  worktreeCacheSizeGb: Number(event.target.value),
                },
              })
            }
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function AppearanceSection({
  settings,
  updateSettings,
}: SettingsSectionProps): React.JSX.Element {
  return (
    <>
      <SettingsGroup title="Density">
        <SettingsRow
          last
          label="Layout density"
          hint="Compact tightens row heights, padding, and tab sizes throughout."
        >
          <Segmented
            value={settings.appearance.density}
            onChange={(value) =>
              updateSettings({
                appearance: { ...settings.appearance, density: value },
              })
            }
            options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfortable" },
            ]}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function EditorSection(): React.JSX.Element {
  return (
    <SettingsGroup title="Diff" hint="These options are coming soon.">
      <SettingsRow
        last
        label="Ignore whitespace"
        hint="Treat whitespace-only changes as unchanged."
      >
        <Toggle on={false} disabled onChange={() => undefined} />
      </SettingsRow>
    </SettingsGroup>
  );
}

interface AiSectionProps extends SettingsSectionProps {
  authConfigured: boolean;
}

function AiSection({
  settings,
  authConfigured,
  updateSettings,
}: AiSectionProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const modelListId = useId();
  const [aiKey, setAiKey] = useState("");
  const modelSuggestions = MODEL_SUGGESTIONS[settings.ai.provider];
  const aiKeyMutation = useMutation({
    mutationFn: (nextKey: string) => krtClient.auth.saveAiKey(nextKey),
    onSuccess: () => {
      setAiKey("");
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    },
  });
  const clearAiKeyMutation = useMutation({
    mutationFn: () => krtClient.auth.clearAiKey(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["auth-status"] }),
  });

  return (
    <>
      <SettingsGroup
        title="AI tour"
        hint="Tours summarize a PR into navigable chapters with diffs."
      >
        <SettingsRow
          last
          label="Enable AI tour"
          hint="Generate a tour as soon as you open a PR for review."
        >
          <Toggle
            on={settings.ai.enabled}
            onChange={(value) =>
              updateSettings({ ai: { ...settings.ai, enabled: value } })
            }
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Provider">
        <SettingsRow
          label="Provider"
          hint="The model provider used for tour generation."
        >
          <select
            className="settings-select"
            value={settings.ai.provider}
            onChange={(event) =>
              updateSettings({
                ai: {
                  ...settings.ai,
                  provider: event.target.value as AppSettings["ai"]["provider"],
                },
              })
            }
          >
            <option value="disabled">Disabled</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="google">Google</option>
            <option value="azure-openai">Azure OpenAI</option>
            <option value="bedrock">AWS Bedrock</option>
            <option value="ollama">Local · Ollama</option>
          </select>
        </SettingsRow>
        <SettingsRow
          label="Model"
          hint="The specific model used for AI review. Must support tool calling — the reviewer agent explores the checked-out code with tools. Models without tool support are not allowed."
        >
          <div className="settings-combobox">
            <input
              className="settings-input"
              value={settings.ai.model}
              list={modelListId}
              placeholder={modelSuggestions[0]?.value ?? "Model ID"}
              autoComplete="off"
              onChange={(event) =>
                updateSettings({
                  ai: { ...settings.ai, model: event.target.value },
                })
              }
            />
            <datalist id={modelListId}>
              {modelSuggestions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </datalist>
          </div>
        </SettingsRow>
        <SettingsRow
          last
          label="Base URL"
          hint="Override the default API endpoint."
        >
          <input
            className="settings-input"
            value={settings.ai.baseUrl ?? ""}
            placeholder="Optional"
            onChange={(event) =>
              updateSettings({
                ai: {
                  ...settings.ai,
                  baseUrl: event.target.value.trim() || undefined,
                },
              })
            }
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Reasoning & limits"
        hint="Token budgets for tour generation. Thinking applies to reasoning-capable models (e.g. Claude Sonnet 4)."
      >
        <SettingsRow
          label="Extended thinking"
          hint="Let the model reason before writing the tour, for richer chapters and a better dependency graph."
        >
          <Toggle
            on={settings.ai.thinkingEnabled}
            onChange={(value) =>
              updateSettings({ ai: { ...settings.ai, thinkingEnabled: value } })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Max output tokens"
          hint="Upper bound on the model response, including any thinking."
        >
          <input
            className="settings-input settings-input-narrow"
            type="number"
            min={1024}
            max={64000}
            step={512}
            value={settings.ai.maxOutputTokens}
            onChange={(event) =>
              updateSettings({
                ai: { ...settings.ai, maxOutputTokens: Number(event.target.value) },
              })
            }
          />
        </SettingsRow>
        <SettingsRow
          last
          label="Thinking budget tokens"
          hint="Tokens reserved for reasoning. Must stay below max output tokens."
        >
          <input
            className="settings-input settings-input-narrow"
            type="number"
            min={1024}
            max={60000}
            step={512}
            disabled={!settings.ai.thinkingEnabled}
            value={settings.ai.thinkingBudgetTokens}
            onChange={(event) =>
              updateSettings({
                ai: { ...settings.ai, thinkingBudgetTokens: Number(event.target.value) },
              })
            }
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Authentication"
        hint="Where to read the API key for the selected provider."
      >
        <SettingsRow label="Key source">
          <select
            className="settings-select"
            value={settings.ai.keyProvider}
            onChange={(event) =>
              updateSettings({
                ai: {
                  ...settings.ai,
                  keyProvider: event.target.value as AiKeyProvider,
                },
              })
            }
          >
            <option value="keychain">Keychain</option>
            <option value="environment">AI_API_KEY environment</option>
            <option value="command">Run command</option>
          </select>
        </SettingsRow>
        <SettingsRow label="Status">
          <span className={authConfigured ? "chip add" : "chip"}>
            <KeyRound size={11} aria-hidden="true" />
            {authConfigured ? "Configured" : "Not configured"}
          </span>
        </SettingsRow>
        {settings.ai.keyProvider === "keychain" ? (
          <SettingsRow
            last
            label="API key"
            hint="Stored in your system keychain."
          >
            <div className="settings-row-stack">
              <input
                type="password"
                className="settings-input"
                value={aiKey}
                onChange={(event) => setAiKey(event.target.value)}
                placeholder="sk-…"
              />
              <div className="settings-row-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={!aiKey || aiKeyMutation.isPending}
                  onClick={() => aiKeyMutation.mutate(aiKey)}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={clearAiKeyMutation.isPending}
                  onClick={() => clearAiKeyMutation.mutate()}
                >
                  Clear
                </button>
              </div>
            </div>
          </SettingsRow>
        ) : null}
        {settings.ai.keyProvider === "environment" ? (
          <SettingsRow last label="Source">
            <span className="settings-status-text">
              <Terminal size={12} aria-hidden="true" /> Reads{" "}
              <code className="ext-detail-code">AI_API_KEY</code> from the
              environment.
            </span>
          </SettingsRow>
        ) : null}
        {settings.ai.keyProvider === "command" ? (
          <SettingsRow
            last
            label="Command"
            hint="Output of this command is used as the API key."
          >
            <input
              className="settings-input"
              value={settings.ai.keyCommand}
              placeholder="op read op://vault/item/credential"
              onChange={(event) =>
                updateSettings({
                  ai: { ...settings.ai, keyCommand: event.target.value },
                })
              }
            />
          </SettingsRow>
        ) : null}
      </SettingsGroup>
    </>
  );
}

interface IntegrationsSectionProps extends SettingsSectionProps {
  authStatus:
    | { github: { login: string } | null; ai: { configured: boolean } }
    | undefined;
}

function IntegrationsSection({
  settings,
  authStatus,
  updateSettings,
}: IntegrationsSectionProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const githubLogin = authStatus?.github?.login ?? settings.github.login;
  const tokenMutation = useMutation({
    mutationFn: (nextToken: string) =>
      krtClient.auth.saveGitHubToken(nextToken),
    onSuccess: () => {
      setToken("");
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    },
  });
  const clearTokenMutation = useMutation({
    mutationFn: () => krtClient.auth.clearGitHubToken(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    },
  });

  return (
    <SettingsGroup title="GitHub" hint="Source for pull requests and code.">
      <SettingsRow label="Account">
        <span className="settings-status-text">
          <Github size={12} aria-hidden="true" />
          {githubLogin ? (
            <span className="mono">{githubLogin}</span>
          ) : (
            "Not connected"
          )}
        </span>
      </SettingsRow>
      <SettingsRow label="Token source">
        <select
          className="settings-select"
          value={settings.github.tokenProvider}
          onChange={(event) =>
            updateSettings({
              github: {
                ...settings.github,
                tokenProvider: event.target.value as GitHubKeyProvider,
              },
            })
          }
        >
          <option value="keychain">Keychain</option>
          <option value="environment">GITHUB_TOKEN environment</option>
          <option value="gh-cli">gh CLI</option>
        </select>
      </SettingsRow>
      {settings.github.tokenProvider === "keychain" ? (
        <SettingsRow
          last
          label="Personal access token"
          hint="Stored in your system keychain."
        >
          <div className="settings-row-stack">
            <input
              type="password"
              className="settings-input"
              value={token}
              placeholder="ghp_…"
              onChange={(event) => setToken(event.target.value)}
            />
            <div className="settings-row-actions">
              <button
                type="button"
                className="primary-button"
                disabled={!token || tokenMutation.isPending}
                onClick={() => tokenMutation.mutate(token)}
              >
                Save
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={clearTokenMutation.isPending}
                onClick={() => clearTokenMutation.mutate()}
              >
                Disconnect
              </button>
            </div>
          </div>
        </SettingsRow>
      ) : null}
      {settings.github.tokenProvider === "environment" ? (
        <SettingsRow last label="Source">
          <span className="settings-status-text">
            <Terminal size={12} aria-hidden="true" /> Reads{" "}
            <code className="ext-detail-code">GITHUB_TOKEN</code> from the
            environment.
          </span>
        </SettingsRow>
      ) : null}
      {settings.github.tokenProvider === "gh-cli" ? (
        <SettingsRow last label="Source">
          <span className="settings-status-text">
            <Terminal size={12} aria-hidden="true" /> Reads from{" "}
            <code className="ext-detail-code">gh auth token</code>.
          </span>
        </SettingsRow>
      ) : null}
    </SettingsGroup>
  );
}

function KeybindingsSection(): React.JSX.Element {
  const groups: Array<{ title: string; rows: Array<[string, string]> }> = [
    {
      title: "Navigation",
      rows: [
        ["Open pull request search", "⌘ K"],
        ["Focus search", "/"],
      ],
    },
    {
      title: "Views",
      rows: [
        ["PR overview", "⌘ 1"],
        ["Review", "⌘ 2"],
        ["Editor", "⌘ 3"],
      ],
    },
    {
      title: "Review",
      rows: [
        ["Approve", "⌃ ⏎"],
        ["Request changes", "⌃ ⇧ ⏎"],
        ["Toggle diff layout", "⌃ ⌥ S"],
      ],
    },
  ];
  return (
    <>
      {groups.map((group) => (
        <SettingsGroup key={group.title} title={group.title}>
          {group.rows.map(([label, kbd], index) => (
            <SettingsRow
              key={label}
              label={label}
              last={index === group.rows.length - 1}
            >
              <span className="kbd">{kbd}</span>
            </SettingsRow>
          ))}
        </SettingsGroup>
      ))}
    </>
  );
}

interface UpdatesSectionProps extends SettingsSectionProps {
  statusMessage: string;
  stateReady: boolean;
}

function UpdatesSection({
  settings,
  statusMessage,
  stateReady,
  updateSettings,
}: UpdatesSectionProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const checkMutation = useMutation({
    mutationFn: () => krtClient.updates.check(),
    onSuccess: (status) => queryClient.setQueryData(["updates-status"], status),
  });
  const installMutation = useMutation({
    mutationFn: () => krtClient.updates.installDownloaded(),
    onSuccess: (status) => queryClient.setQueryData(["updates-status"], status),
  });

  return (
    <>
      <SettingsGroup title="Updates">
        <SettingsRow label="Enable updates">
          <Toggle
            on={settings.updates.enabled}
            onChange={(value) =>
              updateSettings({
                updates: { ...settings.updates, enabled: value },
              })
            }
          />
        </SettingsRow>
        <SettingsRow label="Channel">
          <select
            className="settings-select"
            value={settings.updates.channel}
            onChange={(event) =>
              updateSettings({
                updates: {
                  ...settings.updates,
                  channel: event.target.value as "stable" | "beta",
                },
              })
            }
          >
            <option value="stable">Stable</option>
            <option value="beta">Beta</option>
          </select>
        </SettingsRow>
        <SettingsRow last label="Feed URL" hint="Custom update feed.">
          <input
            className="settings-input"
            value={settings.updates.feedUrl ?? ""}
            onChange={(event) =>
              updateSettings({
                updates: {
                  ...settings.updates,
                  feedUrl: event.target.value.trim() || null,
                },
              })
            }
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Status">
        <SettingsRow label="Last status">
          <span className="settings-status-text">
            <RefreshCw size={12} aria-hidden="true" />
            {statusMessage}
          </span>
        </SettingsRow>
        <SettingsRow last label="Actions">
          <div className="settings-row-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={checkMutation.isPending}
              onClick={() => checkMutation.mutate()}
            >
              <RefreshCw size={12} aria-hidden="true" />
              Check now
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!stateReady || installMutation.isPending}
              onClick={() => installMutation.mutate()}
            >
              <Download size={12} aria-hidden="true" />
              Install
            </button>
          </div>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function AboutSection({
  version,
}: {
  version: string | undefined;
}): React.JSX.Element {
  return (
    <>
      <div className="about-card">
        <div className="about-mark" aria-hidden="true">
          k
        </div>
        <div>
          <div className="about-title">KRT</div>
          <div className="about-meta">
            Version <span className="mono">{version ?? "0.1.0"}</span> · build{" "}
            <span className="mono">local</span>
          </div>
        </div>
      </div>
      <SettingsGroup title="Build">
        <SettingsRow label="Channel">
          <span className="settings-status-text">Local</span>
        </SettingsRow>
        <SettingsRow last label="Runtime">
          <span className="settings-status-text mono">Electron · Chromium</span>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function SettingsSkeleton(): React.JSX.Element {
  return (
    <div className="settings-skeleton" aria-label="Loading settings">
      {Array.from({ length: 2 }).map((_, group) => (
        <section className="settings-skeleton-group" key={group}>
          <div className="skeleton skeleton-line skeleton-line-narrow" />
          <div className="settings-skeleton-card">
            {Array.from({ length: 3 }).map((__, row) => (
              <div className="settings-skeleton-row" key={row}>
                <div className="settings-skeleton-row-text">
                  <div className="skeleton skeleton-line skeleton-line-wide" />
                  <div className="skeleton skeleton-line skeleton-line-narrow" />
                </div>
                <div className="skeleton skeleton-chip" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function mergeSettings(
  current: AppSettings,
  input: SettingsUpdateInput,
): AppSettings {
  return {
    ...current,
    appearance: { ...current.appearance, ...input.appearance },
    data: { ...current.data, ...input.data },
    ai: { ...current.ai, ...input.ai },
    github: { ...current.github, ...input.github },
    updates: { ...current.updates, ...input.updates },
    extensions: { ...current.extensions, ...input.extensions },
    pinnedRepos: input.pinnedRepos ?? current.pinnedRepos,
  };
}
