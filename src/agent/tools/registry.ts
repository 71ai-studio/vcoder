import { ToolHandler, ToolSchema } from './types';
import { readFile } from './read-file';
import { writeFile } from './write-file';
import { editFile } from './edit-file';
import { bash } from './bash';
import { grep } from './grep';
import { glob } from './glob';

export const ALL_TOOLS: Record<string, ToolHandler> = {
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  bash,
  grep,
  glob
};

export function getSchemas(allowed: string[] | null): ToolSchema[] {
  const names = allowed ?? Object.keys(ALL_TOOLS);
  return names
    .map((n) => ALL_TOOLS[n]?.schema)
    .filter((s): s is ToolSchema => Boolean(s));
}

export function getHandler(name: string): ToolHandler | undefined {
  return ALL_TOOLS[name];
}
