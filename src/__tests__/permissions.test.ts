// src/__tests__/permissions.test.ts
import { describe, it, expect } from 'vitest';
import { PermissionEngine } from '../plugins/permissions/engine.js';
import type { PluginManifest } from '../plugins/types.js';
import type { PluginId } from '../core/types.js';

function makeManifest(permissions: string[]): PluginManifest {
  return {
    id: 'test' as PluginId, name: 'Test', version: '1.0.0',
    description: '', permissions,
  };
}

describe('PermissionEngine', () => {
  const engine = new PermissionEngine();

  // ── validateManifest ─────────────────────────────────────────────────────

  it('accepts all known permissions', () => {
    const { valid, warnings } = engine.validateManifest(
      makeManifest(['network', 'notifications', 'dm:read', 'bot:command'])
    );
    expect(valid).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('strips unknown permissions with warnings', () => {
    const { permissions, warnings } = engine.validateManifest(
      makeManifest(['network', 'sudo', 'admin:everything'])
    );
    expect(permissions).toEqual(['network']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('sudo');
    expect(warnings[1]).toContain('admin:everything');
  });

  it('handles empty permissions array', () => {
    const { permissions, warnings } = engine.validateManifest(makeManifest([]));
    expect(permissions).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('result is always valid (warnings, not errors)', () => {
    const { valid } = engine.validateManifest(makeManifest(['completely-fake']));
    expect(valid).toBe(true);
  });

  // ── check ────────────────────────────────────────────────────────────────

  it('check passes when permission present', () => {
    const perms = new Set(['network', 'bot:command']);
    expect(() => engine.check(perms, 'network')).not.toThrow();
  });

  it('check throws when permission absent', () => {
    const perms = new Set(['network']);
    expect(() => engine.check(perms, 'bot:command')).toThrow('Permission denied: bot:command');
  });

  it('check throws for empty set', () => {
    expect(() => engine.check(new Set(), 'network')).toThrow('Permission denied: network');
  });

  it('check error message names the missing permission', () => {
    try {
      engine.check(new Set<string>(), 'dm:write');
    } catch (e) {
      expect(String(e)).toContain('dm:write');
    }
  });
});
