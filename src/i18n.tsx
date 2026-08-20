import { createContext, useContext, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import zhCN from "./locales/zh-CN.json";

export const UI_LOCALES = ["en", "ja", "zh-CN"] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

type StringTree<T> = {
  [Key in keyof T]: T[Key] extends string ? string : StringTree<T[Key]>;
};

export type Messages = StringTree<typeof en>;

const catalogs: Record<UiLocale, Messages> = {
  en,
  ja,
  "zh-CN": zhCN,
};

export const localeOptions: ReadonlyArray<{
  value: UiLocale;
  label: string;
  note: string;
}> = [
  { value: "en", label: "English", note: "English" },
  { value: "ja", label: "日本語", note: "Japanese · 日本語" },
  { value: "zh-CN", label: "简体中文", note: "Chinese (Simplified) · 简体中文" },
];

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === "string" && UI_LOCALES.includes(value as UiLocale);
}

export function messagesFor(locale: UiLocale): Messages {
  return catalogs[locale];
}

export function formatMessage(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  const required = new Set(
    [...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(
      (match) => match[1],
    ),
  );
  for (const key of required) {
    if (!(key in values)) throw new Error(`Missing message value: ${key}`);
  }
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key: string) =>
    String(values[key]),
  );
}

type I18nValue = {
  locale: UiLocale;
  messages: Messages;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  locale,
  children,
}: {
  locale: UiLocale;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ locale, messages: messagesFor(locale) }),
    [locale],
  );
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("Localized UI rendered without I18nProvider");
  return value;
}
