/**
 * Native Haptic Feedback Service using Capacitor
 * Provides vibration feedback for push/pull hologram gestures
 */

import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

export interface HapticConfig {
  enabled: boolean;
  intensityMultiplier: number;
}

export enum HapticFeedbackType {
  LIGHT = 'light',
  MEDIUM = 'medium',
  HEAVY = 'heavy',
  SUCCESS = 'success',
  WARNING = 'warning',
  ERROR = 'error'
}

export class HapticFeedbackService {
  private config: HapticConfig;
  private isSupported: boolean = false;

  constructor(config: HapticConfig = { enabled: true, intensityMultiplier: 1.0 }) {
    this.config = config;
    void this.checkHapticSupport();
  }

  /**
   * Check if haptic feedback is supported on the device
   */
  private async checkHapticSupport(): Promise<void> {
    try {
      // Capacitor Haptics is available on iOS and Android
      // Web fallback uses Vibration API if available
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        this.isSupported = true;
      }
    } catch (error) {
      this.isSupported = false;
      console.warn('Haptic feedback not supported:', error);
    }
  }

  /**
   * Trigger haptic feedback based on velocity magnitude
   * Used when pushing hologram out of frame
   */
  async triggerPushFeedback(velocity: number): Promise<void> {
    if (!this.config.enabled || !this.isSupported) return;

    try {
      const intensity = this.calculateIntensity(velocity);

      if (intensity < 0.3) {
        await Haptics.impact({ style: ImpactStyle.Light });
      } else if (intensity < 0.6) {
        await Haptics.impact({ style: ImpactStyle.Medium });
      } else {
        await Haptics.impact({ style: ImpactStyle.Heavy });
      }
    } catch (error) {
      console.error('Push feedback error:', error);
    }
  }

  /**
   * Trigger haptic feedback when pulling hologram closer
   * Smoother, lighter vibration for attraction
   */
  async triggerPullFeedback(velocity: number): Promise<void> {
    if (!this.config.enabled || !this.isSupported) return;

    try {
      const intensity = this.calculateIntensity(velocity);

      if (intensity < 0.5) {
        await Haptics.impact({ style: ImpactStyle.Light });
      } else {
        await Haptics.impact({ style: ImpactStyle.Medium });
      }
    } catch (error) {
      console.error('Pull feedback error:', error);
    }
  }

  /**
   * Trigger notification-style haptic feedback
   */
  async triggerNotification(type: 'success' | 'warning' | 'error'): Promise<void> {
    if (!this.config.enabled || !this.isSupported) return;

    try {
      let notificationType: NotificationType;

      switch (type) {
        case 'success':
          notificationType = NotificationType.Success;
          break;
        case 'warning':
          notificationType = NotificationType.Warning;
          break;
        case 'error':
          notificationType = NotificationType.Error;
          break;
      }

      await Haptics.notification({ type: notificationType });
    } catch (error) {
      console.error('Notification feedback error:', error);
    }
  }

  /**
   * Trigger custom haptic pattern for hologram interactions
   */
  async triggerCustomPattern(pattern: number[]): Promise<void> {
    if (!this.config.enabled || !this.isSupported) return;

    try {
      // Use Vibration API for custom patterns
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(pattern);
      }
    } catch (error) {
      console.error('Custom pattern feedback error:', error);
    }
  }

  /**
   * Trigger selection feedback (light tap)
   */
  async triggerSelection(): Promise<void> {
    if (!this.config.enabled || !this.isSupported) return;

    try {
      await Haptics.selectionStart();
      setTimeout(() => {
        void Haptics.selectionEnd().catch((err) => {
          console.error('Selection end feedback error:', err);
        });
      }, 50);
    } catch (error) {
      console.error('Selection feedback error:', error);
    }
  }

  /**
   * Calculate haptic intensity based on velocity
   * Returns normalized value between 0 and 1
   */
  private calculateIntensity(velocity: number): number {
    // Velocity typically ranges from 0 to 10 in physics engine
    const normalized = Math.min(1.0, velocity / 10.0);
    return normalized * this.config.intensityMultiplier;
  }

  /**
   * Enable haptic feedback
   */
  enable(): void {
    this.config.enabled = true;
  }

  /**
   * Disable haptic feedback
   */
  disable(): void {
    this.config.enabled = false;
  }

  /**
   * Check if haptic feedback is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled && this.isSupported;
  }

  /**
   * Update intensity multiplier
   */
  setIntensityMultiplier(multiplier: number): void {
    this.config.intensityMultiplier = Math.max(0, Math.min(2, multiplier));
  }
}
