import * as THREE from 'three';

interface ChangingCaster { source: THREE.Mesh; proxy: THREE.Mesh; bounds: THREE.Sphere }

function visibleInScene(object: THREE.Object3D) {
  for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) return false;
  return true;
}

/** Exact shadow geometry, batched once at load time; visible/pickable meshes stay separate. */
export class RoomShadows {
  readonly scene = new THREE.Scene();
  private readonly material = new THREE.MeshBasicMaterial();
  private readonly changing: ChangingCaster[] = [];
  private readonly geometry: THREE.BufferGeometry;
  private readonly cones: { light: THREE.SpotLight; position: THREE.Vector3; direction: THREE.Vector3; sin: number; cos: number }[];
  private readonly offset = new THREE.Vector3();

  constructor(source: THREE.Scene, lights: THREE.SpotLight[], moving: Set<THREE.Object3D>) {
    const fixed: THREE.Mesh[] = [];
    source.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !object.castShadow) return;
      let changes = false;
      for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (moving.has(parent)) { changes = true; break; }
      if (!changes) { fixed.push(object); return; }
      const proxy = new THREE.Mesh(object.geometry, this.material);
      proxy.matrix.copy(object.matrixWorld); proxy.matrixAutoUpdate = false;
      proxy.castShadow = true; proxy.visible = visibleInScene(object); this.scene.add(proxy);
      object.geometry.computeBoundingSphere();
      const bounds = object.geometry.boundingSphere!.clone().applyMatrix4(object.matrixWorld);
      bounds.radius += .01; // Conservative margin for shadow bias and rasterization.
      this.changing.push({ source: object, proxy, bounds });
    });
    // Depth rendering needs positions only. Bake the original transforms and
    // triangles (including the saucers), rather than approximating silhouettes.
    const count = fixed.reduce((sum, mesh) => sum + (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count), 0);
    const positions = new Float32Array(count * 3), point = new THREE.Vector3(); let cursor = 0;
    for (const mesh of fixed) {
      const position = mesh.geometry.getAttribute('position'), index = mesh.geometry.index;
      for (let i = 0; i < (index?.count ?? position.count); i++) {
        point.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
        point.toArray(positions, cursor); cursor += 3;
      }
    }
    this.geometry = new THREE.BufferGeometry(); this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const batch = new THREE.Mesh(this.geometry, this.material); batch.castShadow = true; this.scene.add(batch);
    this.scene.updateMatrixWorld(true); this.scene.matrixWorldAutoUpdate = false;
    this.cones = lights.map(light => {
      light.shadow.updateMatrices(light);
      const position = light.getWorldPosition(new THREE.Vector3());
      const direction = light.target.getWorldPosition(new THREE.Vector3()).sub(position).normalize();
      return { light, position, direction, sin: Math.sin(light.angle), cos: Math.cos(light.angle) };
    });
  }

  sync() {
    for (const caster of this.changing) {
      const visible = visibleInScene(caster.source);
      if (visible === caster.proxy.visible) continue;
      caster.proxy.visible = visible;
      for (const { light, position, direction, sin, cos } of this.cones) {
        if (!light.shadow.getFrustum().intersectsSphere(caster.bounds)) continue;
        this.offset.subVectors(caster.bounds.center, position);
        const axial = this.offset.dot(direction), radial = Math.sqrt(Math.max(0, this.offset.lengthSq() - axial * axial));
        // The shadow camera has a square frustum; the actual spotlight is round.
        if (radial * cos - axial * sin <= caster.bounds.radius) light.shadow.needsUpdate = true;
      }
    }
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
