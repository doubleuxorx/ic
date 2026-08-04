/**
 * Theme state.
 *
 * Light is the default on first launch. Dark uses true black for the
 * application and canvas background; only secondary surfaces lift off it.
 */

import { create } from 'zustand';

import { isPresetColor, type CanvasColor } from '@/shared/json-canvas';
import { useWorkspaceStore } from '@/workspace/workspace-store';

export type ThemeName = 'light' | 'dark';

const STORAGE_KEY = 'ic.theme';

const readStoredTheme = (): ThemeName => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Storage can be unavailable; the default still applies.
  }
  return 'light';
};

interface ThemeStore {
  theme: ThemeName;
  set: (theme: ThemeName) => void;
  toggle: () => void;
}

const applyTheme = (theme: ThemeName): void => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
};

export const useThemeStore = create<ThemeStore>((set, get) => ({
  theme: 'light',
  set: (theme) => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Persisting is best-effort; the session still honours the choice.
    }
    void useWorkspaceStore.getState().patchSettings({
      ui: { ...useWorkspaceStore.getState().settings.ui, theme },
    });
    set({ theme });
  },
  toggle: () => get().set(get().theme === 'light' ? 'dark' : 'light'),
}));

/** Called once at startup, before React renders, to avoid a flash. */
export const initTheme = (): void => {
  const theme = readStoredTheme();
  applyTheme(theme);
  useThemeStore.setState({ theme });
};

/**
 * Resolve a JSON Canvas color to a CSS color. Preset identifiers stay
 * identifiers in the document and are mapped to theme variables here.
 */
export const resolveColor = (color: CanvasColor | undefined): string | null => {
  if (!color) return null;
  if (isPresetColor(color)) return `var(--canvas-color-${color})`;
  return color;
};

const hexToRgb = (hex: string): [number, number, number] | null => {
  const value = hex.replace('#', '');
  const expand = value.length === 3 ? value.replace(/./g, (c) => c + c) : value;
  if (expand.length < 6) return null;
  const int = Number.parseInt(expand.slice(0, 6), 16);
  if (Number.isNaN(int)) return null;
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
};

const channelLuminance = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/**
 * Foreground for a custom hex surface, chosen per surface so text on a colored
 * node stays readable in both themes.
 */
export const contrastText = (color: CanvasColor | undefined): string | null => {
  if (!color || isPresetColor(color)) return null;
  const rgb = hexToRgb(color);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  const luminance =
    0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
  // Contrast against white vs black; pick whichever is larger.
  const withWhite = 1.05 / (luminance + 0.05);
  const withBlack = (luminance + 0.05) / 0.05;
  return withWhite >= withBlack ? '#ffffff' : '#000000';
};
