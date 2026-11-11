/**
 * HTTP 接口：只提供 JSON API，页面由 client.js 自己渲染。
 * 全部挂在 /dsh-cron/api 下，前端同源 fetch 即可。
 */

import { isInternalSession } from '../core/sessions.js';

const PREFIX = '/dsh-cron';
const API_PREFIX = '/api';
const MAX_BODY_BYTES = 512 * 1024;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function limitOf(url, fallback) {
  const raw = Number(url.searchParams.get('limit'));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(200, Math.floor(raw));
}

/** 关联工作区已有会话时用的候选列表；主机没有 sessionController 就静默降级。 */
/** 可选的权限预设（宿主 permissionPresets）。 */
function listPermissions(ctx) {
  const presets = ctx.get?.('permissionPresets');
  const names = presets?.names;
  if (!Array.isArray(names) || names.length === 0) return { available: false, items: [] };
  const items = names.flatMap((name) => {
    try {
      const option = presets.optionOf(name);
      return [{ id: option.value ?? name, name: option.name ?? name, ...(option.description ? { description: option.description } : {}) }];
    } catch {
      return [];
    }
  });
  return { available: items.length > 0, items };
}

/** 可选的提供商与模型（宿主 llm 注册表）。 */
async function listModels(ctx, logger) {
  const llm = ctx.get?.('llm');
  if (!llm || typeof llm.listProviders !== 'function') return { available: false, providers: [] };
  try {
    const providers = [];
    for (const provider of llm.listProviders()) {
      let models = [];
      try {
        models = (await llm.listModels(provider.id)) ?? [];
      } catch (error) {
        logger?.warn?.(`[dsh-cron] 读取 ${provider.id} 的模型失败`, error);
      }
      if (models.length === 0) continue;
      providers.push({
        id: provider.id,
        name: provider.name ?? provider.id,
        models: models.map((item) => ({ id: item.id, name: item.name ?? item.id })),
      });
    }
    return { available: providers.length > 0, providers };
  } catch (error) {
    logger?.warn?.('[dsh-cron] 读取模型目录失败', error);
    return { available: false, providers: [] };
  }
}

/** 可选的 agent 模型预置（宿主 agentPresets 注册表）。 */
async function listAgentPresets(ctx, logger) {
  const registry = ctx.get?.('agentPresets');
  if (!registry || typeof registry.remoteExportList !== 'function') return { available: false, items: [] };
  try {
    const roster = await registry.remoteExportList();
    const items = (roster?.presets ?? [])
      .filter((preset) => !preset.broken)
      .map((preset) => ({
        id: preset.id,
        name: preset.name ?? preset.id,
        ...(preset.description ? { description: preset.description } : {}),
        ...(preset.isDefault ? { isDefault: true } : {}),
      }));
    return { available: true, items };
  } catch (error) {
    logger?.warn?.('[dsh-cron] 读取 agent 预置失败', error);
    return { available: false, items: [] };
  }
}

async function listWorkspaceSessions(ctx, workspace, logger = console) {
  const controller = ctx.get?.('sessionController');
  if (!workspace || typeof controller?.list !== 'function') return { available: false, items: [] };
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const canonical = async (value) => {
      try { return await fs.realpath(value); } catch { return path.resolve(value); }
    };
    const wanted = await canonical(workspace);
    const listed = await controller.list();
    const summaries = Array.isArray(listed) ? listed : listed?.items ?? listed?.sessions ?? [];
    if (!Array.isArray(summaries)) throw new Error(`list() 返回 ${Object.prototype.toString.call(listed)}`);
    const items = [];
    for (const item of summaries) {
      if (typeof item?.sessionId !== 'string' || typeof item?.cwd !== 'string') continue;
      // 内部会话（mnemon 容器、子智能体）不进选择器
      if (isInternalSession({ sessionId: item.sessionId, origin: item.origin ?? item.header?.origin })) continue;
      if (await canonical(item.cwd) !== wanted) continue;
      const metadata = item.projections?.values?.sessionListMetadata;
      const title = item.title ?? item.name ?? metadata?.title ?? metadata?.summary
        ?? item.sessionId.slice(0, 8);
      const stamp = typeof item.updatedAt === 'number'
        ? item.updatedAt
        : Date.parse(item.updatedAt) || 0;
      items.push({
        sessionId: item.sessionId,
        title: String(title),
        cwd: item.cwd,
        updatedAt: stamp,
        _stamp: stamp,
      });
    }
    items.sort((left, right) => right._stamp - left._stamp);
    for (const item of items) delete item._stamp;
    return { available: true, items: items.slice(0, 100) };
  } catch (error) {
    logger.warn?.('[dsh-cron] 读取工作区会话失败', error);
    return { available: false, items: [] };
  }
}

/**
 * @param {object} ctx cordis host context
 * @param {import('../runtime/service.js').CronService} service
 * @param {import('../runtime/deliver.js').Delivery} delivery
 */
/** 面板和体检用得上「跑的是哪个版本」；读包自己的 package.json，只读一次。 */
let versionPromise;
function pluginVersion() {
  versionPromise ??= import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'))
    .then((raw) => JSON.parse(raw).version)
    .catch(() => null);
  return versionPromise;
}

export function registerRoutes(ctx, service, delivery, logger = console, builtin = undefined) {
  const webServer = ctx.webServer;
  if (!webServer?.register) {
    logger.warn?.('[dsh-cron] 没有 webServer，接口不可用');
    return () => {};
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname;
    const method = req.method ?? 'GET';

    if (!path.startsWith(API_PREFIX)) {
      json(res, 404, { ok: false, error: `未知接口 ${method} ${path}`, code: 'not_found' });
      return;
    }
    const route = path.slice(API_PREFIX.length) || '/';

    try {
      if (route === '/status' && method === 'GET') {
        return json(res, 200, { ok: true, version: await pluginVersion(), ...service.status() });
      }

      if (route === '/health' && method === 'GET') {
        return json(res, 200, { ok: true, health: service.health() });
      }

      if (route === '/workspaces' && method === 'GET') {
        return json(res, 200, { ok: true, items: service.listWorkspaces() });
      }

      if (route === '/targets' && method === 'GET') {
        return json(res, 200, { ok: true, ...(await delivery.listTargets()) });
      }

      if (route === '/permissions' && method === 'GET') {
        return json(res, 200, { ok: true, ...listPermissions(ctx) });
      }

      if (route === '/models' && method === 'GET') {
        return json(res, 200, { ok: true, ...(await listModels(ctx, logger)) });
      }

      if (route === '/presets' && method === 'GET') {
        return json(res, 200, { ok: true, ...(await listAgentPresets(ctx, logger)) });
      }

      if (route === '/sessions' && method === 'GET') {
        return json(res, 200, { ok: true, ...(await listWorkspaceSessions(ctx, url.searchParams.get('workspace'), logger)) });
      }

      if (route === '/builtin' && method === 'GET') {
        const patch = builtin ?? await import('./builtin.js')
        const configured = patch.readDisableBuiltin(ctx)
        const manager = ctx.get?.('pluginManager')
        let entries = null
        try {
          const rows = (await manager?.listPlugins?.()) ?? []
          entries = patch.BUILTIN_SCHEDULE_ENTRY_IDS.map((id) => {
            const row = rows.find((item) => item.patchId === id || item.entryId === id || item.entryId === `include:${id}`)
            return { id, enabled: row === undefined ? null : row.enabled === true }
          })
        } catch (error) {
          entries = String(error?.message ?? error)
        }
        return json(res, 200, { ok: true, configured, entries })
      }

      if (route === '/builtin' && method === 'POST') {
        const body = await readBody(req)
        const patch = builtin ?? await import('./builtin.js')
        const failures = await patch.syncBuiltinSchedule(ctx, logger, body.disabled === true)
        return json(res, 200, { ok: true, failures })
      }

      if (route === '/preview' && method === 'POST') {
        const body = await readBody(req);
        return json(res, 200, { ok: true, ...service.preview(body.schedule) });
      }

      if (route === '/incidents' && method === 'GET') {
        return json(res, 200, { ok: true, incidents: service.incidents(url.searchParams.get('status') ?? undefined) });
      }

      const ackMatch = route.match(/^\/incidents\/([^/]+)\/ack$/);
      if (ackMatch && method === 'POST') {
        return json(res, 200, { ok: true, incident: await service.ackIncident(decodeURIComponent(ackMatch[1])) });
      }

      if (route === '/tasks') {
        if (method === 'GET') {
          return json(res, 200, { ok: true, items: service.list({ includeEnded: url.searchParams.get('all') !== '0' }) });
        }
        if (method === 'POST') {
          const body = await readBody(req);
          return json(res, 200, { ok: true, task: await service.create(body) });
        }
      }

      if (route === '/runs' && method === 'GET') {
        return json(res, 200, { ok: true, runs: await service.history(undefined, limitOf(url, 50)) });
      }

      const taskMatch = route.match(/^\/tasks\/([^/]+)(\/[a-z]+)?$/);
      if (taskMatch) {
        const id = decodeURIComponent(taskMatch[1]);
        const action = taskMatch[2] ?? '';
        if (method === 'GET' && action === '') {
          const task = service.view(id);
          if (!task) return json(res, 404, { ok: false, error: '任务不存在', code: 'not_found' });
          return json(res, 200, { ok: true, task });
        }
        if (method === 'GET' && action === '/runs') {
          return json(res, 200, { ok: true, runs: await service.history(id, limitOf(url, 50)) });
        }
        if ((method === 'PATCH' || method === 'POST') && action === '') {
          const body = await readBody(req);
          return json(res, 200, { ok: true, task: await service.edit(id, body) });
        }
        if (method === 'DELETE' && action === '') {
          return json(res, 200, { ok: true, ...(await service.remove(id)) });
        }
        if (method === 'POST' && action === '/run') {
          return json(res, 200, { ok: true, run: await service.runNow(id) });
        }
        if (method === 'POST' && action === '/pause') {
          return json(res, 200, { ok: true, task: await service.pause(id) });
        }
        if (method === 'POST' && action === '/resume') {
          return json(res, 200, { ok: true, task: await service.resume(id) });
        }
      }

      json(res, 404, { ok: false, error: `未知接口 ${method} ${route}`, code: 'not_found' });
    } catch (error) {
      const notFound = error?.code === 'not_found';
      json(res, notFound ? 404 : 400, {
        ok: false,
        error: error?.message ?? String(error),
        code: notFound ? 'not_found' : 'invalid',
      });
    }
  };

  return webServer.register({ kind: 'prefix', path: PREFIX, handler });
}
