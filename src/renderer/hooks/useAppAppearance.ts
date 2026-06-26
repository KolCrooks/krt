import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { krtClient } from "../api/client.js";

export function useAppAppearance(): void {
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => krtClient.settings.get(),
    staleTime: 30_000
  });

  const appearance = settingsQuery.data?.appearance;

  useEffect(() => {
    if (!appearance) {
      return undefined;
    }

    const root = document.documentElement;
    root.dataset.theme = appearance.darkMode ? "dark" : "light";
    root.dataset.density = appearance.density;
    root.style.setProperty("--accent", appearance.accentColor);
    return undefined;
  }, [appearance]);
}
