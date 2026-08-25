import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";

import type {
  DesktopDiscoverModelsRequest,
  DesktopModelProbe,
  DesktopModelOption,
  DesktopModelSummary,
  DesktopOnboardingProvider,
  DesktopOnboardingState,
  DesktopResult,
  DesktopTestModelRequest,
  DesktopTestModelResult,
} from "../../../contracts.js";
import { redactTechnicalDetails, TechnicalDetails } from "./TechnicalDetails.js";

interface ConnectionFeedback {
  status: DesktopModelProbe["status"];
  message: string;
  technicalDetails?: string;
}

interface ProviderSetupProps {
  providers: readonly DesktopOnboardingProvider[];
  activeModel?: DesktopModelSummary;
  latestProbe?: DesktopModelProbe;
  busy: boolean;
  onDiscoverModels(request: DesktopDiscoverModelsRequest): Promise<DesktopResult<readonly DesktopModelOption[]>>;
  onTestModel(request: DesktopTestModelRequest): Promise<DesktopResult<DesktopTestModelResult>>;
  onForgetCredential(providerId: string): Promise<DesktopResult<DesktopOnboardingState>>;
  onDraftValidityChange?(matchesActive: boolean): void;
}

const SAVED_CREDENTIAL_MASK = "••••••••••••";

function firstModel(provider: DesktopOnboardingProvider | undefined): string {
  return provider?.fallbackModelIds[0] ?? "";
}

function initialProviderId(
  directProviders: readonly DesktopOnboardingProvider[],
  additionalProviders: readonly DesktopOnboardingProvider[],
  activeModel: DesktopModelSummary | undefined,
): string {
  const providers = [...directProviders, ...additionalProviders];
  if (activeModel !== undefined && providers.some((provider) => provider.id === activeModel.providerId)) {
    return activeModel.providerId;
  }
  return directProviders[0]?.id ?? additionalProviders[0]?.id ?? "";
}

function probeFeedback(report: DesktopModelProbe): ConnectionFeedback {
  if (report.status === "ready") {
    return { status: "ready", message: "连接成功，API Key 已安全保存。" };
  }
  if (report.status === "limited") {
    return {
      status: "limited",
      message: report.message?.trim() || "已经连接到模型，但它没有通过完整能力检查。",
    };
  }
  return {
    status: "failed",
    message: report.message?.trim() || "连接测试失败，请检查 API Key、模型和网络后重试。",
  };
}

function shouldShowPersistedProbe(
  probe: DesktopModelProbe | undefined,
  activeModel: DesktopModelSummary | undefined,
): probe is DesktopModelProbe {
  if (probe === undefined || activeModel === undefined) {
    return probe !== undefined;
  }
  if (probe.providerId !== undefined || probe.modelId !== undefined) {
    return probe.providerId === activeModel.providerId && probe.modelId === activeModel.modelId;
  }
  return probe.status === "ready";
}

export function ProviderSetup({
  providers,
  activeModel,
  latestProbe,
  busy,
  onDiscoverModels,
  onTestModel,
  onForgetCredential,
  onDraftValidityChange,
}: ProviderSetupProps): JSX.Element {
  const directProviders = useMemo(
    () => providers.filter((provider) => !provider.allowCustomBaseUrl),
    [providers],
  );
  const additionalProviders = useMemo(
    () => providers.filter((provider) => provider.allowCustomBaseUrl),
    [providers],
  );
  const [showMoreServices, setShowMoreServices] = useState(
    () => activeModel !== undefined && additionalProviders.some((provider) => provider.id === activeModel.providerId),
  );
  const [providerId, setProviderId] = useState(
    () => initialProviderId(directProviders, additionalProviders, activeModel),
  );
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [discoveredModels, setDiscoveredModels] = useState<readonly DesktopModelOption[]>([]);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionFeedback, setConnectionFeedback] = useState<ConnectionFeedback | undefined>(
    () => shouldShowPersistedProbe(latestProbe, activeModel) ? probeFeedback(latestProbe) : undefined,
  );
  const synchronizedActiveModel = useRef<string | undefined>(undefined);
  const synchronizedProviderId = useRef(providerId);

  const selectedProvider = providers.find((provider) => provider.id === providerId) ?? directProviders[0] ?? additionalProviders[0];

  useLayoutEffect(() => {
    if (activeModel === undefined
      || !providers.some((provider) => provider.id === activeModel.providerId)) {
      return;
    }
    const signature = [
      activeModel.providerId,
      activeModel.modelId,
      activeModel.reasoningEffort ?? "",
      activeModel.customBaseUrl ?? "",
      activeModel.capability,
    ].join("\0");
    if (synchronizedActiveModel.current === signature) return;
    synchronizedActiveModel.current = signature;
    setProviderId(activeModel.providerId);
    setModelId(activeModel.modelId);
    setReasoningEffort(activeModel.reasoningEffort ?? "");
    setCustomBaseUrl(activeModel.customBaseUrl ?? "");
    setDiscoveredModels([]);
  }, [activeModel, providers]);

  useLayoutEffect(() => {
    if (selectedProvider === undefined) return;
    const providerChanged = synchronizedProviderId.current !== selectedProvider.id;
    synchronizedProviderId.current = selectedProvider.id;
    const savedModel = activeModel?.providerId === selectedProvider.id ? activeModel : undefined;
    setModelId(savedModel?.modelId ?? firstModel(selectedProvider));
    setReasoningEffort(savedModel?.reasoningEffort ?? selectedProvider.efforts[0] ?? "");
    setDiscoveredModels([]);
    setApiKey("");
    if (providerChanged) setConnectionFeedback(undefined);
  }, [selectedProvider?.id]);

  const listedModelOptions = discoveredModels.length > 0
    ? discoveredModels
    : (selectedProvider?.fallbackModelIds ?? []).map((id) => ({ id, displayName: id }));
  const modelOptions = modelId !== "" && !listedModelOptions.some((model) => model.id === modelId)
    ? [{ id: modelId, displayName: modelId }, ...listedModelOptions]
    : listedModelOptions;
  const formLocked = busy || testingConnection;
  const draftMatchesActive = apiKey === ""
    && activeModel?.capability === "ready"
    && selectedProvider?.id === activeModel.providerId
    && modelId === activeModel.modelId
    && reasoningEffort === (activeModel.reasoningEffort ?? "")
    && customBaseUrl.trim() === (activeModel.customBaseUrl ?? "").trim();

  useEffect(() => {
    onDraftValidityChange?.(draftMatchesActive);
  }, [draftMatchesActive, onDraftValidityChange]);

  function chooseProvider(nextProvider: DesktopOnboardingProvider): void {
    if (formLocked) return;
    if (nextProvider.allowCustomBaseUrl) setShowMoreServices(true);
    setProviderId(nextProvider.id);
  }

  async function discoverModels(): Promise<void> {
    if (selectedProvider === undefined) return;
    const result = await onDiscoverModels({
      providerId: selectedProvider.id,
      ...(apiKey === "" ? {} : { apiKey }),
      ...(selectedProvider.allowCustomBaseUrl && customBaseUrl !== "" ? { customBaseUrl } : {}),
    });
    if (result.ok) {
      setDiscoveredModels(result.value);
      if (result.value[0] !== undefined) setModelId(result.value[0].id);
    }
  }

  async function testConnection(): Promise<void> {
    if (selectedProvider === undefined || modelId === "") return;
    setTestingConnection(true);
    setConnectionFeedback(undefined);
    try {
      const request: DesktopTestModelRequest = {
        providerId: selectedProvider.id,
        ...(apiKey === "" ? {} : { apiKey }),
        modelId,
        ...(reasoningEffort === "" ? {} : { reasoningEffort }),
        ...(selectedProvider.allowCustomBaseUrl && customBaseUrl !== "" ? { customBaseUrl } : {}),
      };
      const result = await onTestModel(request);
      if (!result.ok) {
        setConnectionFeedback({
          status: "failed",
          message: result.error.message.trim().length === 0
            ? "连接测试未能完成，请检查设置后重试。"
            : redactTechnicalDetails(result.error.message.trim()),
          ...(result.error.technicalDetails === undefined
            ? {}
            : { technicalDetails: redactTechnicalDetails(result.error.technicalDetails) }),
        });
        return;
      }
      setConnectionFeedback(probeFeedback(result.value.report));
      if (result.value.report.status === "ready") {
        setApiKey("");
      }
    } catch {
      setConnectionFeedback({
        status: "failed",
        message: "连接测试未能完成，请检查设置后重试。",
      });
    } finally {
      setTestingConnection(false);
    }
  }

  async function forgetCredential(): Promise<void> {
    if (selectedProvider === undefined) return;
    const result = await onForgetCredential(selectedProvider.id);
    if (result.ok) {
      setApiKey("");
      setConnectionFeedback(undefined);
    }
  }

  const configured = selectedProvider !== undefined && selectedProvider.credentialStatus !== "missing";
  const credentialAvailable = selectedProvider?.credentialStatus === "available";
  const canTest = selectedProvider !== undefined && modelId !== "" && !formLocked;

  return (
    <section className="provider-setup" aria-label="模型设置">
      <div className="provider-section">
        <p className="field-label">常用服务</p>
        <div className="provider-grid">
          {directProviders.map((provider) => (
            <button
              className={`provider-choice${provider.id === selectedProvider?.id ? " is-selected" : ""}`}
              type="button"
              key={provider.id}
              onClick={() => chooseProvider(provider)}
              aria-pressed={provider.id === selectedProvider?.id}
              disabled={formLocked}
            >
              {provider.displayName}
            </button>
          ))}
        </div>
        {additionalProviders.length === 0 ? null : (
          <button
            className="text-button"
            type="button"
            aria-expanded={showMoreServices}
            onClick={() => setShowMoreServices((shown) => !shown)}
            disabled={formLocked}
          >
            更多服务
          </button>
        )}
        {!showMoreServices ? null : (
          <div className="provider-grid provider-grid-more">
            {additionalProviders.map((provider) => (
              <button
                className={`provider-choice${provider.id === selectedProvider?.id ? " is-selected" : ""}`}
                type="button"
                key={provider.id}
                onClick={() => chooseProvider(provider)}
                aria-pressed={provider.id === selectedProvider?.id}
                disabled={formLocked}
              >
                {provider.displayName}
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedProvider === undefined ? (
        <p className="inline-note">暂时没有可用的模型服务。</p>
      ) : (
        <div className="provider-form">
          <label className="field">
            <span>API Key</span>
            <input
              aria-label="API Key"
              autoComplete="off"
              value={apiKey}
              className={credentialAvailable ? "has-saved-credential" : undefined}
              placeholder={credentialAvailable ? SAVED_CREDENTIAL_MASK : selectedProvider.keyPlaceholder}
              onChange={(event) => {
                setApiKey(event.target.value);
                setConnectionFeedback(undefined);
              }}
              type="password"
              disabled={formLocked}
            />
          </label>

          {selectedProvider.allowCustomBaseUrl ? (
            <label className="field">
              <span>Base URL</span>
              <input
                aria-label="Base URL"
                autoComplete="off"
                value={customBaseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(event) => setCustomBaseUrl(event.target.value)}
                disabled={formLocked}
              />
            </label>
          ) : null}

          <div className="field model-field">
            <span>模型</span>
            <div className="model-row">
              <select value={modelId} onChange={(event) => setModelId(event.target.value)} aria-label="模型" disabled={formLocked}>
                {modelOptions.length === 0 ? <option value="">请选择模型</option> : null}
                {modelOptions.map((model) => <option value={model.id} key={model.id}>{model.displayName}</option>)}
              </select>
              <button className="quiet-button" type="button" onClick={() => { void discoverModels(); }} disabled={formLocked}>
                获取模型
              </button>
            </div>
          </div>

          {selectedProvider.allowManualModel ? (
            <label className="field">
              <span>或填写模型名称</span>
              <input
                value={modelId}
                placeholder="model-id"
                onChange={(event) => setModelId(event.target.value)}
                disabled={formLocked}
              />
            </label>
          ) : null}

          {selectedProvider.efforts.length === 0 ? null : (
            <div className="field">
              <span>推理强度</span>
              <div className="effort-list" role="group" aria-label="推理强度">
                {selectedProvider.efforts.map((effort) => (
                  <button
                    className={`effort-choice${reasoningEffort === effort ? " is-selected" : ""}`}
                    type="button"
                    key={effort}
                    aria-pressed={reasoningEffort === effort}
                    onClick={() => setReasoningEffort(effort)}
                    disabled={formLocked}
                  >
                    {effort}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="provider-actions">
            <button className="primary-button" type="button" onClick={() => { void testConnection(); }} disabled={!canTest}>
              {testingConnection ? "正在测试…" : "测试连接"}
            </button>
            {configured ? (
              <button className="quiet-button" type="button" onClick={() => { void forgetCredential(); }} disabled={formLocked}>
                忘记此密钥
              </button>
            ) : null}
            {activeModel?.providerId === selectedProvider.id ? <span className="model-status">当前已选择 {activeModel.modelId}</span> : null}
          </div>
          {connectionFeedback === undefined ? null : (
            <div className={`connection-feedback is-${connectionFeedback.status}`} role="status" aria-live="polite">
              <p>{connectionFeedback.message}</p>
              <TechnicalDetails details={connectionFeedback.technicalDetails} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
