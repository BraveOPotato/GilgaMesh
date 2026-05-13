/**
 * src/plugins/permissions/engine.ts — Permission enforcement.
 *
 * validateManifest() — strips unknown permissions, returns normalised list.
 * check()            — throws if a required permission is absent.
 */

import { KNOWN_PERMISSIONS, type PluginManifest } from '../types.js';

export interface ValidationResult {
  readonly valid:       boolean;
  readonly permissions: readonly string[];
  readonly warnings:    readonly string[];
}

export class PermissionEngine {
  /**
   * Normalise a manifest's permission list.
   * Unknown permissions are stripped with a warning (not an error) to allow
   * forward-compatibility with newer permission strings in older hosts.
   */
  validateManifest(manifest: PluginManifest): ValidationResult {
    const warnings: string[] = [];
    const valid: string[]    = [];

    for (const p of manifest.permissions ?? []) {
      if (KNOWN_PERMISSIONS.has(p as never)) {
        valid.push(p);
      } else {
        warnings.push(`Unknown permission "${p}" — ignored`);
      }
    }

    return {
      valid:       true,           // unknown permissions are warnings, not errors
      permissions: valid,
      warnings,
    };
  }

  /**
   * Assert that `permissions` contains `required`.
   * Throws a descriptive Error on failure — callers translate to API response.
   */
  check(permissions: ReadonlySet<string>, required: string): void {
    if (!permissions.has(required)) {
      throw new Error(`Permission denied: ${required}`);
    }
  }
}
