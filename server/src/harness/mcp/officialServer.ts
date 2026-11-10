import fs from 'node:fs';
import path from 'node:path';
import type { McpSource } from '../tools/types';
import { isAllowedMcpPath, isOfficialMcpLocation, officialMcpRoots, type McpPathOptions } from './serviceGateway';

/**
 * Task 31 — resolve the OFFICIAL Roblox Studio MCP server.
 *
 * No npm-based launcher, no third-party Studio bridge package, no bundled binary, no network.
 * Morphi spawns either the server Roblox ships inside Studio, or the official `rbx-studio-mcp`.
 *
 * Order (win32): validated settings override → `%LOCALAPPDATA%\Roblox\mcp.bat` →
 * `Versions/version-<hash>/StudioMCP.exe` (newest mtime wins, because Roblox renames that folder on
 * every Studio update) → `%LOCALAPPDATA%\Roblox\rbx-studio-mcp.exe` → null.
 * On darwin: `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`.
 *
 * Security: every candidate goes through the SHARED `isAllowedMcpPath` validator, then through
 * `fs.realpath` + the same containment test again. The stored `provider_settings` row is never
 * trusted at spawn time. `cmd.exe` is only an interpreter for a validated `.bat`/`.cmd`, never a
 * user-supplied path. `auth.token` is never read (Ruling M4).
 */
export interface OfficialServerSpec {
  command: string;
  args: string[];
  source: McpSource;
  path: string;
}

export interface ResolveOptions extends McpPathOptions {
  env: NodeJS.ProcessEnv;
  override?: string | null;
  realpath?: (filePath: string) => string;
  /** Absolute StudioMCP.exe candidates, newest first. Injectable so tests need no filesystem. */
  versionCandidates?: (root: string) => string[];
}

const MAC_BUILTIN = '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP';

/** Keep one separator style so injected `exists()` seams and real fs agree byte-for-byte. */
function forward(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function defaultVersionCandidates(root: string, exists: (filePath: string) => boolean): string[] {
  const versions = `${forward(root)}/Versions`;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(versions).filter((entry) => /^version-/i.test(entry));
  } catch {
    return [];
  }
  return entries
    .map((entry) => `${versions}/${entry}/StudioMCP.exe`)
    .filter(exists)
    .sort((a, b) => {
      const mtime = (file: string): number => {
        try { return fs.statSync(file).mtimeMs; } catch { return 0; }
      };
      return mtime(b) - mtime(a);
    });
}

function commandFor(target: string): Pick<OfficialServerSpec, 'command' | 'args'> {
  const extension = path.win32.extname(target).toLowerCase();
  // `spawn` gets an argv array: the .bat contents are data, never an interpolated command line.
  if (extension === '.bat' || extension === '.cmd') return { command: 'cmd.exe', args: ['/c', target] };
  return { command: target, args: ['--stdio'] };
}

export function resolveOfficialMcpServer(options: ResolveOptions): OfficialServerSpec | null {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? ((filePath: string) => fs.existsSync(filePath));
  const realpath = options.realpath ?? ((filePath: string) => fs.realpathSync.native(filePath));
  const pathOptions: McpPathOptions = { platform, env: options.env, exists };

  /** Shared allowlist + realpath containment. A lexical junction cannot survive the second check. */
  const trusted = (candidate: string, allowExtensionless = false): boolean => {
    const shaped = allowExtensionless || isAllowedMcpPath(candidate, pathOptions);
    if (!shaped) return false;
    let real: string;
    try { real = realpath(candidate); } catch { return false; }
    return isOfficialMcpLocation(real, pathOptions);
  };

  const override = options.override?.trim();
  if (override) {
    // Fail closed: a stored override that no longer passes validation must not silently fall
    // through to a different binary than the user configured.
    if (!trusted(override)) return null;
    return { ...commandFor(override), source: 'settings', path: override };
  }

  if (platform === 'darwin') {
    if (!exists(MAC_BUILTIN)) return null;
    return trusted(MAC_BUILTIN, true)
      ? { command: MAC_BUILTIN, args: ['--stdio'], source: 'studio-builtin', path: MAC_BUILTIN }
      : null;
  }

  if (platform !== 'win32') return null;
  const root = officialMcpRoots(pathOptions)[0];
  if (!root) return null;
  const normalizedRoot = forward(root);

  const shim = `${normalizedRoot}/mcp.bat`;
  if (exists(shim) && trusted(shim)) {
    return { command: 'cmd.exe', args: ['/c', shim], source: 'studio-builtin', path: shim };
  }

  const candidates = options.versionCandidates
    ? options.versionCandidates(root)
    : defaultVersionCandidates(root, exists);
  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    // A version-dir executable has an official basename inside an official root, but its extension
    // rule differs from an override: it is discovered, not typed by a user.
    if (!trusted(candidate)) continue;
    return { ...commandFor(candidate), source: 'studio-builtin', path: candidate };
  }

  const officialBinary = `${normalizedRoot}/rbx-studio-mcp.exe`;
  if (exists(officialBinary) && trusted(officialBinary)) {
    return { ...commandFor(officialBinary), source: 'studio-binary', path: officialBinary };
  }

  return null;
}
