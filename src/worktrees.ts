import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

/** Git's common directory identifies worktrees of one local repository, not unrelated clones. */
export function repository(path: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', path, 'rev-parse', '--path-format=absolute', ...args], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    }).trim();
  return {
    root: realpathSync(git('--show-toplevel')),
    common: realpathSync(git('--git-common-dir')),
  };
}
