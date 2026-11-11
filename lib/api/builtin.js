/**
 * 内置自动化任务（官方那套）的开关。
 *
 * bundle 自带的补丁默认把这三行关掉；用户把开关关掉时，这里走 pluginManager
 * 把条目写进 profile 补丁并即时重载，重启后仍是用户选的状态，不会被补丁按回去。
 *
 * 只能由真实请求触发（面板保存配置时打 /dsh-cron/api/builtin）：
 * 从插件自己的定时器或 apply 里调用 pluginManager，会被 HMR 事务拒绝或悄悄回滚，
 * 看着"执行成功"，补丁其实没落地。所以这里不带任何自动触发。
 */

/** 内置自动化任务的三个入口：调度服务、模型工具、界面页面。 */
export const BUILTIN_SCHEDULE_ENTRY_IDS = ['schedule', 'tool-schedule', 'ui-schedule'];

/** 从插件清单里认出内置自动化任务的条目，entryId 带 include: 前缀，patchId 才是补丁里的裸 id。 */
function findRow(rows, id) {
  return rows.find((item) => item.patchId === id || item.entryId === id || item.entryId === `include:${id}`);
}

/**
 * 把三个入口对齐到配置要的状态。
 * @returns 失败次数；0 表示该对齐的都对齐了。
 */
export async function syncBuiltinSchedule(ctx, logger, disabled) {
  const manager = ctx.get?.('pluginManager');
  if (!manager?.listPlugins || !manager?.setPluginEnabled) return 0;
  const want = disabled !== true;

  let rows;
  try {
    rows = await manager.listPlugins();
  } catch (error) {
    logger?.warn?.('[dsh-cron] 读取插件清单失败', error);
    return 1;
  }

  let failures = 0;
  for (const id of BUILTIN_SCHEDULE_ENTRY_IDS) {
    const row = findRow(rows, id);
    if (row === undefined || row.enabled === want) continue;
    try {
      await manager.setPluginEnabled(row.entryId, want);
    } catch (error) {
      failures += 1;
      logger?.warn?.(`[dsh-cron] 切换内置的 ${id} 失败`, error);
    }
  }
  return failures;
}

/**
 * 读一次当前生效配置里的这个开关。
 * @returns 布尔值；读不到时返回 undefined，调用方就不动。
 */
export function readDisableBuiltin(ctx) {
  try {
    const row = ctx.get?.('settings')?.describe?.().find((item) => item.ns === 'dsh-cron');
    const value = row?.value?.disableBuiltinSchedule;
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}
