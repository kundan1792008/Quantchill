/**
 * WebGL 3D Hologram Renderer using Three.js
 * Renders matched user's 3D avatar scan instead of 2D photos
 */

import * as THREE from 'three';

export interface HologramData {
  userId: string;
  meshUrl?: string;
  textureUrl?: string;
  position?: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  scale?: number;
}

export interface RenderOptions {
  antialias: boolean;
  alpha: boolean;
  powerPreference: 'high-performance' | 'low-power' | 'default';
}

export class HologramRenderer {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private hologramMesh: THREE.Mesh | null = null;
  private animationFrameId: number | null = null;
  private container: HTMLElement;

  constructor(
    container: HTMLElement,
    options: RenderOptions = {
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    }
  ) {
    this.container = container;

    // Initialize Three.js scene
    this.scene = new THREE.Scene();
    // Keep background null so the alpha channel from WebGLRenderer is respected,
    // allowing the hologram to overlay on top of a video stream.

    // Setup camera
    const aspect = container.clientWidth / container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000);
    this.camera.position.z = 5;

    // Setup WebGL renderer
    this.renderer = new THREE.WebGLRenderer(options);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    // Add lighting
    this.setupLighting();

    // Handle window resize
    window.addEventListener('resize', this.handleResize);
  }

  /**
   * Setup scene lighting for hologram effect
   */
  private setupLighting(): void {
    // Ambient light for base illumination
    const ambientLight = new THREE.AmbientLight(0x404040, 2);
    this.scene.add(ambientLight);

    // Directional light for hologram glow effect
    const directionalLight = new THREE.DirectionalLight(0x00ffff, 3);
    directionalLight.position.set(5, 5, 5);
    this.scene.add(directionalLight);

    // Point light for dynamic hologram shimmer
    const pointLight = new THREE.PointLight(0xff00ff, 2, 100);
    pointLight.position.set(0, 0, 10);
    this.scene.add(pointLight);

    // Hemisphere light for realistic hologram look
    const hemiLight = new THREE.HemisphereLight(0x0099ff, 0xff0099, 1);
    this.scene.add(hemiLight);
  }

  /**
   * Load and render 3D avatar hologram
   */
  async loadHologram(data: HologramData): Promise<void> {
    // Clear existing hologram
    if (this.hologramMesh) {
      this.scene.remove(this.hologramMesh);
      this.hologramMesh.geometry.dispose();
      if (Array.isArray(this.hologramMesh.material)) {
        this.hologramMesh.material.forEach(m => m.dispose());
      } else {
        this.hologramMesh.material.dispose();
      }
    }

    // In production, load actual 3D model from Quantneon API
    // For now, create a placeholder holographic avatar
    const geometry = new THREE.SphereGeometry(1, 64, 64);

    // Holographic material with transparency and glow
    const material = new THREE.MeshPhongMaterial({
      color: 0x00ffff,
      emissive: 0x0044ff,
      transparent: true,
      opacity: 0.85,
      wireframe: false,
      shininess: 100,
      specular: 0xffffff
    });

    this.hologramMesh = new THREE.Mesh(geometry, material);

    // Apply position, rotation, scale
    if (data.position) {
      this.hologramMesh.position.set(data.position.x, data.position.y, data.position.z);
    }
    if (data.rotation) {
      this.hologramMesh.rotation.set(data.rotation.x, data.rotation.y, data.rotation.z);
    }
    if (data.scale) {
      this.hologramMesh.scale.setScalar(data.scale);
    }

    this.scene.add(this.hologramMesh);
  }

  /**
   * Update hologram position (called by physics engine)
   */
  updateHologramPosition(position: { x: number; y: number; z: number }): void {
    if (this.hologramMesh) {
      this.hologramMesh.position.set(position.x, position.y, position.z);
    }
  }

  /**
   * Update hologram rotation (for natural animation)
   */
  updateHologramRotation(rotation: { x: number; y: number; z: number }): void {
    if (this.hologramMesh) {
      this.hologramMesh.rotation.set(rotation.x, rotation.y, rotation.z);
    }
  }

  /**
   * Start rendering loop
   */
  startRenderLoop(): void {
    if (this.animationFrameId !== null) return;

    const animate = () => {
      this.animationFrameId = requestAnimationFrame(animate);

      // Gentle rotation for hologram effect
      if (this.hologramMesh) {
        this.hologramMesh.rotation.y += 0.005;
      }

      this.renderer.render(this.scene, this.camera);
    };

    animate();
  }

  /**
   * Stop rendering loop
   */
  stopRenderLoop(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * Handle window resize
   */
  private handleResize = (): void => {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(width, height);
  };

  /**
   * Dispose and cleanup resources
   */
  dispose(): void {
    this.stopRenderLoop();

    window.removeEventListener('resize', this.handleResize);

    if (this.hologramMesh) {
      this.scene.remove(this.hologramMesh);
      this.hologramMesh.geometry.dispose();
      if (Array.isArray(this.hologramMesh.material)) {
        this.hologramMesh.material.forEach(m => m.dispose());
      } else {
        this.hologramMesh.material.dispose();
      }
    }

    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }

  /**
   * Get current scene for advanced customization
   */
  getScene(): THREE.Scene {
    return this.scene;
  }

  /**
   * Get current camera for advanced control
   */
  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }
}
