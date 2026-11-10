import { describe, expect, it } from 'vitest';
import { resolveOfficialMcpServer } from './officialServer';

/**
 * Task 31 Step 1 — pure resolver tests. No real filesystem, no spawn, no registry.
 * Every test injects env/platform/exists (and realpath for the junction cases).
 */
const WIN_ENV = { LOCALAPPDATA: 'C:/Users/me/AppData/Local' };
const ROBLOX = 'C:/Users/me/AppData/Local/Roblox';
const BAT = `${ROBLOX}/mcp.bat`;
const BINARY = `${ROBLOX}/rbx-studio-mcp.exe`;
const VERSION_EXE = `${ROBLOX}/Versions/version-abc123/StudioMCP.exe`;
const MAC = '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP';

const only = (...files: string[]) => (candidate: string) => files.includes(candidate);
const identityReal = (candidate: string) => candidate;

describe('resolveOfficialMcpServer', () => {
  it('uses the volatile mcp.bat shim through cmd.exe /c on win32', () => {
    const result = resolveOfficialMcpServer({
      env: WIN_ENV, platform: 'win32', exists: only(BAT), realpath: identityReal,
      versionCandidates: () => [],
    });
    expect(result).toEqual({ command: 'cmd.exe', args: ['/c', BAT], source: 'studio-builtin', path: BAT });
  });

  it('accepts a validated settings override and launches it directly', () => {
    const exe = 'D:/tools/rbx-studio-mcp.exe';
    const result = resolveOfficialMcpServer({
      env: {}, override: exe, platform: 'win32', exists: only(exe), realpath: identityReal,
      versionCandidates: () => [],
    });
    expect(result).toEqual({ command: exe, args: ['--stdio'], source: 'settings', path: exe });
  });

  it('resolves the built-in macOS binary without an .exe extension rule', () => {
    const result = resolveOfficialMcpServer({
      env: {}, platform: 'darwin', exists: only(MAC), realpath: identityReal,
      versionCandidates: () => [],
    });
    expect(result).toEqual({ command: MAC, args: ['--stdio'], source: 'studio-builtin', path: MAC });
  });

  it('falls back to the official rbx-studio-mcp binary when no built-in shim exists', () => {
    const result = resolveOfficialMcpServer({
      env: WIN_ENV, platform: 'win32', exists: only(BINARY), realpath: identityReal,
      versionCandidates: () => [],
    });
    expect(result).toEqual({ command: BINARY, args: ['--stdio'], source: 'studio-binary', path: BINARY });
  });

  it('prefers a real version-*/StudioMCP.exe over the downloaded binary', () => {
    const result = resolveOfficialMcpServer({
      env: WIN_ENV, platform: 'win32', exists: only(VERSION_EXE, BINARY), realpath: identityReal,
      versionCandidates: () => [VERSION_EXE],
    });
    expect(result).toMatchObject({ source: 'studio-builtin', path: VERSION_EXE, command: VERSION_EXE });
  });

  it('returns null when nothing official is installed', () => {
    expect(resolveOfficialMcpServer({
      env: WIN_ENV, platform: 'win32', exists: () => false, realpath: identityReal,
      versionCandidates: () => [],
    })).toBeNull();
  });

  it.each([
    ['missing', 'D:/tools/rbx-studio-mcp.exe'],
    ['bad extension', 'D:/tools/rbx-studio-mcp.dll'],
    ['NUL byte', 'D:/tools/rbx-studio-mcp.exe\0x'],
    ['shell metacharacter', 'D:/tools/rbx-studio-mcp.exe & calc'],
    ['relative', 'tools/rbx-studio-mcp.exe'],
  ])('refuses an override that is %s', (_label, override) => {
    expect(resolveOfficialMcpServer({
      env: WIN_ENV, override, platform: 'win32', exists: () => false, realpath: identityReal,
      versionCandidates: () => [],
    })).toBeNull();
  });

  it('rejects a junction inside the Roblox root that really points at cmd.exe', () => {
    const junction = `${ROBLOX}/jn/mcp.bat`;
    const outside = 'C:/Windows/System32/cmd.exe';
    expect(resolveOfficialMcpServer({
      env: WIN_ENV, override: junction, platform: 'win32',
      exists: only(junction), realpath: () => outside, versionCandidates: () => [],
    })).toBeNull();
  });

  it('re-validates the built-in shim through realpath too', () => {
    expect(resolveOfficialMcpServer({
      env: WIN_ENV, platform: 'win32', exists: only(BAT),
      realpath: () => 'C:/Windows/System32/cmd.exe', versionCandidates: () => [],
    })).toBeNull();
  });

  it('never returns a command other than cmd.exe or the resolved path itself', () => {
    const cases = [
      resolveOfficialMcpServer({ env: WIN_ENV, platform: 'win32', exists: only(BAT), realpath: identityReal, versionCandidates: () => [] }),
      resolveOfficialMcpServer({ env: WIN_ENV, platform: 'win32', exists: only(BINARY), realpath: identityReal, versionCandidates: () => [] }),
      resolveOfficialMcpServer({ env: {}, platform: 'darwin', exists: only(MAC), realpath: identityReal, versionCandidates: () => [] }),
    ];
    for (const result of cases) {
      expect(result).not.toBeNull();
      expect(['cmd.exe', result?.path]).toContain(result?.command);
      expect(JSON.stringify(result?.args)).not.toContain('npx');
      expect(JSON.stringify(result?.args)).not.toContain('robloxstudio-mcp');
    }
  });
});
