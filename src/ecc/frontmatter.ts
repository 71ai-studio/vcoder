import * as fs from 'fs';
import matter from 'gray-matter';

export interface Frontmatter {
  name?: string;
  description?: string;
  tools?: string[] | string;
  model?: string;
  [key: string]: unknown;
}

export interface ParsedDoc {
  data: Frontmatter;
  body: string;
  path: string;
}

export function parseFile(filePath: string): ParsedDoc | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = matter(raw);
    return { data: parsed.data as Frontmatter, body: parsed.content.trim(), path: filePath };
  } catch {
    return null;
  }
}

export function normalizeToolList(tools: string[] | string | undefined): string[] {
  if (!tools) return [];
  if (Array.isArray(tools)) return tools.map((t) => String(t).trim()).filter(Boolean);
  return String(tools)
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}
