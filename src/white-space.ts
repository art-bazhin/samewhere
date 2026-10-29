import * as THREE from 'three';
import { galleryRoute } from './gallery';
import { type Portal, type RoomVisual } from './room-visual';

/** Empty white surroundings, with only a view back into the gallery. No lights. */
export function createWhiteSpace(room: RoomVisual) {
  const source = room.portals[galleryRoute().at(-1)!.side];
  const mesh = source.mesh.clone(); mesh.material = source.mesh.material.clone();
  source.mesh.matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale);
  mesh.visible = true; mesh.rotateY(Math.PI); mesh.updateMatrix();
  const portal: Portal = { ...source, mesh, to: { room: 'A', side: source.side }, transform: new THREE.Matrix4(),
    normal: { x: -source.normal.x, z: -source.normal.z }, distance: -source.distance };
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xffffff); scene.add(mesh); scene.updateMatrixWorld(true);
  return { scene, portal, dispose: () => mesh.material.dispose() };
}
