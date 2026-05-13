/**
 * src/plugins/types.ts — Shared plugin domain types.
 */

import type { PluginId } from '../core/types.js';

// ─── PERMISSIONS ──────────────────────────────────────────────────────────────

export const KNOWN_PERMISSIONS = new Set([
  'network',       // fetch() external URLs (proxied by host)
  'notifications', // push browser Notifications
  'dm:read',       // read DM message history
  'dm:write',      // send DMs on behalf of user
  'room:read',     // read room messages
  'room:write',    // inject messages into rooms
  'voice',         // interact with voice channels
  'ui:inject',     // add buttons/panels to app chrome
  'storage:read',  // read plugin's isolated key-value store
  'storage:write', // write plugin's isolated key-value store
  'bot:command',   // register a /slash command in autocomplete
] as const);

export type Permission = typeof KNOWN_PERMISSIONS extends Set<infer P> ? P : never;

// ─── MANIFEST ────────────────────────────────────────────────────────────────

export interface BotCommandDef {
  readonly command:     string;
  readonly description: string;
  readonly scope:       'room' | 'dm' | 'both';
  readonly icon?:       string;
}

export interface PluginManifest {
  readonly id:           PluginId;
  readonly name:         string;
  readonly version:      string;
  readonly description:  string;
  readonly entry?:       string;
  readonly permissions:  readonly string[];
  readonly botCommands?: readonly BotCommandDef[];
  readonly scope?:       'room' | 'dm' | 'both';
  readonly removable?:   boolean;
}

// ─── INSTALLED PLUGIN RECORD ─────────────────────────────────────────────────

export interface PluginEntry {
  readonly manifest:  PluginManifest;
  readonly iframe:    HTMLIFrameElement;
  readonly removable: boolean;
  enabled:            boolean;
  readonly store:     Record<string, unknown>;
  readonly baseUrl:   string | null;
  readonly source:    string;
}

// ─── BOT COMMAND REGISTRY ENTRY ───────────────────────────────────────────────

export interface BotCommandRegistration {
  readonly pluginId:    PluginId;
  readonly description: string;
  readonly scope:       'room' | 'dm' | 'both';
  readonly icon:        string;
}

// ─── PLUGIN API CALL CONTEXT ──────────────────────────────────────────────────

export interface ApiCallContext {
  readonly args:        Record<string, unknown>;
  readonly permissions: ReadonlySet<string>;
  readonly pluginId:    PluginId;
  readonly entry:       PluginEntry;
}

export type ApiHandler = (ctx: ApiCallContext) => Promise<unknown>;

// ─── SANDBOX INTERFACE ────────────────────────────────────────────────────────

export interface PluginSandbox {
  readonly pluginId: PluginId;
  load(manifest: PluginManifest, source: string): Promise<void>;
  send(msg: unknown): void;
  destroy(): void;
}

// ─── DIST CONFIG ──────────────────────────────────────────────────────────────

export interface DistPluginEntry {
  readonly id:         string;
  readonly removable?: boolean;
}

export interface DistConfig {
  readonly name:    string;
  readonly plugins: readonly DistPluginEntry[];
}

// ─── MARKETPLACE ──────────────────────────────────────────────────────────────

export interface MarketplaceEntry {
  readonly id:          string;
  readonly name:        string;
  readonly description: string;
  readonly version:     string;
  readonly author:      string;
  readonly baseUrl:     string;
  readonly icon?:       string;
  readonly tags?:       readonly string[];
}
