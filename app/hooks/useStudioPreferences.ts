import { useEffect, useState } from "react";
import type { Scene } from "../lib/live/config";
import type { Outfit, ThemePreference } from "../lib/live/types";

export function useStudioPreferences() {
  const [scene, setScene] = useState<Scene>("bedroom");
  const [outfit, setOutfit] = useState<Outfit>("casual");
  const [themePreference, setThemePreference] = useState<ThemePreference>("system");
  const [petalsEnabled, setPetalsEnabled] = useState(true);

  useEffect(() => {
    const savedTheme = localStorage.getItem("lumi-theme");
    if (savedTheme === "light" || savedTheme === "dark" || savedTheme === "system") {
      const timer = window.setTimeout(() => setThemePreference(savedTheme), 0);
      return () => window.clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    const savedPetals = localStorage.getItem("lumi-petals");
    if (savedPetals === "off") {
      const timer = window.setTimeout(() => setPetalsEnabled(false), 0);
      return () => window.clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolvedTheme = themePreference === "system"
        ? media.matches ? "dark" : "light"
        : themePreference;
      document.documentElement.dataset.theme = resolvedTheme;
      document.documentElement.dataset.themePreference = themePreference;
    };

    applyTheme();
    if (themePreference === "system") media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themePreference]);

  const chooseTheme = (theme: ThemePreference) => {
    localStorage.setItem("lumi-theme", theme);
    setThemePreference(theme);
  };

  const choosePetals = (enabled: boolean) => {
    localStorage.setItem("lumi-petals", enabled ? "on" : "off");
    setPetalsEnabled(enabled);
  };

  return {
    scene,
    setScene,
    outfit,
    setOutfit,
    themePreference,
    chooseTheme,
    petalsEnabled,
    choosePetals,
  };
}
