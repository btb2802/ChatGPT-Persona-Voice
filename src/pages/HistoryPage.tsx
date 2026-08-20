import { useMemo } from "react";
import { Icon } from "../icons";
import { formatMessage, useI18n } from "../i18n";
import type { HistoryEntry, LauncherSnapshot } from "../types";
import {
  dayKey,
  dayLabel,
  formatBytes,
  formatDuration,
  retentionLabel,
  type SettingsSectionId,
} from "../lib/presentation";

function HistoryRow({
  entry,
  playing,
  onPlay,
}: {
  entry: HistoryEntry;
  playing: boolean;
  onPlay: (entry: HistoryEntry) => void;
}) {
  const { locale, messages } = useI18n();
  const created = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(entry.createdAt));
  return (
    <article className={`history-row${playing ? " is-playing" : ""}`}>
      <button
        aria-label={playing ? messages.history.pauseAudio : messages.history.playAudio}
        className="history-play"
        onClick={() => onPlay(entry)}
        type="button"
      >
        <Icon name={playing ? "pause" : "play"} />
      </button>
      <div className="history-main">
        <strong>{entry.voiceName}</strong>
        <span>
          {entry.sourceName} · {created}
        </span>
      </div>
      <div aria-hidden="true" className="history-wave">
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="history-meta">
        <strong>{formatDuration(entry.durationMs)}</strong>
        <span>{formatBytes(entry.bytes, locale)}</span>
      </div>
    </article>
  );
}

export function HistoryPage({
  snapshot,
  playingKey,
  onPlay,
  onRequestClear,
  onOpenSettings,
}: {
  snapshot: LauncherSnapshot;
  playingKey: string | null;
  onPlay: (entry: HistoryEntry) => void;
  onRequestClear: () => void;
  onOpenSettings: (section: SettingsSectionId) => void;
}) {
  const { locale, messages } = useI18n();
  const groups = useMemo(() => {
    const values = new Map<string, HistoryEntry[]>();
    for (const entry of snapshot.history) {
      const key = dayKey(entry.createdAt);
      values.set(key, [...(values.get(key) || []), entry]);
    }
    return [...values.values()];
  }, [snapshot.history]);
  const totalBytes = snapshot.history.reduce(
    (sum, entry) => sum + entry.bytes,
    0,
  );
  return (
    <section className="content-surface">
      <div className="page-scroll history-page">
        <div className="page-header with-action">
          <div>
            <h1>{messages.history.title}</h1>
            <p>{messages.history.intro}</p>
          </div>
          {snapshot.history.length > 0 ? (
            <button
              className="button-secondary danger-text"
              onClick={onRequestClear}
              type="button"
            >
              <Icon name="trash" />
              {messages.history.clear}
            </button>
          ) : null}
        </div>
        <button
          className="privacy-banner"
          onClick={() => onOpenSettings("history")}
          type="button"
        >
          <span>
            <Icon name="lock" />
          </span>
          <span>
            <strong>
              {snapshot.settings.saveConvertedAudio
                ? formatMessage(messages.history.deleteAfter, {
                    retention: retentionLabel(
                      snapshot.settings.retentionHours,
                      messages,
                      locale,
                    ),
                  })
                : messages.history.recordingOff}
            </strong>
            <small>
              {formatMessage(
                snapshot.history.length === 1
                  ? messages.history.storedOne
                  : messages.history.storedOther,
                {
                  count: new Intl.NumberFormat(locale).format(snapshot.history.length),
                  size: formatBytes(totalBytes, locale),
                },
              )}
            </small>
          </span>
          <Icon name="chevron" />
        </button>
        {snapshot.history.length === 0 ? (
          <div className="empty-state">
            <span>
              <Icon name="history" />
            </span>
            <h2>{messages.history.emptyTitle}</h2>
            <p>
              {snapshot.settings.saveConvertedAudio
                ? formatMessage(messages.history.emptyEnabled, {
                    retention: retentionLabel(
                      snapshot.settings.retentionHours,
                      messages,
                      locale,
                    ),
                  })
                : messages.history.emptyDisabled}
            </p>
          </div>
        ) : (
          <div className="history-groups">
            {groups.map((entries) => (
              <section
                className="history-group"
                key={dayKey(entries[0].createdAt)}
              >
                <h2>{dayLabel(entries[0].createdAt, locale, messages)}</h2>
                <div className="row-group">
                  {entries.map((entry) => (
                    <HistoryRow
                      entry={entry}
                      key={entry.id}
                      onPlay={onPlay}
                      playing={playingKey === `history:${entry.id}`}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
