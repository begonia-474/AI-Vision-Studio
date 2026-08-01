import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { zhCN } from "./locales/zh-CN";
import { enUS } from "./locales/en-US";

export const LANG_KEY = "lang";
export type Lang = "zh-CN" | "en-US";

const saved = (() => {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
})();
const initialLang: Lang = saved === "en-US" ? "en-US" : "zh-CN";

i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    "en-US": { translation: enUS },
  },
  lng: initialLang,
  fallbackLng: "zh-CN",
  interpolation: { escapeValue: false },
});

i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng;
  try {
    localStorage.setItem(LANG_KEY, lng);
  } catch {
    /* ignore */
  }
});

export function switchLanguage(lang: Lang) {
  i18n.changeLanguage(lang);
}

export default i18n;
