import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import type {Pathfinding as PathfindingType} from 'three-pathfinding';

import {SimulatorEnvironment, SimulatorOptions} from './SimulatorOptions';

const DEFAULT_ZONE_ID = 'simulator';

type PathfindingConstructor = typeof import('three-pathfinding').Pathfinding;
type PathfindingNode = ReturnType<PathfindingType['getClosestNode']>;

const desiredGroundPosition = new THREE.Vector3();
const startGroundPosition = new THREE.Vector3();
const clampedGroundPosition = new THREE.Vector3();
const initialScenePosition = new THREE.Vector3();

export class SimulatorNavigation {
  enabled = false;
  ready = false;

  private Pathfinding?: PathfindingConstructor;
  private pathfinding?: PathfindingType;
  private zoneId = DEFAULT_ZONE_ID;
  private groupId: number | null = null;
  private currentNode: PathfindingNode | null = null;
  private eyeHeight = 1.5;

  get constrained() {
    return this.enabled && this.ready;
  }

  async init(options: SimulatorOptions) {
    this.enabled = options.navigation.enabled;
    this.eyeHeight = options.navigation.eyeHeight;
    const activeEnv =
      options.environments[options.activeEnvironmentIndex] ?? null;
    await this.setEnvironment(activeEnv, options);
  }

  async setEnvironment(
    environment: SimulatorEnvironment | null,
    options: SimulatorOptions
  ) {
    this.enabled = options.navigation.enabled;
    this.eyeHeight = options.navigation.eyeHeight;
    this.ready = false;
    this.groupId = null;
    this.currentNode = null;
    this.pathfinding = undefined;

    if (!this.enabled) return;
    if (!environment?.navMeshPath) {
      console.warn(
        'SimulatorNavigation: navigation is enabled, but the active environment has no navMeshPath.'
      );
      return;
    }

    try {
      initialScenePosition.set(
        options.initialScenePosition.x,
        options.initialScenePosition.y,
        options.initialScenePosition.z
      );
      const geometry = await this.loadGeometry(
        environment.navMeshPath,
        initialScenePosition
      );
      await this.setGeometry(geometry);
      geometry.dispose();
    } catch (error) {
      console.warn(
        `SimulatorNavigation: failed to load navmesh at ${environment.navMeshPath}.`,
        error
      );
    }
  }

  async setGeometry(geometry: THREE.BufferGeometry) {
    const Pathfinding = await this.loadPathfinding();
    this.pathfinding = new Pathfinding();
    this.pathfinding.setZoneData(this.zoneId, Pathfinding.createZone(geometry));
    this.ready = true;
    this.groupId = null;
    this.currentNode = null;
  }

  applyUserMovement(
    camera: THREE.Camera,
    desiredCameraPosition: THREE.Vector3
  ) {
    if (!this.constrained || !this.pathfinding) {
      camera.position.copy(desiredCameraPosition);
      return;
    }

    startGroundPosition.copy(camera.position);
    startGroundPosition.y -= this.eyeHeight;
    desiredGroundPosition.copy(desiredCameraPosition);
    desiredGroundPosition.y -= this.eyeHeight;

    if (this.groupId === null || this.currentNode === null) {
      this.groupId = this.pathfinding.getGroup(
        this.zoneId,
        startGroundPosition
      ) as number | null;
      if (this.groupId === null) {
        camera.position.copy(desiredCameraPosition);
        return;
      }
      this.currentNode = this.pathfinding.getClosestNode(
        startGroundPosition,
        this.zoneId,
        this.groupId,
        true
      );
      this.currentNode ??= this.pathfinding.getClosestNode(
        startGroundPosition,
        this.zoneId,
        this.groupId,
        false
      );
    }

    if (!this.currentNode || this.groupId === null) {
      camera.position.copy(desiredCameraPosition);
      return;
    }

    this.currentNode = this.pathfinding.clampStep(
      startGroundPosition,
      desiredGroundPosition,
      this.currentNode,
      this.zoneId,
      this.groupId,
      clampedGroundPosition
    );
    camera.position.set(
      clampedGroundPosition.x,
      clampedGroundPosition.y + this.eyeHeight,
      clampedGroundPosition.z
    );
  }

  findPathTo(
    startCameraPosition: THREE.Vector3,
    targetGroundPosition: THREE.Vector3
  ) {
    if (!this.constrained || !this.pathfinding) return null;
    const start = startGroundPosition.copy(startCameraPosition);
    start.y -= this.eyeHeight;
    const groupId = this.pathfinding.getGroup(this.zoneId, start) as
      | number
      | null;
    if (groupId === null) return null;
    return this.pathfinding.findPath(
      start,
      targetGroundPosition,
      this.zoneId,
      groupId
    );
  }

  private async loadGeometry(
    path: string,
    sceneOffset: THREE.Vector3
  ): Promise<THREE.BufferGeometry> {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(path);
    gltf.scene.position.copy(sceneOffset);
    gltf.scene.updateMatrixWorld(true);

    const navMesh = this.findFirstMesh(gltf.scene);

    if (!navMesh) {
      throw new Error('No mesh found in navmesh glTF/GLB.');
    }

    const geometry = navMesh.geometry.clone();
    geometry.applyMatrix4(navMesh.matrixWorld);
    return geometry;
  }

  private findFirstMesh(root: THREE.Object3D): THREE.Mesh | null {
    const queue = [root];
    while (queue.length > 0) {
      const object = queue.shift()!;
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) {
        return mesh;
      }
      queue.push(...object.children);
    }
    return null;
  }

  private async loadPathfinding() {
    if (!this.Pathfinding) {
      this.Pathfinding = (await import('three-pathfinding')).Pathfinding;
    }
    return this.Pathfinding;
  }
}
