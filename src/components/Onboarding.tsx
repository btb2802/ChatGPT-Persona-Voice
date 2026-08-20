import { useEffect, useState } from "react";
import { Icon, VoiceMark } from "../icons";
import {
  formatMessage,
  localeOptions,
  messagesFor,
} from "../i18n";
import type { UiLocale } from "../i18n";
import type {
  LauncherSnapshot,
  OnboardingState,
  Settings,
  VoiceBridge,
} from "../types";
import { errorMessage, formatBytes } from "../lib/presentation";

type OnboardingStep = "language" | "support" | "engine";

export function Onboarding({
  bridge,
  onChange,
  onLocaleChange,
  snapshot,
}: {
  bridge: VoiceBridge;
  onChange: (state: OnboardingState) => void;
  onLocaleChange: (settings: Settings) => void;
  snapshot: LauncherSnapshot;
}) {
  const [step, setStep] = useState<OnboardingStep>(() =>
    snapshot.settings.uiLocale === null ? "language" : "support",
  );
  const [busy, setBusy] = useState<
    "locale" | "github" | "x" | "install" | "cancel" | "complete" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const { onboarding } = snapshot;
  const locale = snapshot.settings.uiLocale;
  const messages = locale === null ? null : messagesFor(locale);

  useEffect(() => {
    document.documentElement.lang = locale ?? "en";
  }, [locale]);

  async function chooseLocale(nextLocale: UiLocale) {
    setBusy("locale");
    setError(null);
    try {
      onLocaleChange(await bridge.setSetting("uiLocale", nextLocale));
      setStep("support");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function openSocial(target: "github" | "x") {
    setBusy(target);
    setError(null);
    try {
      onChange(await bridge.openSocial(target));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function complete() {
    setBusy("complete");
    setError(null);
    try {
      onChange(await bridge.completeOnboarding());
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(null);
    }
  }

  async function installEngine() {
    setBusy("install");
    setError(null);
    try {
      await bridge.installEngine();
    } catch (cause) {
      const message = errorMessage(cause);
      if (!/engine installation was cancelled/i.test(message)) setError(message);
    } finally {
      setBusy(null);
    }
  }

  async function cancelEngineInstall() {
    setBusy("cancel");
    setError(null);
    try {
      await bridge.cancelEngineInstall();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const engine = snapshot.engineInstallation;
  const canInstall = engine.status === "idle" || engine.status === "error";
  const stepLabel = step === "language"
    ? "Step 0"
    : step === "support"
      ? messages!.onboarding.supportStep
      : messages!.onboarding.engineStep;

  return (
    <main className="onboarding-screen" data-platform={snapshot.app.platform}>
      <header className="onboarding-titlebar draggable">
        <div className="onboarding-brand no-drag">
          <span><VoiceMark /></span>
          <strong>Persona Voice</strong>
        </div>
        <small className="no-drag">
          {stepLabel} · v{snapshot.app.version}
        </small>
      </header>

      <section className="onboarding-content">
        {step === "language" ? (
          <>
            <span className="onboarding-kicker">LANGUAGE</span>
            <h1>Choose your language</h1>
            <p>You can change this later in Settings.</p>
            <div
              aria-label="Language"
              className="onboarding-actions language-options"
              role="group"
            >
              {localeOptions.map((option) => (
                <button
                  className="onboarding-action language-option"
                  disabled={busy !== null}
                  key={option.value}
                  lang={option.value}
                  onClick={() => void chooseLocale(option.value)}
                  type="button"
                >
                  <span className="language-option-code" aria-hidden="true">
                    {option.value === "zh-CN" ? "中文" : option.value.toUpperCase()}
                  </span>
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.note}</small>
                  </span>
                  <Icon name="chevron" />
                </button>
              ))}
            </div>
          </>
        ) : step === "support" ? (
          <>
            <span className="onboarding-kicker">{messages!.onboarding.supportKicker}</span>
            <h1>{messages!.onboarding.supportTitle}</h1>
            <p>{messages!.onboarding.supportBody}</p>

            <div className="onboarding-actions">
              <SocialAction
                complete={onboarding.githubOpened}
                disabled={busy !== null}
                icon="github"
                label={onboarding.githubOpened
                  ? messages!.onboarding.githubOpened
                  : messages!.onboarding.starGithub}
                note="github.com/miuuyy/ChatGPT-Persona-Voice"
                onClick={() => void openSocial("github")}
              />
              <SocialAction
                complete={onboarding.xOpened}
                disabled={busy !== null}
                icon="x"
                label={onboarding.xOpened
                  ? messages!.onboarding.xOpened
                  : messages!.onboarding.followX}
                note="@miu21590"
                onClick={() => void openSocial("x")}
              />
            </div>

            <small className="onboarding-honesty">
              {messages!.onboarding.socialPrivacy}
            </small>
          </>
        ) : (
          <>
            <span className="onboarding-kicker">{messages!.onboarding.engineKicker}</span>
            <h1>{messages!.onboarding.engineTitle}</h1>
            <p>{messages!.onboarding.engineBody}</p>

            <div className={`onboarding-engine is-${engine.status}`}>
              <span className="onboarding-engine-mark"><Icon name="sparkles" /></span>
              <div className="onboarding-engine-copy">
                <strong>Seed-VC tiny · Apple MPS</strong>
                <p>{engine.detail}</p>
                <small>
                  {engine.status === "ready"
                    ? formatMessage(messages!.onboarding.installedLocally, {
                        size: formatBytes(engine.installedBytes, locale!),
                      })
                    : formatMessage(messages!.onboarding.installSize, {
                        installed: formatBytes(engine.estimatedInstalledBytes, locale!),
                        free: formatBytes(engine.minimumFreeBytes, locale!),
                      })}
                </small>
              </div>
              {engine.status === "ready" ? <Icon name="check" /> : null}
              {engine.status === "installing" ? (
                <div
                  aria-label={formatMessage(messages!.onboarding.installProgress, {
                    percent: Math.round(engine.progress * 100),
                  })}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={Math.round(engine.progress * 100)}
                  className="engine-progress onboarding-engine-progress"
                  role="progressbar"
                >
                  <span style={{ width: `${engine.progress * 100}%` }} />
                </div>
              ) : null}
            </div>

            <div className="onboarding-engine-facts">
              <span><Icon name="lock" /> {messages!.onboarding.offlineAfterSetup}</span>
              <span><Icon name="shield" /> {messages!.onboarding.verifiedBeforeUse}</span>
            </div>
            <small className="onboarding-honesty">
              {messages!.onboarding.engineTerms}
            </small>
          </>
        )}
        {error ? <p className="onboarding-error" role="alert">{error}</p> : null}
      </section>

      {step !== "language" ? (
        <footer className="onboarding-footer">
          {step === "support" ? (
            <>
              <span>{messages!.onboarding.supportOptional}</span>
              <button
                className="button-primary"
                disabled={busy !== null}
                onClick={() => setStep("engine")}
                type="button"
              >
                {messages!.common.continue}
              </button>
            </>
          ) : (
            <>
              <span>
                {engine.status === "ready"
                  ? messages!.onboarding.engineReady
                  : engine.status === "installing"
                    ? engine.detail
                    : messages!.onboarding.setupLaterHint}
              </span>
              <div className="onboarding-footer-actions">
                {engine.status !== "ready" && engine.status !== "installing" ? (
                  <button
                    className="button-secondary"
                    disabled={busy !== null}
                    onClick={() => void complete()}
                    type="button"
                  >
                    {messages!.onboarding.setUpLater}
                  </button>
                ) : null}
                {engine.status === "installing" ? (
                  <button
                    className="button-secondary"
                    disabled={!engine.cancellable || busy === "cancel"}
                    onClick={() => void cancelEngineInstall()}
                    type="button"
                  >
                    {busy === "cancel"
                      ? messages!.common.cancelling
                      : messages!.common.cancel}
                  </button>
                ) : engine.status === "ready" ? (
                  <button
                    className="button-primary"
                    disabled={busy !== null}
                    onClick={() => void complete()}
                    type="button"
                  >
                    {busy === "complete"
                      ? messages!.onboarding.opening
                      : messages!.onboarding.openProduct}
                  </button>
                ) : engine.status === "unavailable" ? null : (
                  <button
                    className="button-primary"
                    disabled={!canInstall || busy !== null}
                    onClick={() => void installEngine()}
                    type="button"
                  >
                    {busy === "install"
                      ? messages!.onboarding.starting
                      : engine.status === "error"
                        ? engine.resumable
                          ? messages!.onboarding.resumeDownload
                          : messages!.onboarding.retrySetup
                        : engine.resumable
                          ? messages!.onboarding.resumeDownload
                          : messages!.onboarding.installEngine}
                  </button>
                )}
              </div>
            </>
          )}
        </footer>
      ) : null}
    </main>
  );
}

function SocialAction({
  complete,
  disabled,
  icon,
  label,
  note,
  onClick,
}: {
  complete: boolean;
  disabled: boolean;
  icon: "github" | "x";
  label: string;
  note: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={complete}
      className={`onboarding-action${complete ? " is-complete" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="onboarding-action-icon"><Icon name={icon} /></span>
      <span>
        <strong>{label}</strong>
        <small>{note}</small>
      </span>
      <Icon name={complete ? "check" : "external"} />
    </button>
  );
}
