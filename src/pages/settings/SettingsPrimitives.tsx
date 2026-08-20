import type { ReactNode } from "react";
import { Icon, VoiceMark } from "../../icons";
import type { IconName } from "../../icons";
import { useI18n } from "../../i18n";
import type { Capability, VoicePreset } from "../../types";

export function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

export function SourceChoice({
  active,
  disabled,
  icon,
  title,
  description,
  badge,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  icon: "server" | "app";
  title: string;
  description: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`source-choice${active ? " is-active" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="source-choice-icon">
        <Icon name={icon} />
      </span>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      {badge ? (
        <em>{badge}</em>
      ) : (
        <span className="radio-dot">
          <i />
        </span>
      )}
    </button>
  );
}

export function CapabilityRow({
  icon,
  title,
  capability,
}: {
  icon: IconName;
  title: string;
  capability: Capability;
}) {
  const { messages } = useI18n();
  const state = capability.ready
    ? "ready"
    : capability.possible
      ? "possible"
      : "blocked";
  return (
    <div className="capability-row">
      <span className={`capability-icon is-${state}`}>
        <Icon name={capability.ready ? "check" : icon} />
      </span>
      <span>
        <strong>{title}</strong>
        <small>{capability.detail}</small>
        <code>{capability.code}</code>
      </span>
      <em>
        {capability.ready
          ? messages.common.ready
          : capability.possible
            ? messages.common.backendNeeded
            : messages.common.unavailable}
      </em>
    </div>
  );
}

export function VoiceChoice({
  voice,
  selected,
  playing,
  disabled,
  index,
  onSelect,
  onPreview,
  onTerms,
}: {
  voice: VoicePreset;
  selected: boolean;
  playing: boolean;
  disabled: boolean;
  index: number;
  onSelect: () => void;
  onPreview: () => void;
  onTerms: () => void;
}) {
  const { messages } = useI18n();
  return (
    <div
      className={`voice-choice voice-tone-${index + 1}${selected ? " is-active" : ""}`}
    >
      <button
        aria-pressed={selected}
        className="voice-select"
        disabled={disabled}
        onClick={onSelect}
        type="button"
      >
        <span className="voice-avatar">
          <VoiceMark />
        </span>
        <span className="voice-copy">
          <strong>{voice.name}</strong>
          <small>{voice.nativeName}</small>
          <p>{voice.description}</p>
        </span>
        <span aria-hidden="true" className="radio-dot">
          {selected ? <Icon name="check" /> : null}
        </span>
      </button>
      <div className="voice-actions">
        <button
          aria-label={`${playing ? messages.settings.voice.pause : messages.settings.voice.preview} ${voice.name}`}
          className="voice-preview"
          onClick={onPreview}
          type="button"
        >
          <Icon name={playing ? "pause" : "play"} />
          {playing ? messages.settings.voice.playing : messages.settings.voice.preview}
        </button>
        <button className="voice-terms" onClick={onTerms} type="button">
          {messages.settings.voice.terms}
        </button>
      </div>
    </div>
  );
}
