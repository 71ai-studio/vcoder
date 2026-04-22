import * as path from 'path';

export function resolveInside(root: string, target: string): string {
  const abs = path.isAbsolute(target) ? target : path.join(root, target);
  const normalized = path.normalize(abs);
  const normRoot = path.normalize(root);
  if (!normalized.startsWith(normRoot)) {
    throw new Error(`Path escapes workspace root: ${target}`);
  }
  return normalized;
}
