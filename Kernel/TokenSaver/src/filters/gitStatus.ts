import { STATUS_MAX_FILES, STATUS_MAX_UNTRACKED } from './constants.js';

/** Compact `git status`: branch, counted sections, capped file lists. */
export function gitStatus(input: string): string {
  const lines = input.split('\n');
  if (lines.length === 0 || (lines.length === 1 && !lines[0]!.trim())) {
    return 'Clean working tree';
  }

  let branch = '';
  const stagedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicts = 0;

  for (const raw of lines) {
    if (!raw.trim()) continue;

    const longBranch = /^On branch (\S+)/.exec(raw);
    if (longBranch) {
      branch = longBranch[1]!;
      continue;
    }

    if (raw.startsWith('##')) {
      branch = raw.replace(/^##\s*/, '');
      continue;
    }

    if (raw.length >= 3 && /^[ MADRCU?!][ MADRCU?!] /.test(raw)) {
      const x = raw[0]!;
      const y = raw[1]!;
      const file = raw.slice(3);

      if (raw.slice(0, 2) === '??') {
        untracked++;
        untrackedFiles.push(file);
        continue;
      }

      if ('MADRC'.includes(x)) {
        staged++;
        stagedFiles.push(file);
      } else if (x === 'U') {
        conflicts++;
      }

      if (y === 'M' || y === 'D') {
        modified++;
        modifiedFiles.push(file);
      }
      continue;
    }

    const longMatch = /^\s*(modified|new file|deleted|renamed|both modified):\s+(.+)$/.exec(raw);
    if (longMatch) {
      const kind = longMatch[1]!;
      const path = longMatch[2]!.trim();
      if (kind === 'both modified') {
        conflicts++;
      } else if (kind === 'modified' || kind === 'deleted') {
        modified++;
        modifiedFiles.push(path);
      } else if (kind === 'new file' || kind === 'renamed') {
        staged++;
        stagedFiles.push(path);
      }
    }
  }

  let out = '';
  if (branch) out += `* ${branch}\n`;

  if (staged > 0) {
    out += `+ Staged: ${staged} files\n`;
    for (const file of stagedFiles.slice(0, STATUS_MAX_FILES)) out += `   ${file}\n`;
    if (stagedFiles.length > STATUS_MAX_FILES) {
      out += `   ... +${stagedFiles.length - STATUS_MAX_FILES} more\n`;
    }
  }

  if (modified > 0) {
    out += `~ Modified: ${modified} files\n`;
    for (const file of modifiedFiles.slice(0, STATUS_MAX_FILES)) out += `   ${file}\n`;
    if (modifiedFiles.length > STATUS_MAX_FILES) {
      out += `   ... +${modifiedFiles.length - STATUS_MAX_FILES} more\n`;
    }
  }

  if (untracked > 0) {
    out += `? Untracked: ${untracked} files\n`;
    for (const file of untrackedFiles.slice(0, STATUS_MAX_UNTRACKED)) out += `   ${file}\n`;
    if (untrackedFiles.length > STATUS_MAX_UNTRACKED) {
      out += `   ... +${untrackedFiles.length - STATUS_MAX_UNTRACKED} more\n`;
    }
  }

  if (conflicts > 0) {
    out += `conflicts: ${conflicts} files\n`;
  }

  if (staged === 0 && modified === 0 && untracked === 0 && conflicts === 0) {
    out += 'clean — nothing to commit\n';
  }

  return out.replace(/\n+$/, '');
}
