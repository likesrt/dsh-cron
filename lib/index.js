/**
 * Entry shell.
 *
 * The real plugin lives in `lib/app.js`. When `devReload` is on, the shell
 * imports it through a fresh URL on every mount, so toggling the bundle in the
 * running host picks up edited files instead of the module already cached by
 * Node's ESM loader. With `devReload` off the specifier is constant and the
 * import is cached as usual.
 */

import Schema from '@deepseek-ai/schemastery';

export const name = 'dsh-cron';

export const inject = ['tools', 'webServer'];

/**
 * 配置项会由 dsh-settings 投影成插件管理页里的表单。
 * 字段标 volatile：改完即时生效，不需要重启 host。
 */
export const Config = Schema.object({
  timeZone: Schema.string().default('Asia/Shanghai').volatile(),
  timeLimitMs: Schema.number().step(1).min(1000).max(3_600_000).default(180_000).volatile(),
  maxConcurrent: Schema.number().step(1).min(1).max(20).default(3).volatile(),
  historyDays: Schema.number().step(1).min(1).max(3650).default(30).volatile(),
  historyRecords: Schema.number().step(1).min(10).max(100_000).default(200).volatile(),
  disableBuiltinSchedule: Schema.boolean().default(true).volatile(),
  devReload: Schema.boolean().default(false),
  registryPath: Schema.string().volatile(),
});

export async function apply(ctx, config) {
  const specifier = config?.devReload ? `./app.js?t=${Date.now().toString(36)}` : './app.js';
  const implementation = await import(specifier);
  return implementation.apply(ctx, config);
}

export default { name, inject, Config, apply };
