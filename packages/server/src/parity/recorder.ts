import type { ResponseDrift } from './report.ts';
import { collapseIndices, type Finding } from './validate.ts';

/** Response divergences seen while the server ran. Strict mode records, never rejects. */
export class ConformanceRecorder {
  private readonly drift = new Map<string, ResponseDrift>();

  record(operationId: string, status: number, raw: readonly Finding[]): void {
    if (raw.length === 0) return;
    const issues = collapseIndices(raw);
    const key = `${operationId} ${status}`;
    const seen = this.drift.get(key);
    if (seen === undefined) {
      this.drift.set(key, { operationId, status, calls: 1, issues: [...issues] });
      return;
    }
    seen.calls += 1;
    for (const issue of issues) {
      if (!seen.issues.some((kept) => kept.path === issue.path && kept.message === issue.message)) {
        seen.issues.push(issue);
      }
    }
  }

  snapshot(): ResponseDrift[] {
    return [...this.drift.values()].map((entry) => ({ ...entry, issues: [...entry.issues] }));
  }
}

const registry = new WeakMap<object, ConformanceRecorder>();

export const attachRecorder = (key: object, recorder: ConformanceRecorder): void => {
  registry.set(key, recorder);
};

export const recorderFor = (key: object): ConformanceRecorder | null => registry.get(key) ?? null;
