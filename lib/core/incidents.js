/**
 * Incidents: the long-running failure record a task accumulates until someone
 * acknowledges it. One open incident per task, updated in place.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export class IncidentBook {
  constructor(directory) {
    this.file = path.join(directory, 'incidents.json');
    this.items = [];
    this.loaded = false;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.items = Array.isArray(parsed?.incidents) ? parsed.incidents : [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.items = [];
    }
    this.loaded = true;
    return this.items;
  }

  async save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, incidents: this.items }, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }

  open(taskId) {
    return this.items.find((incident) => incident.taskId === taskId && incident.status === 'open') ?? null;
  }

  /** Record one failure; returns the incident row. */
  async record(task, run) {
    const existing = this.open(task.id);
    const at = run.endedAt ?? new Date().toISOString();
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = at;
      existing.lastError = run.error ?? run.output ?? existing.lastError;
      await this.save();
      return existing;
    }
    const incident = {
      id: `inc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      taskId: task.id,
      title: task.title,
      status: 'open',
      openedAt: at,
      lastSeenAt: at,
      count: 1,
      lastError: run.error ?? run.output ?? null,
    };
    this.items.push(incident);
    // Keep the book bounded: newest 200 rows.
    if (this.items.length > 200) this.items = this.items.slice(-200);
    await this.save();
    return incident;
  }

  /** Close the task's open incident after a healthy run. */
  async resolve(taskId, at = new Date().toISOString()) {
    const existing = this.open(taskId);
    if (!existing) return null;
    existing.status = 'resolved';
    existing.resolvedAt = at;
    await this.save();
    return existing;
  }

  async ack(id, at = new Date().toISOString()) {
    const incident = this.items.find((item) => item.id === id);
    if (!incident) return null;
    incident.status = 'acked';
    incident.ackedAt = at;
    await this.save();
    return incident;
  }

  list({ status } = {}) {
    const items = [...this.items].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
    return status ? items.filter((incident) => incident.status === status) : items;
  }

  openCount() {
    return this.items.filter((incident) => incident.status === 'open').length;
  }
}
