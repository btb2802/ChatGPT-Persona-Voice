import type { SVGProps } from "react";

export type IconName =
  | "alert"
  | "app"
  | "check"
  | "chevron"
  | "external"
  | "folder"
  | "github"
  | "headphones"
  | "history"
  | "home"
  | "info"
  | "lock"
  | "microphone"
  | "panel"
  | "pause"
  | "play"
  | "power"
  | "record"
  | "refresh"
  | "search"
  | "server"
  | "settings"
  | "shield"
  | "sparkles"
  | "trash"
  | "update"
  | "x"
  | "waveform";

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  const line = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.7,
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" {...props}>
      {name === "alert" ? <><path {...line} d="M10.3 4.2 2.8 17.1A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.9L13.7 4.2a2 2 0 0 0-3.4 0Z" /><path {...line} d="M12 9v4m0 3.5h.01" /></> : null}
      {name === "app" ? <><rect {...line} x="3.5" y="3.5" width="17" height="17" rx="3" /><path {...line} d="M3.5 8.5h17M8.5 8.5v12" /></> : null}
      {name === "check" ? <path {...line} d="m5 12.5 4.2 4.2L19 7" /> : null}
      {name === "chevron" ? <path {...line} d="m9 6 6 6-6 6" /> : null}
      {name === "external" ? <><path {...line} d="M14 5h5v5M19 5l-8 8" /><path {...line} d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></> : null}
      {name === "folder" ? <path {...line} d="M3.5 6.5h6l1.8 2h9.2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11Z" /> : null}
      {name === "github" ? <path fill="currentColor" d="M12 2.6a9.6 9.6 0 0 0-3 18.7c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 3 .8.1-.7.4-1.1.7-1.4-2.3-.3-4.7-1.1-4.7-4.8 0-1.1.4-2 1-2.6-.1-.3-.4-1.3.1-2.6 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 4.9 0c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.3.1 2.6.7.7 1 1.5 1 2.6 0 3.7-2.4 4.5-4.7 4.8.4.3.7 1 .7 1.9v2.8c0 .4.2.6.7.5A9.6 9.6 0 0 0 12 2.6Z" /> : null}
      {name === "headphones" ? <><path {...line} d="M4 13v-1a8 8 0 0 1 16 0v1" /><path {...line} d="M4 13.5a2 2 0 0 1 2-2h1v7H6a2 2 0 0 1-2-2v-3Zm16 0a2 2 0 0 0-2-2h-1v7h1a2 2 0 0 0 2-2v-3Z" /></> : null}
      {name === "history" ? <><path {...line} d="M4.1 9A8.5 8.5 0 1 1 4 15" /><path {...line} d="M4 4v5h5M12 7.5V12l3 2" /></> : null}
      {name === "home" ? <><path {...line} d="m3.5 11 8.5-7 8.5 7" /><path {...line} d="M5.5 9.5V20h13V9.5M9.5 20v-6h5v6" /></> : null}
      {name === "info" ? <><circle {...line} cx="12" cy="12" r="9" /><path {...line} d="M12 10.5V17m0-10h.01" /></> : null}
      {name === "lock" ? <><rect {...line} x="5" y="10" width="14" height="10" rx="2.5" /><path {...line} d="M8 10V7a4 4 0 0 1 8 0v3" /></> : null}
      {name === "microphone" ? <><rect {...line} x="8.5" y="3" width="7" height="12" rx="3.5" /><path {...line} d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" /></> : null}
      {name === "panel" ? <><rect {...line} x="3" y="4" width="18" height="16" rx="2.5" /><path {...line} d="M8 4v16" /></> : null}
      {name === "pause" ? <><path {...line} d="M9 7v10M15 7v10" /></> : null}
      {name === "play" ? <path fill="currentColor" d="M8.2 5.5a1 1 0 0 1 1.55-.84l9.1 6.5a1 1 0 0 1 0 1.68l-9.1 6.5a1 1 0 0 1-1.55-.84v-13Z" /> : null}
      {name === "power" ? <><path {...line} d="M12 3v9" /><path {...line} d="M7 5.8a8 8 0 1 0 10 0" /></> : null}
      {name === "record" ? <><circle {...line} cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.5" fill="currentColor" /></> : null}
      {name === "refresh" ? <><path {...line} d="M19 8a8 8 0 1 0 .3 7" /><path {...line} d="M19 4v4h-4" /></> : null}
      {name === "search" ? <><circle {...line} cx="10.5" cy="10.5" r="6.5" /><path {...line} d="m15.5 15.5 4 4" /></> : null}
      {name === "server" ? <><rect {...line} x="3" y="4" width="18" height="6" rx="2" /><rect {...line} x="3" y="14" width="18" height="6" rx="2" /><path {...line} d="M7 7h.01M7 17h.01M11 7h7M11 17h7" /></> : null}
      {name === "settings" ? <><circle {...line} cx="12" cy="12" r="3" /><path {...line} d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34A1.7 1.7 0 0 0 14 20.92V21h-4v-.08A1.7 1.7 0 0 0 8.97 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.97 4.6 1.7 1.7 0 0 0 10 3.08V3h4v.08a1.7 1.7 0 0 0 1.03 1.52 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" /></> : null}
      {name === "shield" ? <><path {...line} d="M12 3 20 6v5.4c0 4.7-3.2 8-8 9.6-4.8-1.6-8-4.9-8-9.6V6l8-3Z" /><path {...line} d="m8.5 12 2.2 2.2 4.8-5" /></> : null}
      {name === "sparkles" ? <><path {...line} d="M12 3c.5 3.1 2.3 4.9 5.4 5.4-3.1.5-4.9 2.3-5.4 5.4-.5-3.1-2.3-4.9-5.4-5.4C9.7 7.9 11.5 6.1 12 3Z" /><path {...line} d="M18.5 14.5c.3 1.8 1.2 2.7 3 3-1.8.3-2.7 1.2-3 3-.3-1.8-1.2-2.7-3-3 1.8-.3 2.7-1.2 3-3ZM5 14c.2 1.2.8 1.8 2 2-1.2.2-1.8.8-2 2-.2-1.2-.8-1.8-2-2 1.2-.2 1.8-.8 2-2Z" /></> : null}
      {name === "trash" ? <><path {...line} d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 10v6M14 10v6" /></> : null}
      {name === "update" ? <><path {...line} d="M12 3v12M7.5 10.5 12 15l4.5-4.5" /><path {...line} d="M5 19h14" /></> : null}
      {name === "x" ? <path fill="currentColor" d="M5 4h3.9l3.8 5.1L17.1 4H19l-5.4 6.4L19.5 20h-3.9l-4.1-5.6L6.7 20H4.8l5.8-6.9L5 4Zm3 1.5 8.4 13h1.2l-8.4-13H8Z" /> : null}
      {name === "waveform" ? <path {...line} d="M3 12h2m2 0V8m0 4v4m3-4V5m0 7v7m3-7V7m0 5v5m3-5V9m0 3v3m3-3h2" /> : null}
    </svg>
  );
}

export function VoiceMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 32 32">
      <path
        d="M4.5 16h3.1c1.8 0 2.1-6.1 3.8-6.1 1.9 0 2 12.2 4 12.2 2.1 0 2.1-17.2 4.3-17.2 2.1 0 2 21.2 4 21.2 1.8 0 2-10.1 3.8-10.1h.1"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.3"
      />
    </svg>
  );
}
