/**
 * dsh-cron — 按工作区隔离的定时任务。
 *
 * 与内置 schedule 的分工：只保留两种执行模式（脚本不叫醒模型、prompt 交给模型），
 * 任务数据跟着工作区走，成功失败共用一个投递配置，面板由 client.js 渲染。
 */

/**
 * 本地模块一律在 apply 里动态 import，并带上 devReload 的时间戳。
 * index.js 只负责让 app.js 自己重新加载；如果这里写静态 import，
 * ESM 仍会拿缓存里的 service.js / http.js，改完代码等于没改。
 */
async function loadParts(bust) {
  const [service, deliver, dispatch, store, tools, http, builtin] = await Promise.all([
    import(`./runtime/service.js${bust}`),
    import(`./runtime/deliver.js${bust}`),
    import(`./runtime/dispatch.js${bust}`),
    import(`./data/store.js${bust}`),
    import(`./api/tools.js${bust}`),
    import(`./api/http.js${bust}`),
    import(`./api/builtin.js${bust}`),
  ]);
  return {
    CronService: service.CronService,
    Delivery: deliver.Delivery,
    Dispatcher: dispatch.Dispatcher,
    MultiStore: store.MultiStore,
    defaultRegistryPath: store.defaultRegistryPath,
    createCronTools: tools.createCronTools,
    registerRoutes: http.registerRoutes,
    builtin,
  };
}

export const name = 'dsh-cron';

/** `tools` 给模型用，`webServer` 挂接口；dsh-im / sessionController 运行时现查。 */
export const inject = ['tools', 'webServer'];

/** volatile Config 字段传进来是 {get, [write]} 包装，读出普通值再交给服务。 */
function plain(value) {
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === 'get' && typeof value.get === 'function'
    && Object.getOwnPropertySymbols(value).length === 1) {
    return plain(value.get());
  }
  if (Array.isArray(value)) return value.map(plain);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
}

export async function apply(ctx, config = {}) {
  config = plain(config);
  const bust = config.devReload === true ? `?t=${Date.now().toString(36)}` : '';
  const {
    CronService, Delivery, Dispatcher, MultiStore, defaultRegistryPath, createCronTools, registerRoutes, builtin,
  } = await loadParts(bust);
  const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-cron') : (ctx.logger ?? console);

  const store = new MultiStore({
    registryPath: config.registryPath ?? defaultRegistryPath(),
    timeZone: config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    historyDays: config.historyDays,
    historyRecords: config.historyRecords,
  });
  const delivery = new Delivery(ctx, logger);
  const dispatcher = new Dispatcher(ctx, logger);

  const service = new CronService({
    ctx,
    store,
    delivery,
    dispatcher,
    logger,
    options: {
      timeZone: config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
      timeLimitMs: config.timeLimitMs ?? 180_000,
      maxConcurrent: config.maxConcurrent ?? 3,
      disableBuiltinSchedule: config.disableBuiltinSchedule === true,
    },
  });

  // 先加载再挂工具和接口：任何一处都不该看到一个只加载了一半的任务表。
  await service.start();

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      service.stop().catch(() => {});
    }, 'dsh-cron: scheduler');
  }

  for (const tool of createCronTools(service)) {
    ctx.tools.register(tool);
  }

  // 内置自动化任务的开关只在面板保存配置时由 /dsh-cron/api/builtin 真正执行：
  // 从 apply 或插件自己的定时器里回调 pluginManager 会被 HMR 事务拒绝，看着成功其实回滚了。
  const routeDisposer = registerRoutes(ctx, service, delivery, logger, builtin);
  if (typeof ctx.effect === 'function' && typeof routeDisposer === 'function') {
    ctx.effect(() => routeDisposer, 'dsh-cron: api routes');
  }

  if (typeof ctx.provide === 'function') {
    ctx.provide('cron', Object.freeze({
      contractVersion: 2,
      list: (options) => service.list(options),
      view: (id) => service.view(id),
      create: (input) => service.create(input),
      edit: (id, patch) => service.edit(id, patch),
      remove: (id) => service.remove(id),
      runNow: (id) => service.runNow(id),
      history: (id, limit) => service.history(id, limit),
      preview: (schedule) => service.preview(schedule),
      workspaces: () => service.listWorkspaces(),
      incidents: (status) => service.incidents(status),
      ackIncident: (id) => service.ackIncident(id),
      health: () => service.health(),
      status: () => service.status(),
    }));
  }

  logger.info?.(`[dsh-cron] 已启动，工作区登记表 ${store.registryPath}`);
}

export default { name, inject, apply };
