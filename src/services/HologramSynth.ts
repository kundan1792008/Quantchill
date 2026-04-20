export interface ProfileVideoFrame {
  timestampMs: number;
  width: number;
  height: number;
  /** Luminance samples in row-major order, each in [0, 255]. */
  luma: number[];
}

export interface ProfileVideoUpload {
  userId: string;
  frames: ProfileVideoFrame[];
}

export interface DepthMap {
  width: number;
  height: number;
  /** Depth samples in row-major order, each in [0, 1]. */
  depth: number[];
}

export interface Point3D {
  x: number;
  y: number;
  z: number;
  intensity: number;
  frameIndex: number;
}

export interface PointCloudBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface PointCloud {
  points: Point3D[];
  bounds: PointCloudBounds;
}

export interface HologramShader {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, number>;
}

export interface HologramSynthesisResult {
  userId: string;
  depthMaps: DepthMap[];
  pointCloud: PointCloud;
  shader: HologramShader;
}

export interface HologramSynthOptions {
  pointStride: number;
  depthScale: number;
}

const DEFAULT_OPTIONS: HologramSynthOptions = {
  pointStride: 3,
  depthScale: 1.5
};
const LUMINANCE_WEIGHT = 0.8;
const TEMPORAL_GRADIENT_WEIGHT = 0.2;
const SHADER_PULSE_FREQUENCY = 1.5;
const SHADER_WAVE_FREQUENCY = 6.0;
const SHADER_WAVE_AMPLITUDE = 0.02;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function validateFrame(frame: ProfileVideoFrame): void {
  if (!Number.isFinite(frame.width) || !Number.isFinite(frame.height) || frame.width < 1 || frame.height < 1) {
    throw new Error('Frame dimensions must be positive.');
  }

  if (frame.luma.length !== frame.width * frame.height) {
    throw new Error('Frame luma data size does not match width * height.');
  }
}

export class HologramSynth {
  private readonly options: HologramSynthOptions;

  constructor(options: Partial<HologramSynthOptions> = {}) {
    this.options = {
      pointStride: Math.max(1, Math.floor(options.pointStride ?? DEFAULT_OPTIONS.pointStride)),
      depthScale: Math.max(0.1, options.depthScale ?? DEFAULT_OPTIONS.depthScale)
    };
  }

  extractDepthMaps(frames: ProfileVideoFrame[]): DepthMap[] {
    if (frames.length === 0) {
      return [];
    }

    return frames.map((frame, frameIndex) => {
      validateFrame(frame);
      // For the first frame there is no previous temporal sample, so we reuse
      // the current frame and let temporalGradient resolve to zero.
      const previous = frames[Math.max(0, frameIndex - 1)];
      const depth = frame.luma.map((luma, i) => {
        const normalized = clamp(luma / 255, 0, 1);
        const prevLuma = previous?.luma?.[i] ?? luma;
        const temporalGradient = Math.abs(luma - prevLuma) / 255;
        const edgeEnhanced = clamp(
          normalized * LUMINANCE_WEIGHT + temporalGradient * TEMPORAL_GRADIENT_WEIGHT,
          0,
          1
        );
        return 1 - edgeEnhanced;
      });

      return {
        width: frame.width,
        height: frame.height,
        depth
      };
    });
  }

  constructPointCloud(depthMaps: DepthMap[]): PointCloud {
    const points: Point3D[] = [];
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;

    depthMaps.forEach((map, frameIndex) => {
      const centerX = (map.width - 1) / 2;
      const centerY = (map.height - 1) / 2;

      for (let y = 0; y < map.height; y += this.options.pointStride) {
        for (let x = 0; x < map.width; x += this.options.pointStride) {
          const idx = y * map.width + x;
          const depth = map.depth[idx] ?? 0;
          const intensity = 1 - depth;
          const point: Point3D = {
            x: (x - centerX) / Math.max(1, centerX),
            y: (centerY - y) / Math.max(1, centerY),
            z: depth * this.options.depthScale,
            intensity,
            frameIndex
          };
          points.push(point);
          minX = Math.min(minX, point.x);
          maxX = Math.max(maxX, point.x);
          minY = Math.min(minY, point.y);
          maxY = Math.max(maxY, point.y);
          minZ = Math.min(minZ, point.z);
          maxZ = Math.max(maxZ, point.z);
        }
      }
    });

    if (points.length === 0) {
      return {
        points,
        bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 }
      };
    }

    return {
      points,
      bounds: { minX, maxX, minY, maxY, minZ, maxZ }
    };
  }

  buildHologramShader(): HologramShader {
    return {
      vertexShader: `
        precision highp float;
        attribute vec3 position;
        attribute float intensity;
        uniform float uTime;
        uniform float uPulseStrength;
        varying float vIntensity;
        void main() {
          vec3 animated = position;
          animated.z += sin(uTime * ${SHADER_PULSE_FREQUENCY} + position.x * ${SHADER_WAVE_FREQUENCY}) * ${SHADER_WAVE_AMPLITUDE} * uPulseStrength;
          vIntensity = intensity;
          gl_Position = vec4(animated, 1.0);
          gl_PointSize = 2.0 + intensity * 3.0;
        }
      `.trim(),
      fragmentShader: `
        precision highp float;
        uniform float uGlow;
        uniform float uScanlineMix;
        varying float vIntensity;
        void main() {
          vec2 c = gl_PointCoord - vec2(0.5);
          float d = dot(c, c);
          float alpha = smoothstep(0.25, 0.0, d);
          float scan = sin(gl_FragCoord.y * 0.2) * 0.5 + 0.5;
          vec3 base = vec3(0.0, 0.75, 1.0) * (0.55 + vIntensity * 0.45);
          vec3 glow = vec3(0.55, 0.95, 1.0) * uGlow;
          vec3 color = mix(base, base + glow, uScanlineMix * scan);
          gl_FragColor = vec4(color, alpha);
        }
      `.trim(),
      uniforms: {
        uTime: 0,
        uPulseStrength: 1,
        uGlow: 0.5,
        uScanlineMix: 0.45
      }
    };
  }

  synthesize(upload: ProfileVideoUpload): HologramSynthesisResult {
    const depthMaps = this.extractDepthMaps(upload.frames);
    const pointCloud = this.constructPointCloud(depthMaps);
    const shader = this.buildHologramShader();
    return {
      userId: upload.userId,
      depthMaps,
      pointCloud,
      shader
    };
  }
}
