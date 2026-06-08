// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverModels } from "../../../src/main/services/ai/modelCatalog.js";
import { defaultAppSettings, type AiProvider, type AppSettings } from "../../../src/shared/schemas.js";

const originalFetch = globalThis.fetch;

function settingsFor(provider: AiProvider, overrides: Partial<AppSettings["ai"]> = {}): AppSettings {
  return {
    ...defaultAppSettings,
    ai: { ...defaultAppSettings.ai, provider, ...overrides }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(response);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("discoverModels", () => {
  it("Anthropic: lists models with display names and marks tool support", async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        data: [
          { id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" },
          { id: "claude-3-5-haiku-20241022", display_name: "Claude Haiku 3.5" }
        ]
      })
    );
    const models = await discoverModels({ provider: "anthropic", settings: settingsFor("anthropic"), apiKey: "key" });
    expect(models).toEqual([
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", toolCapable: true },
      { id: "claude-3-5-haiku-20241022", label: "Claude Haiku 3.5", toolCapable: true }
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("https://api.anthropic.com/v1/models");
    expect(String(url)).toContain("limit=1000");
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "key" });
  });

  it("throws ai_models_no_key when a key-backed provider has no key", async () => {
    mockFetch(jsonResponse({}));
    await expect(
      discoverModels({ provider: "anthropic", settings: settingsFor("anthropic"), apiKey: null })
    ).rejects.toMatchObject({ code: "ai_models_no_key" });
  });

  it("OpenAI: drops non-chat families and flags non-tool models", async () => {
    mockFetch(
      jsonResponse({
        data: [
          { id: "gpt-5-mini" },
          { id: "gpt-4.1" },
          { id: "gpt-3.5-turbo-instruct" },
          { id: "text-embedding-3-large" },
          { id: "whisper-1" },
          { id: "dall-e-3" }
        ]
      })
    );
    const models = await discoverModels({ provider: "openai", settings: settingsFor("openai"), apiKey: "key" });
    const ids = models.map((model) => model.id);
    expect(ids).toEqual(expect.arrayContaining(["gpt-5-mini", "gpt-4.1", "gpt-3.5-turbo-instruct"]));
    expect(ids).not.toContain("text-embedding-3-large");
    expect(ids).not.toContain("whisper-1");
    expect(ids).not.toContain("dall-e-3");
    expect(models.find((model) => model.id === "gpt-3.5-turbo-instruct")?.toolCapable).toBe(false);
    expect(models.find((model) => model.id === "gpt-5-mini")?.toolCapable).toBe(true);
  });

  it("Google: keeps only generateContent models and strips the models/ prefix", async () => {
    mockFetch(
      jsonResponse({
        models: [
          { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding-001", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemma-3", displayName: "Gemma 3", supportedGenerationMethods: ["generateContent"] }
        ]
      })
    );
    const models = await discoverModels({ provider: "google", settings: settingsFor("google"), apiKey: "key" });
    expect(models.map((model) => model.id)).toEqual(["gemini-2.5-flash", "gemma-3"]);
    expect(models.find((model) => model.id === "gemma-3")?.toolCapable).toBe(false);
  });

  it("Ollama: lists local tags without a key", async () => {
    const fetchMock = mockFetch(jsonResponse({ models: [{ name: "llama3.1:latest" }, { name: "gemma:7b" }] }));
    const models = await discoverModels({ provider: "ollama", settings: settingsFor("ollama"), apiKey: null });
    expect(models.map((model) => model.id)).toEqual(["llama3.1:latest", "gemma:7b"]);
    expect(models.find((model) => model.id === "gemma:7b")?.toolCapable).toBe(false);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/tags");
  });

  it("Bedrock: signs the control-plane request and filters to on-demand text models", async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        modelSummaries: [
          {
            modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
            modelName: "Claude 3.5 Sonnet",
            providerName: "Anthropic",
            outputModalities: ["TEXT"],
            inferenceTypesSupported: ["ON_DEMAND"],
            modelLifecycle: { status: "ACTIVE" }
          },
          { modelId: "amazon.titan-image", modelName: "Titan Image", outputModalities: ["IMAGE"], inferenceTypesSupported: ["ON_DEMAND"] },
          { modelId: "legacy.model", modelName: "Legacy", outputModalities: ["TEXT"], inferenceTypesSupported: ["PROVISIONED"] }
        ]
      })
    );
    const creds = JSON.stringify({ accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "secret", region: "us-west-2" });
    const models = await discoverModels({ provider: "bedrock", settings: settingsFor("bedrock"), apiKey: creds });
    expect(models).toEqual([
      { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", label: "Anthropic Claude 3.5 Sonnet", toolCapable: true }
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("https://bedrock.us-west-2.amazonaws.com/foundation-models");
    expect(String(url)).toContain("byOutputModality=TEXT");
    expect((init as RequestInit).headers).toMatchObject({
      authorization: expect.stringContaining("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/")
    });
  });

  it("Azure: requires a base url", async () => {
    mockFetch(jsonResponse({}));
    await expect(
      discoverModels({ provider: "azure-openai", settings: settingsFor("azure-openai"), apiKey: "key" })
    ).rejects.toMatchObject({ code: "ai_models_no_base_url" });
  });

  it("Azure: falls back to no discovery when the deployments listing is unavailable", async () => {
    mockFetch(jsonResponse("not found", 404));
    const models = await discoverModels({
      provider: "azure-openai",
      settings: settingsFor("azure-openai", { baseUrl: "https://res.openai.azure.com" }),
      apiKey: "key"
    });
    expect(models).toEqual([]);
  });

  it("maps auth failures and server errors to typed errors", async () => {
    mockFetch(jsonResponse("nope", 401));
    await expect(
      discoverModels({ provider: "openai", settings: settingsFor("openai"), apiKey: "bad" })
    ).rejects.toMatchObject({ code: "ai_models_no_key" });

    mockFetch(jsonResponse("boom", 500));
    await expect(
      discoverModels({ provider: "openai", settings: settingsFor("openai"), apiKey: "key" })
    ).rejects.toMatchObject({ code: "ai_models_failed", retryable: true });
  });

  it("returns nothing for the disabled provider without hitting the network", async () => {
    const fetchMock = mockFetch(jsonResponse({}));
    const models = await discoverModels({ provider: "disabled", settings: settingsFor("disabled"), apiKey: null });
    expect(models).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
