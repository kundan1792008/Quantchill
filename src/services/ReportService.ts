/**
 * ReportService – user reporting with configurable auto-ban threshold.
 *
 * Records reports of the form `{ reporterId, targetId, reason, timestamp }`.
 * After a target has accumulated `banThreshold` (default 3) distinct
 * reporters, the target is automatically added to the banned set and every
 * future call to `isBanned(targetId)` returns `true`.
 *
 * Distinct-reporter tracking is required to prevent a single user from
 * ban-bombing another account by submitting three identical reports.
 */

export interface ReportPayload {
  reporterId: string;
  targetId: string;
  reason?: string;
}

export interface Report extends ReportPayload {
  id: number;
  createdAt: number;
}

export interface ReportSummary {
  targetId: string;
  totalReports: number;
  distinctReporters: number;
  banned: boolean;
  banReasons: string[];
  lastReportedAt: number | null;
}

export interface ReportServiceOptions {
  banThreshold?: number;
  now?: () => number;
}

/** Record reports and maintain a live auto-ban list. */
export class ReportService {
  private readonly banThreshold: number;
  private readonly now: () => number;
  private readonly reports: Report[] = [];
  private readonly banned = new Set<string>();
  private readonly distinctReporters = new Map<string, Set<string>>();
  private nextId = 1;

  constructor(options: ReportServiceOptions = {}) {
    this.banThreshold = options.banThreshold ?? 3;
    this.now = options.now ?? Date.now;
  }

  /** Submit a report; returns the stored record plus updated summary. */
  report(payload: ReportPayload): { report: Report; summary: ReportSummary } {
    if (!payload.reporterId) throw new Error('reporterId is required');
    if (!payload.targetId) throw new Error('targetId is required');
    if (payload.reporterId === payload.targetId) {
      throw new Error('cannot report self');
    }

    const record: Report = {
      id: this.nextId++,
      reporterId: payload.reporterId,
      targetId: payload.targetId,
      reason: payload.reason,
      createdAt: this.now()
    };
    this.reports.push(record);

    const reporters = this.getReporters(payload.targetId);
    reporters.add(payload.reporterId);
    if (reporters.size >= this.banThreshold) {
      this.banned.add(payload.targetId);
    }

    return { report: record, summary: this.summary(payload.targetId) };
  }

  /** Return the current ban status of a user. */
  isBanned(userId: string): boolean {
    return this.banned.has(userId);
  }

  /** Return a snapshot of every banned user. */
  getBannedUsers(): string[] {
    return Array.from(this.banned);
  }

  /** Return a summary for a target user. */
  summary(targetId: string): ReportSummary {
    const mine = this.reports.filter((r) => r.targetId === targetId);
    const reporters = this.getReporters(targetId);
    return {
      targetId,
      totalReports: mine.length,
      distinctReporters: reporters.size,
      banned: this.banned.has(targetId),
      banReasons: mine.map((r) => r.reason ?? 'unspecified').filter((v, i, arr) => arr.indexOf(v) === i),
      lastReportedAt: mine.length ? mine[mine.length - 1].createdAt : null
    };
  }

  /** Return every report for a target. */
  getReports(targetId: string): Report[] {
    return this.reports.filter((r) => r.targetId === targetId).map((r) => ({ ...r }));
  }

  /** Remove a user from the ban list – used by moderation workflows. */
  unban(userId: string): boolean {
    return this.banned.delete(userId);
  }

  /** Return total number of stored reports – used for tests / metrics. */
  totalReportCount(): number {
    return this.reports.length;
  }

  private getReporters(targetId: string): Set<string> {
    let s = this.distinctReporters.get(targetId);
    if (!s) {
      s = new Set();
      this.distinctReporters.set(targetId, s);
    }
    return s;
  }
}
