import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodexAdapter } from '../../adapters/cli/codex.js';
import { collectCodexConfigOverrides, buildWrappedLaunch } from '../../setup/cli-selection.js';
import { installAidenCodexShim } from '../aiden-codex-shim.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiden-managed-launch-'));
  dirs.push(root);
  const native = join(root, 'real-codex');
  const gateway = join(root, 'aiden');
  writeFileSync(native, '#!/bin/sh\nprintf "%s\\n" "$@"\nprintf "PATH=%s\\n" "$PATH"\nprintf "SHIM=%s\\n" "${BOTMUX_AIDEN_CODEX_REAL_BIN:-}"\n', { mode: 0o700 });
  // Real process boundary: reject every gateway config except the documented
  // provider auth timeout, then add gateway-owned provider configuration.
  writeFileSync(gateway, `#!/bin/sh
set -eu
shift 2
for arg in "$@"; do
  case "$arg" in -c|--config) echo 'gateway rejected config' >&2; exit 2;; esac
done
exec codex -c 'model_provider="gateway-owned"' --dangerously-bypass-hook-trust "$@"
`, { mode: 0o700 });
  return { root, native, gateway };
}

// The production adapter emits ALL configs, including non-BOTMUX tool identity,
// service tier, fresh cwd trust and maintenance resume. No handwritten prefix list.
describe('Codex adapter → Aiden → native executable', () => {
  for (const mode of ['fresh', 'resume', 'fork', 'quiet-resume', 'remote'] as const) {
    it.each([undefined, 'high', 'ultra'] as const)(`${mode}, effort %s preserves generated configuration`, effort => {
      const { root, native, gateway } = setup();
      const marker = join(root, 'should-not-exist');
      const oddPath = `${root}/quote' dollar$(touch ${marker}) tick\`touch ${marker}\`\\space`;
      const args = createCodexAdapter().buildArgs({
        sessionId: 'botmux-session', resume: mode !== 'fresh', resumeSessionId: 'original-thread',
        quietResume: mode === 'quiet-resume', forkSession: mode === 'fork',
        ...(mode === 'remote' ? { remoteWsUrl: 'ws://fixture', remoteThreadId: 'original-thread' } : {}),
        workingDir: oddPath, model: 'configured-model', reasoningEffort: effort, serviceTier: 'priority',
        bypassHookTrust: true, hideRateLimitModelNudge: true,
        shellSubprocessEnv: {
          BOTMUX_SESSION_ID: 'botmux-session', BOTMUX_CHAT_ID: 'chat', BOTMUX_LARK_APP_ID: 'app',
          BOTMUX_ROOT_MESSAGE_ID: 'root', SESSION_DATA_DIR: oddPath,
          ZDOTDIR: `${oddPath}/shell`, BASH_ENV: `${oddPath}/bash_env.sh`, GIT_ASKPASS: `${oddPath}/git`,
          FUTURE_IDENTITY_PATH: oddPath,
        },
      });
      const configs = collectCodexConfigOverrides(args);
      const shimDir = installAidenCodexShim(join(root, 'shim'), configs);
      const launch = buildWrappedLaunch('aiden x codex', args, b => b === 'aiden' ? gateway : native, {
        codexConfigOverrides: configs, aidenCodexShimDir: shimDir, aidenCodexRealBin: native,
      });
      const originalPath = process.env.PATH!;
      const result = spawnSync(launch.bin, launch.args, { encoding: 'utf8', env: { ...process.env, ...launch.env } });
      expect(result.status, result.stderr).toBe(0);
      const received = result.stdout.trim().split('\n');
      expect(received).toEqual([
        ...configs.flatMap(v => ['-c', v]), '-c', 'model_provider="gateway-owned"',
        '--dangerously-bypass-hook-trust', ...launch.args.slice(3), `PATH=${originalPath}`, 'SHIM=',
      ]);
      expect(existsSync(marker)).toBe(false);
      expect(collectCodexConfigOverrides(received)).toEqual([...configs, 'model_provider="gateway-owned"']);
      if (mode !== 'fresh') expect(received).toContain('original-thread');
    });
  }

  it('does not silently discard identity when the shim cannot be installed', () => {
    expect(() => buildWrappedLaunch('aiden x codex', ['-c', 'x=1'], b => b, { codexConfigOverrides: ['x=1'] }))
      .toThrow('shim is unavailable');
  });

  it('does not smuggle user-owned configs past gateway validation, including identical later overrides', () => {
    const { root, native, gateway } = setup();
    const configs = ['shell_environment_policy.set.SESSION_DATA_DIR="managed"'];
    const shimDir = installAidenCodexShim(join(root, 'shim'), configs);
    for (const value of [...configs, 'model_provider="custom"', 'model_providers.foo.auth.timeout_ms=1000']) {
      const extra = ['-c', value];
      const launch = buildWrappedLaunch('aiden x codex', [...configs.flatMap(v => ['-c', v]), ...extra], b => b === 'aiden' ? gateway : native, {
        codexConfigOverrides: configs, aidenCodexShimDir: shimDir,
      });
      expect(launch.args.slice(-2)).toEqual(extra);
    }
  });

  it('fails closed if later rewriting dropped a managed occurrence', () => {
    expect(() => buildWrappedLaunch('aiden x codex', [], b => b, { codexConfigOverrides: ['x=1'] }))
      .toThrow('no longer matches');
  });

  it('routes the same generated config through cjadk long options; native wrappers and other CLIs retain behavior', () => {
    const args = ['-c', 'shell_environment_policy.set.BASH_ENV="/identity"', 'resume', 'thread'];
    const codexConfigOverrides = collectCodexConfigOverrides(args);
    expect(buildWrappedLaunch('cjadk codex', args, b => b, { codexConfigOverrides }).args)
      .toEqual(['codex', '--config', args[1], 'resume', 'thread']);
    expect(buildWrappedLaunch('custom codex', args, b => b, { codexConfigOverrides }).args).toEqual(['codex', ...args]);
    expect(buildWrappedLaunch('aiden x claude', ['--settings', '{}', '--model', 'm']).args).toEqual(['x', 'claude', '--model', 'm']);
  });

  it('captures the worker adapter output before appending operator arguments', () => {
    const worker = readFileSync(new URL('../../worker.ts', import.meta.url), 'utf8');
    expect(worker.indexOf('collectCodexConfigOverrides(args)')).toBeLessThan(worker.indexOf('args.push(...cliExtraArgs)'));
    expect(worker).toMatch(/installAidenCodexShim\([\s\S]*?codexConfigOverrides,/);
    expect(worker).toMatch(/aidenCodexShimDir,\s*codexConfigOverrides,/);
  });
});
