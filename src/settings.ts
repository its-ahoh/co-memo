import { z } from 'zod';
import { Scope, ensure } from './model.js';
import type { Store } from './store.js';

export const SettingsPatch = z.strictObject({
  saveMode: z.enum(['auto', 'explicit']).optional(),
  defaultScope: Scope.optional(),
  paused: z.boolean().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;
export const defaults = {
  saveMode: 'auto' as 'auto' | 'explicit',
  defaultScope: 'project' as 'user' | 'project',
  paused: false,
};
export type Settings = typeof defaults;
export type Intent = 'explicit' | 'automatic';
export function settings(store: Store, projectId: string | null): Settings {
  const user = store.settings(null);
  const project = projectId ? store.settings(projectId) : {};
  return {
    defaultScope: project.defaultScope ?? user.defaultScope ?? defaults.defaultScope,
    paused: user.paused === true || project.paused === true,
    saveMode: user.saveMode === 'explicit' || project.saveMode === 'explicit' ? 'explicit' : 'auto',
  };
}
export function allowWrite(store: Store, projectId: string | null, intent: Intent): void {
  const current = settings(store, projectId);
  ensure(!current.paused, 'Co-memo is paused; resume it in settings before writing memories');
  ensure(
    current.saveMode !== 'explicit' || intent === 'explicit',
    'Explicit-only mode: use a memory tool or CLI command with explicit user intent; Markdown edits are retained but not imported',
  );
}
