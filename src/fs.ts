import {
  constants,
  lstatSync,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  mkdirSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { ensure, hash } from './model.js';

export function absent(e: unknown): boolean {
  return e instanceof Error && 'code' in e && e.code === 'ENOENT';
}
export function safeParents(path: string): void {
  for (let parent = dirname(resolve(path)); ; parent = dirname(parent)) {
    try {
      const st = lstatSync(parent);
      ensure(
        st.isDirectory() && !st.isSymbolicLink(),
        `Symlink or non-directory parent: ${parent}`,
      );
    } catch (e) {
      if (!absent(e)) throw e;
    }
    if (dirname(parent) === parent) break;
  }
}
export function readText(path: string): string | null {
  safeParents(path);
  try {
    const before = lstatSync(path);
    ensure(before.isFile() && !before.isSymbolicLink(), `Not a regular file: ${path}`);
    ensure(before.size <= 1024 * 1024, `File exceeds 1 MiB: ${path}`);
    const fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const opened = fstatSync(fd);
      ensure(
        opened.isFile() && opened.ino === before.ino && opened.size <= 1024 * 1024,
        'File changed during read',
      );
      const content = readFileSync(fd);
      const after = fstatSync(fd);
      ensure(
        content.length <= 1024 * 1024 &&
          opened.size === after.size &&
          opened.mtimeMs === after.mtimeMs,
        'File changed during read; retry sync',
      );
      return new TextDecoder('utf-8', { fatal: true }).decode(content);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}
/** Compare before replacing. A durable pending publication lets sync recover after a crash. */
export function atomicWrite(path: string, text: string, expected: string | null): void {
  safeParents(path);
  const original = readText(path);
  ensure(
    (original === null ? null : hash(original)) === expected,
    `File changed during sync: ${path}`,
  );
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (original !== null) chmodSync(temp, lstatSync(path).mode);
    const current = readText(path);
    ensure(
      (current === null ? null : hash(current)) === expected,
      `File changed during sync: ${path}`,
    );
    renameSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch (e) {
      if (!absent(e)) throw e;
    }
  }
}
