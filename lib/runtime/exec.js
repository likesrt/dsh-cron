/**
 * 脚本执行：整个结果就是退出码加 stdout/stderr，不碰模型。
 */

import { spawn } from 'node:child_process';

const MAX_CAPTURE_BYTES = 256 * 1024;

const SHELL_META = /[\s|&;<>()$`"'*?[\]{}~#]/;

/**
 * Run one command.
 * @param {{command: string, args?: string[], cwd?: string, shell?: boolean, env?: Record<string,string>, timeoutMs?: number}} script
 * @param {{signal?: AbortSignal, cwd?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv}} [context]
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, durationMs: number, command: string}>}
 */
export function runScript(script, context = {}) {
  const startedAt = Date.now();
  const args = script.args ?? [];
  const useShell = script.shell ?? (args.length === 0 && SHELL_META.test(script.command));
  const cwd = script.cwd ?? context.cwd ?? process.cwd();
  const timeoutMs = script.timeoutMs ?? context.timeoutMs ?? 180_000;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = useShell
        ? spawn(script.command, { cwd, shell: true, detached: true, env: { ...process.env, ...script.env, ...context.env }, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(script.command, args, { cwd, detached: true, env: { ...process.env, ...script.env, ...context.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const capture = (chunk, which) => {
      const text = chunk.toString('utf8');
      if (which === 'out') {
        if (stdout.length < MAX_CAPTURE_BYTES) stdout += text;
      } else if (stderr.length < MAX_CAPTURE_BYTES) {
        stderr += text;
      }
    };

    child.stdout?.on('data', (chunk) => capture(chunk, 'out'));
    child.stderr?.on('data', (chunk) => capture(chunk, 'err'));

    // detached 起的进程组，超时要把整组杀掉：只杀 shell 会留下孙进程继续跑。
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    const onAbort = () => killGroup();
    context.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode, signal) => {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        signal: signal ?? null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        durationMs: Date.now() - startedAt,
        command: useShell ? script.command : [script.command, ...args].join(' '),
      });
    };

    child.on('error', (error) => {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
