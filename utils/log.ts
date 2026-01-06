/**
 * Debug logging utility that respects app settings
 */

import type { DebugChannel } from "./appSettings.ts";
import { isDebugEnabled } from "./appSettings.ts";

/**
 * Log a debug message for a specific channel
 * Only logs if the channel is enabled in app settings
 */
export function debug(channel: DebugChannel, ...args: unknown[]): void {
  if (isDebugEnabled(channel)) {
    console.log(`[${channel}]`, ...args);
  }
}

/**
 * Log an info message for a specific channel
 * Only logs if the channel is enabled in app settings
 */
export function info(channel: DebugChannel, ...args: unknown[]): void {
  if (isDebugEnabled(channel)) {
    console.info(`[${channel}]`, ...args);
  }
}

/**
 * Log an error message (always logs, not gated by settings)
 */
export function error(...args: unknown[]): void {
  console.error(...args);
}

/**
 * Log a warning message (always logs, not gated by settings)
 */
export function warn(...args: unknown[]): void {
  console.warn(...args);
}
