/**
 * Application settings management
 * Loads settings from JSON file and makes them available in both server and client contexts
 */

export type DebugChannel = "API" | "Repository" | "EntityEditor";

export interface DebugSettings {
  [key: string]: boolean;
}

export interface AppSettings {
  debug: DebugSettings;
}

declare global {
  var __APP_SETTINGS__: AppSettings | undefined;
}

const DEFAULT_SETTINGS: AppSettings = {
  debug: {
    API: false,
    Repository: false,
    EntityEditor: false,
  },
};

/**
 * Initialize settings on the server by reading from static/app-settings.json
 * Must be called before the server starts
 */
export async function initServerAppSettings(): Promise<void> {
  try {
    const settingsPath = new URL("../static/app-settings.json", import.meta.url);
    const settingsText = await Deno.readTextFile(settingsPath);
    const settings: AppSettings = JSON.parse(settingsText);
    
    // Merge with defaults to ensure all channels are present
    const mergedSettings: AppSettings = {
      debug: {
        ...DEFAULT_SETTINGS.debug,
        ...settings.debug,
      },
    };
    
    globalThis.__APP_SETTINGS__ = mergedSettings;
  } catch (error) {
    console.warn("Failed to load app-settings.json, using defaults:", error);
    globalThis.__APP_SETTINGS__ = DEFAULT_SETTINGS;
  }
}

/**
 * Get the current app settings (works on both server and client)
 * Returns default settings if not initialized
 */
export function getAppSettings(): AppSettings {
  if (typeof globalThis.__APP_SETTINGS__ !== "undefined") {
    return globalThis.__APP_SETTINGS__;
  }
  return DEFAULT_SETTINGS;
}

/**
 * Check if a debug channel is enabled
 */
export function isDebugEnabled(channel: DebugChannel): boolean {
  const settings = getAppSettings();
  return settings.debug[channel] === true;
}
