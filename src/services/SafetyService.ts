/**
 * Trust & Safety primitives: user-level blocks and abuse reports.
 *
 * Blocks are bidirectional for matchmaking/signaling purposes: if A blocks B,
 * neither can appear as a match candidate for the other, nor can signaling
 * frames traverse between them. Reports are counted in a rolling window; once
 * a subject accumulates enough distinct reporters, they are automatically
 * blocked site-wide (a "shadow block" visible via `isAutoBlocked`).
 *
 * Storage is in-memory; the shape matches a straightforward Prisma / Redis
 * upgrade path.
 */

export type ReportReason =
  | 'harassment'
  | 'nudity'
  | 'minor'
  | 'spam'
  | 'scam'
  | 'violence'
  | 'self-harm'
  | 'other';

export interface SafetyReport {
  reporterId: string;
  subjectId: string;
  reason: ReportReason;
  note?: string;
  createdAtMs: number;
}

export interface SafetyServiceOptions {
  /** Distinct reporters within `autoBlockWindowMs` needed to auto-block. */
  autoBlockThreshold?: number;
  /** Rolling window for auto-block counting, in ms. */
  autoBlockWindowMs?: number;
  /** Maximum number of reports to retain in memory. Default 10000. */
  maxReports?: number;
  /** Injected clock; matches repo test convention. */
  nowFn?: () => number;
}

export class SafetyService {
  /** userA -> set of userIds that userA has explicitly blocked. */
  private readonly blocks = new Map<string, Set<string>>();
  private readonly reports: SafetyReport[] = [];
  private readonly autoBlocked = new Set<string>();

  private readonly autoBlockThreshold: number;
  private readonly autoBlockWindowMs: number;
  private readonly maxReports: number;
  private readonly nowFn: () => number;

  constructor(options: SafetyServiceOptions = {}) {
    this.autoBlockThreshold = options.autoBlockThreshold ?? 5;
    this.autoBlockWindowMs = options.autoBlockWindowMs ?? 24 * 60 * 60 * 1000;
    this.maxReports = options.maxReports ?? 10_000;
    this.nowFn = options.nowFn ?? Date.now;

    if (this.autoBlockThreshold <= 0 || this.autoBlockWindowMs <= 0) {
      throw new Error('SafetyService: autoBlockThreshold and autoBlockWindowMs must be positive');
    }
    if (this.maxReports <= 0) {
      throw new Error('SafetyService: maxReports must be positive');
    }
  }

  /** User `blockerId` blocks `subjectId`. No-op if self-block. */
  block(blockerId: string, subjectId: string): boolean {
    if (!blockerId || !subjectId || blockerId === subjectId) return false;
    const set = this.blocks.get(blockerId) ?? new Set<string>();
    if (set.has(subjectId)) return false;
    set.add(subjectId);
    this.blocks.set(blockerId, set);
    return true;
  }

  unblock(blockerId: string, subjectId: string): boolean {
    const set = this.blocks.get(blockerId);
    if (!set) return false;
    const removed = set.delete(subjectId);
    if (set.size === 0) this.blocks.delete(blockerId);
    return removed;
  }

  /** List explicit blocks by `blockerId` (does not include auto-blocks). */
  listBlocks(blockerId: string): string[] {
    return Array.from(this.blocks.get(blockerId) ?? []);
  }

  /**
   * True if a match/signaling edge between `a` and `b` should be suppressed:
   * either has explicitly blocked the other, or either is auto-blocked site-wide.
   */
  isBlocked(a: string, b: string): boolean {
    if (!a || !b || a === b) return false;
    if (this.autoBlocked.has(a) || this.autoBlocked.has(b)) return true;
    return (
      (this.blocks.get(a)?.has(b) ?? false) ||
      (this.blocks.get(b)?.has(a) ?? false)
    );
  }

  /** Whether a user has been auto-blocked site-wide due to aggregated reports. */
  isAutoBlocked(userId: string): boolean {
    return this.autoBlocked.has(userId);
  }

  /**
   * Record a report. Ignores self-reports and duplicate (reporter, subject)
   * pairs within the rolling window. Returns the stored report, or null if
   * ignored.
   */
  report(params: {
    reporterId: string;
    subjectId: string;
    reason: ReportReason;
    note?: string;
  }): SafetyReport | null {
    const { reporterId, subjectId, reason, note } = params;
    if (!reporterId || !subjectId || reporterId === subjectId) return null;

    const now = this.nowFn();
    const windowStart = now - this.autoBlockWindowMs;

    // Collapse duplicate reporter/subject pairs in the active window so that
    // a single user cannot single-handedly auto-block another.
    const alreadyReported = this.reports.some(
      (r) =>
        r.reporterId === reporterId &&
        r.subjectId === subjectId &&
        r.createdAtMs >= windowStart
    );
    if (alreadyReported) return null;

    const record: SafetyReport = {
      reporterId,
      subjectId,
      reason,
      note,
      createdAtMs: now
    };
    this.reports.push(record);

    // Prune old reports beyond maxReports limit (FIFO).
    if (this.reports.length > this.maxReports) {
      this.reports.splice(0, this.reports.length - this.maxReports);
    }

    const distinctReporters = new Set<string>();
    for (const r of this.reports) {
      if (r.subjectId === subjectId && r.createdAtMs >= windowStart) {
        distinctReporters.add(r.reporterId);
      }
    }

    if (distinctReporters.size >= this.autoBlockThreshold) {
      this.autoBlocked.add(subjectId);
    }

    return record;
  }

  /** Distinct-reporter count for `subjectId` in the current window. */
  reportCount(subjectId: string): number {
    const windowStart = this.nowFn() - this.autoBlockWindowMs;
    const distinct = new Set<string>();
    for (const r of this.reports) {
      if (r.subjectId === subjectId && r.createdAtMs >= windowStart) {
        distinct.add(r.reporterId);
      }
    }
    return distinct.size;
  }

  /**
   * Filter candidate profiles/ids so that blocked pairs and auto-blocked users
   * are removed. Generic over any object with an `id` field, or a raw string.
   */
  filterCandidates<T extends { id: string } | string>(viewerId: string, items: T[]): T[] {
    return items.filter((item) => {
      const id = typeof item === 'string' ? item : item.id;
      if (id === viewerId) return true;
      return !this.isBlocked(viewerId, id);
    });
  }

  /** Manual administrative reset — primarily for tests. */
  clearAutoBlock(userId: string): boolean {
    return this.autoBlocked.delete(userId);
  }
}
