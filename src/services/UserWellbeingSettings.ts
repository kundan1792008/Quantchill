/**
 * UserWellbeingSettings – per-user opt-in controls for wellbeing-conscious
 * product features.
 *
 * Design principles:
 *   - Defaults are chosen conservatively. Rating is hidden by default; break
 *     reminders are off by default (we do not push notifications at users
 *     without opt-in).
 *   - Every setting is individually togglable. We never bundle "wellbeing
 *     mode" as an all-or-nothing switch that can be defaulted off to make
 *     opting out easy.
 *   - This service is intentionally a thin, in-memory store that mirrors the
 *     shape of the `UserWellbeingSettings` Prisma model. Production deployments
 *     can swap in a Prisma-backed implementation without changing callers.
 */
export interface UserWellbeingSettings {
  userId: string;
  /** If true, the user's ELO rating is never surfaced in any response. */
  hideEloRating: boolean;
  /**
   * Soft daily time limit in minutes. `null` means the user has not set one.
   * Enforcement is purely advisory – we surface it to the client, never block.
   */
  dailyTimeLimitMinutes: number | null;
  /** If true, the client may show gentle "take a break?" suggestions. */
  breakRemindersEnabled: boolean;
  updatedAt: number;
}

export interface UpdateSettingsInput {
  hideEloRating?: boolean;
  dailyTimeLimitMinutes?: number | null;
  breakRemindersEnabled?: boolean;
}

/** Defaults applied when a user has no stored settings. */
export function defaultSettings(userId: string): UserWellbeingSettings {
  return {
    userId,
    hideEloRating: true,
    dailyTimeLimitMinutes: null,
    breakRemindersEnabled: false,
    updatedAt: Date.now()
  };
}

/**
 * Validate a partial update. Throws on invalid values so that API handlers
 * can translate to a 400.
 */
export function validateUpdate(input: UpdateSettingsInput): void {
  if (input.dailyTimeLimitMinutes !== undefined && input.dailyTimeLimitMinutes !== null) {
    const v = input.dailyTimeLimitMinutes;
    if (!Number.isFinite(v) || v < 5 || v > 24 * 60) {
      throw new Error('dailyTimeLimitMinutes must be between 5 and 1440, or null');
    }
  }
}

export class UserWellbeingSettingsService {
  private readonly store = new Map<string, UserWellbeingSettings>();

  /** Returns current settings, creating conservative defaults on first read. */
  get(userId: string): UserWellbeingSettings {
    const existing = this.store.get(userId);
    if (existing) return { ...existing };
    const fresh = defaultSettings(userId);
    this.store.set(userId, fresh);
    return { ...fresh };
  }

  /** Apply a partial update. Missing fields are left unchanged. */
  update(userId: string, input: UpdateSettingsInput): UserWellbeingSettings {
    validateUpdate(input);
    const current = this.get(userId);
    const next: UserWellbeingSettings = {
      ...current,
      ...(input.hideEloRating !== undefined ? { hideEloRating: input.hideEloRating } : {}),
      ...(input.dailyTimeLimitMinutes !== undefined
        ? { dailyTimeLimitMinutes: input.dailyTimeLimitMinutes }
        : {}),
      ...(input.breakRemindersEnabled !== undefined
        ? { breakRemindersEnabled: input.breakRemindersEnabled }
        : {}),
      updatedAt: Date.now()
    };
    this.store.set(userId, next);
    return { ...next };
  }

  /** Convenience helper used by rating endpoints to decide whether to show. */
  isRatingVisible(userId: string): boolean {
    return this.get(userId).hideEloRating === false;
  }
}
