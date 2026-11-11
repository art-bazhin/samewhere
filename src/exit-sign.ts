import * as THREE from 'three';
import { DOOR_HEIGHT } from './world';
import { withDistanceFade } from './visibility';
import type { RoomVisual } from './room-visual';

/** Four reusable panels; their visibility is rebound for each recursive room view. */
export function createExitSigns(room: RoomVisual) {
  const canvas = document.createElement('canvas'); canvas.height = 512;
  const context = canvas.getContext('2d')!;
  const font = 'bold 350px Arial, sans-serif'; context.font = font;
  const text = context.measureText('EXIT'), padding = (canvas.height - text.actualBoundingBoxAscent - text.actualBoundingBoxDescent) / 2;
  canvas.width = Math.round(text.actualBoundingBoxLeft + text.actualBoundingBoxRight + padding * 2);
  context.fillStyle = '#f5f5ec'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#202522'; context.lineWidth = 8; context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  context.fillStyle = '#00963e'; context.fillRect(24, 24, canvas.width - 48, canvas.height - 48);
  context.fillStyle = '#ffffff'; context.font = font;
  context.fillText('EXIT', padding + text.actualBoundingBoxLeft, padding + text.actualBoundingBoxAscent);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const face = withDistanceFade(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  const frame = withDistanceFade(new THREE.MeshBasicMaterial({ color: 0x202522, toneMapped: false }));
  // Keep the diagnostic T toggle from erasing readable gameplay signage.
  face.userData.keepTexture = true;
  const signs = room.walls.map((wall, side) => {
    const group = new THREE.Group(); group.name = 'exit-sign'; group.userData.side = side;
    group.position.set(0, DOOR_HEIGHT + .38, .019); wall.solid.parent!.add(group);
    // Put the artwork on the box's front face, without overlapping surfaces
    // that could z-fight in distant recursive views.
    const height = .28 * .8;
    const geometry = new THREE.BoxGeometry(height * canvas.width / canvas.height, height, .014 * .8); geometry.clearGroups();
    geometry.addGroup(0, 24, 0); geometry.addGroup(24, 6, 1); geometry.addGroup(30, 6, 0);
    group.add(new THREE.Mesh(geometry, [frame, face]));
    group.updateMatrixWorld(true); group.traverse(object => { object.matrixAutoUpdate = false; }); group.visible = false;
    return group;
  });
  return {
    signs,
    show(side: number | null) { signs.forEach((sign, index) => { sign.visible = index === side; }); },
    dispose() { texture.dispose(); },
  };
}
