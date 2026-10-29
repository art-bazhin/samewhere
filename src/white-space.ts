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
  const glow = {
    scene: new THREE.Scene(), camera: new THREE.Camera(),
    material: new THREE.ShaderMaterial({
      uniforms: { amount: { value: 0 } }, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0., 1.); }',
      fragmentShader: 'uniform float amount; void main() { gl_FragColor = vec4(1., 1., 1., amount); }',
    }),
  };
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), glow.material); glow.scene.add(screen);
  return { scene, portal, glow, dispose() { mesh.material.dispose(); screen.geometry.dispose(); glow.material.dispose(); } };
}
