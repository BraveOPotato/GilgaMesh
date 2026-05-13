// src/core/state/plugins.ts
import { createStore, type Store } from './utils.js';
import type { PluginId, PluginManifest, BotCommandDef } from '../types.js';

export interface InstalledPlugin {
  readonly id:        PluginId;
  readonly manifest:  PluginManifest;
  readonly enabled:   boolean;
  readonly removable: boolean;
  /** Isolated key-value store for this plugin. */
  readonly store:     Readonly<Record<string, unknown>>;
}

export interface BotCommand {
  readonly def:      BotCommandDef;
  readonly pluginId: PluginId;
}

export interface PluginsState {
  readonly plugins:     Readonly<Record<string, InstalledPlugin>>;
  /** Slash command name → BotCommand registration */
  readonly botCommands: Readonly<Record<string, BotCommand>>;
}

export const pluginsStore: Store<PluginsState> = createStore<PluginsState>({
  plugins:     {},
  botCommands: {},
});
