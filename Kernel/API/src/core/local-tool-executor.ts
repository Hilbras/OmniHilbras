import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { LOCAL_TOOL_MAX_BYTES, type LocalToolCall } from '@omnihilbras/tools';

/**
 * Executes the gateway's read-only local tools.
 *
 * This module is deliberately separate from Kernel/Tools: that package is pure contract and cannot touch a
 * filesystem. Nothing here runs a command, writes a file or opens a socket. Every path is resolved inside an
 * operator-approved root using `realpath`, so a symlink cannot lead out of the sandbox, and every result is capped.
 *
 * The whole layer is opt-in: with `OMNIHILBRAS_LOCAL_TOOLS=1` unset, `localToolRootsFromEnv()` returns no roots and
 * no tool is exposed. A root list without the flag is ignored rather than silently granting access.
 */

export type LocalToolResult = { content: string; isError: boolean };

export function localToolRootsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.OMNIHILBRAS_LOCAL_TOOLS !== '1') return [];
  return (env.OMNIHILBRAS_LOCAL_TOOL_ROOTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter(isAbsolute)
    .map((entry) => resolve(entry));
}

/** Resolve a caller path inside one approved root, refusing escapes and symlink tricks. */
function resolveInside(root: string, input: string): string {
  const rootReal = realpathSync(root);
  const candidate = isAbsolute(input) ? resolve(input) : resolve(root, input);
  let real = candidate;
  try {
    real = realpathSync(candidate);
  } catch {
    // A path that does not exist yet is only needed by `glob`; check its nearest existing parent instead.
    let parent = candidate;
    while (!exists(parent)) parent = resolve(parent, '..');
    real = resolve(realpathSync(parent), relative(parent, candidate));
  }
  const rel = relative(rootReal, real);
  // `rel === ''` is the approved root itself. That is a valid directory for glob/grep; a read of it is refused
  // later because it is not a file. What must be refused is any path that climbs out or is absolute outside.
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error('Path is outside the approved local tool roots.');
  }
  return real;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function chooseRoot(roots: readonly string[], input: string): string {
  for (const root of roots) {
    try {
      return resolveInside(root, input);
    } catch {
      // Try the next root. A caller may use a relative path that belongs to only one of them.
    }
  }
  throw new Error('Path is outside the approved local tool roots.');
}

function cap(text: string): string {
  return Buffer.byteLength(text) > LOCAL_TOOL_MAX_BYTES
    ? `${text.slice(0, LOCAL_TOOL_MAX_BYTES)}\n… [truncated at ${LOCAL_TOOL_MAX_BYTES} bytes]`
    : text;
}

async function walk(directory: string, pattern: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  async function visit(current: string, depth: number) {
    if (out.length >= limit || depth > 8) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (out.length >= limit) return;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (re.test(entry.name) || re.test(relative(directory, path).split(sep).join('/'))) {
        out.push(relative(directory, path).split(sep).join('/'));
      }
    }
  }
  await visit(directory, 0);
  return out;
}

export async function executeLocalTool(call: LocalToolCall, roots: readonly string[]): Promise<LocalToolResult> {
  if (roots.length === 0) return { content: 'Local tools are disabled on this gateway.', isError: true };
  if (!call.path) return { content: 'The tool call has no path.', isError: true };
  try {
    if (call.name === 'local_read') {
      const path = chooseRoot(roots, call.path);
      if (!statSync(path).isFile()) return { content: 'That path is not a file.', isError: true };
      return { content: cap(readFileSync(path, 'utf8')), isError: false };
    }
    if (call.name === 'local_glob') {
      if (!call.pattern) return { content: 'The glob call has no pattern.', isError: true };
      const path = chooseRoot(roots, call.path);
      if (!statSync(path).isDirectory()) return { content: 'That path is not a directory.', isError: true };
      const files = await walk(path, call.pattern, call.limit ?? 100);
      return { content: files.length ? files.join('\n') : 'No matching files.', isError: false };
    }
    if (call.name === 'local_grep') {
      if (!call.pattern) return { content: 'The grep call has no pattern.', isError: true };
      const path = chooseRoot(roots, call.path);
      const files = statSync(path).isDirectory() ? (await walk(path, '*', 100)).map((name) => resolve(path, name)) : [path];
      const lines: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const line of text.split('\n')) {
          if (line.includes(call.pattern)) lines.push(`${relative(roots[0]!, file)}: ${line}`);
          if (lines.length >= (call.limit ?? 50)) break;
        }
        if (lines.length >= (call.limit ?? 50)) break;
      }
      return { content: lines.length ? cap(lines.join('\n')) : 'No matching lines.', isError: false };
    }
    return { content: 'Unknown local tool.', isError: true };
  } catch (error) {
    // The operator's sentence, not a stack or an absolute host path the caller did not already know.
    return { content: error instanceof Error ? error.message : 'The local tool could not run.', isError: true };
  }
}
