import * as THREE from 'three';
import { EYE_HEIGHT, ROOM_HEIGHT, ROOMS } from './world';

/** Soft warm room reflections, prepared once; no moving cube cameras or mirrors. */
export function createRoomEnvironment(renderer: THREE.WebGLRenderer, diffuser: THREE.Texture) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x110f08);
  const wall = new THREE.MeshBasicMaterial({ color: 0x726039, side: THREE.BackSide });
  const carpet = new THREE.MeshBasicMaterial({ color: 0x8d7952 });
  const lamp = new THREE.MeshBasicMaterial({ map: diffuser, color: new THREE.Color(2.6, 2.4, 1.9), toneMapped: false });
  const shell = new THREE.Mesh(new THREE.BoxGeometry(10, ROOM_HEIGHT, 10), wall); shell.position.y = ROOM_HEIGHT / 2;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), carpet); floor.rotation.x = -Math.PI / 2;
  const panels = ROOMS.A.pedestals.map(({ x, z }) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(.55, .55), lamp);
    mesh.rotation.x = Math.PI / 2; mesh.position.set(x, ROOM_HEIGHT - .02, z); return mesh;
  });
  scene.add(shell, floor, ...panels);
  const generator = new THREE.PMREMGenerator(renderer), clipping = renderer.clippingPlanes; renderer.clippingPlanes = [];
  try { return generator.fromScene(scene, .08, .05, 30, { size: 128, position: new THREE.Vector3(0, EYE_HEIGHT, 0) }); }
  finally {
    renderer.clippingPlanes = clipping; generator.dispose();
    for (const mesh of [shell, floor, ...panels]) mesh.geometry.dispose();
    for (const material of [wall, carpet, lamp]) material.dispose();
  }
}
