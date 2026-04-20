export interface GyroscopeReading {
  /** Raw device orientation angle around Z axis (degrees). */
  alpha: number;
  /** Raw device orientation angle around X axis (degrees). */
  beta: number;
  /** Raw device orientation angle around Y axis (degrees). */
  gamma: number;
  timestampMs: number;
}

export interface CameraOrbit {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  radius: number;
  updatedAtMs: number;
}

export interface TouchPoint {
  x: number;
  y: number;
}

export interface SpatialAudioSnippet {
  id: string;
  src: string;
  /** Normalized hologram-space coordinates. */
  anchor: { x: number; y: number; z: number };
  activationRadius: number;
  gain: number;
}

export interface ViewerState {
  orbit: CameraOrbit;
  shouldTransitionLoop: boolean;
  activeSnippetId: string | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class HologramViewer {
  private orbit: CameraOrbit = {
    yawDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    radius: 2.5,
    updatedAtMs: 0
  };
  private snippets: SpatialAudioSnippet[] = [];
  private activeSnippetId: string | null = null;
  private transitionThreshold: number;
  private shouldTransition = false;

  constructor(lowEngagementThreshold = 40) {
    this.transitionThreshold = lowEngagementThreshold;
  }

  applyGyroscope(reading: GyroscopeReading): CameraOrbit {
    // Quantchill viewer convention:
    // - gamma (left/right tilt) steers horizontal orbit (yaw)
    // - beta (front/back tilt) steers pitch
    // - alpha (compass heading) is mapped to roll for subtle orientation response
    this.orbit = {
      yawDeg: clamp(reading.gamma, -90, 90),
      pitchDeg: clamp(reading.beta, -80, 80),
      rollDeg: clamp(reading.alpha, -180, 180),
      radius: this.orbit.radius,
      updatedAtMs: reading.timestampMs
    };
    return this.orbit;
  }

  updateEngagement(engagementScore: number): boolean {
    this.shouldTransition = engagementScore < this.transitionThreshold;
    return this.shouldTransition;
  }

  setSpatialAudioSnippets(snippets: SpatialAudioSnippet[]): void {
    this.snippets = snippets
      .filter((s) => s.activationRadius > 0)
      .map((s) => ({
        ...s,
        activationRadius: clamp(s.activationRadius, 0.05, 3),
        gain: clamp(s.gain, 0, 1)
      }));
  }

  touch(point: TouchPoint): SpatialAudioSnippet | null {
    // Input touch coordinates are expected in normalized screen space [0, 1].
    // Convert them to hologram-space [-1, 1] with Y inverted to match scene axes.
    const normalizedTouchX = clamp(point.x, 0, 1) * 2 - 1;
    const normalizedTouchY = (1 - clamp(point.y, 0, 1)) * 2 - 1;

    let best: SpatialAudioSnippet | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const snippet of this.snippets) {
      const dx = snippet.anchor.x - normalizedTouchX;
      const dy = snippet.anchor.y - normalizedTouchY;
      const dz = snippet.anchor.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance <= snippet.activationRadius && distance < bestDistance) {
        best = snippet;
        bestDistance = distance;
      }
    }

    this.activeSnippetId = best?.id ?? null;
    return best;
  }

  getState(): ViewerState {
    return {
      orbit: this.orbit,
      shouldTransitionLoop: this.shouldTransition,
      activeSnippetId: this.activeSnippetId
    };
  }
}
