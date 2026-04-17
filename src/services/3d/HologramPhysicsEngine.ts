/**
 * Zero-Latency WebAssembly Physics Engine for 3D Hologram Interactions
 * Provides real-time physics simulation for push/pull hologram gestures
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PhysicsConfig {
  mass: number;
  damping: number;
  springConstant: number;
}

/** Typed interface for the simulated (and future real) WASM physics module. */
interface PhysicsWasmModule {
  _initPhysics(mass: number, damping: number, springConstant: number): void;
  _updateHologramPosition(deltaTime: number): void;
  _applyPushForce(fx: number, fy: number, fz: number): void;
  _applyPullForce(fx: number, fy: number, fz: number): void;
  _getPosition(): [number, number, number];
  _getVelocity(): number;
}

export class HologramPhysicsEngine {
  private wasmModule: PhysicsWasmModule | null = null;
  private initialized = false;
  private readonly defaultConfig: PhysicsConfig = {
    mass: 1.0,
    damping: 0.95,
    springConstant: 0.5
  };

  constructor(private config: PhysicsConfig = this.defaultConfig) {}

  /**
   * Initialize WebAssembly module (simulated for now, will load actual WASM)
   * In production, this would load the compiled hologram_physics.wasm
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Simulate WASM initialization with native JavaScript physics
    // In production: const wasmBinary = await fetch('hologram_physics.wasm');
    // const module = await WebAssembly.instantiate(wasmBinary);

    this.wasmModule = this.createSimulatedWasmModule();
    this.wasmModule._initPhysics(
      this.config.mass,
      this.config.damping,
      this.config.springConstant
    );

    this.initialized = true;
  }

  /**
   * Update hologram position based on physics simulation
   * Called every frame for zero-latency updates
   */
  updatePosition(deltaTime: number): Vec3 {
    if (!this.initialized) {
      throw new Error('Physics engine not initialized');
    }

    // wasmModule is guaranteed non-null when initialized === true
    this.wasmModule!._updateHologramPosition(deltaTime);
    return this.getPosition();
  }

  /**
   * Apply push force to hologram (swipe away gesture)
   */
  applyPushForce(force: Vec3): void {
    if (!this.initialized) return;
    this.wasmModule!._applyPushForce(force.x, force.y, force.z);
  }

  /**
   * Apply pull force to hologram (swipe closer gesture)
   */
  applyPullForce(force: Vec3): void {
    if (!this.initialized) return;
    this.wasmModule!._applyPullForce(force.x, force.y, force.z);
  }

  /**
   * Get current hologram position
   */
  getPosition(): Vec3 {
    if (!this.initialized) {
      return { x: 0, y: 0, z: 0 };
    }

    const pos = this.wasmModule!._getPosition();
    return { x: pos[0], y: pos[1], z: pos[2] };
  }

  /**
   * Get current velocity magnitude (for haptic feedback intensity)
   */
  getVelocity(): number {
    if (!this.initialized) return 0;
    return this.wasmModule!._getVelocity();
  }

  /**
   * Simulated WASM module using native JavaScript
   * Replace with actual WASM module in production
   */
  private createSimulatedWasmModule(): PhysicsWasmModule {
    let position = { x: 0, y: 0, z: 0 };
    let velocity = { x: 0, y: 0, z: 0 };
    let acceleration = { x: 0, y: 0, z: 0 };
    let mass = 1.0;
    let damping = 0.95;
    let springConstant = 0.5;
    const restPosition = { x: 0, y: 0, z: 0 };

    return {
      _initPhysics: (m: number, d: number, k: number) => {
        mass = m;
        damping = d;
        springConstant = k;
        position = { x: 0, y: 0, z: 0 };
        velocity = { x: 0, y: 0, z: 0 };
        acceleration = { x: 0, y: 0, z: 0 };
      },

      _updateHologramPosition: (deltaTime: number) => {
        // Spring force (attraction to rest position)
        const springForce = {
          x: -springConstant * (position.x - restPosition.x),
          y: -springConstant * (position.y - restPosition.y),
          z: -springConstant * (position.z - restPosition.z)
        };

        // Damping force
        const dampingForce = {
          x: -damping * velocity.x,
          y: -damping * velocity.y,
          z: -damping * velocity.z
        };

        // Total force
        const totalForce = {
          x: acceleration.x * mass + springForce.x + dampingForce.x,
          y: acceleration.y * mass + springForce.y + dampingForce.y,
          z: acceleration.z * mass + springForce.z + dampingForce.z
        };

        // Update acceleration (F = ma)
        acceleration.x = totalForce.x / mass;
        acceleration.y = totalForce.y / mass;
        acceleration.z = totalForce.z / mass;

        // Update velocity
        velocity.x += acceleration.x * deltaTime;
        velocity.y += acceleration.y * deltaTime;
        velocity.z += acceleration.z * deltaTime;

        // Update position
        position.x += velocity.x * deltaTime;
        position.y += velocity.y * deltaTime;
        position.z += velocity.z * deltaTime;

        // Clamp position
        position.x = Math.max(-10, Math.min(10, position.x));
        position.y = Math.max(-10, Math.min(10, position.y));
        position.z = Math.max(-10, Math.min(10, position.z));

        // Reset acceleration for next frame
        acceleration = { x: 0, y: 0, z: 0 };
      },

      _applyPushForce: (fx: number, fy: number, fz: number) => {
        acceleration.x += fx / mass;
        acceleration.y += fy / mass;
        acceleration.z += fz / mass;
      },

      _applyPullForce: (fx: number, fy: number, fz: number) => {
        acceleration.x -= fx / mass;
        acceleration.y -= fy / mass;
        acceleration.z -= fz / mass;
      },

      _getPosition: (): [number, number, number] => [position.x, position.y, position.z],

      _getVelocity: () => Math.sqrt(
        velocity.x * velocity.x +
        velocity.y * velocity.y +
        velocity.z * velocity.z
      )
    };
  }
}
