import * as THREE from 'three';
import { DOOR_HEIGHT } from './world';
import { withDistanceFade } from './visibility';
import type { RoomVisual } from './room-visual';

/** Four reusable panels; their visibility is rebound for each recursive room view. */
export function createExitSigns(room: RoomVisual) {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 512;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#f5f5ec'; context.fillRect(0, 0, 1024, 512);
  context.strokeStyle = '#202522'; context.lineWidth = 8; context.strokeRect(4, 4, 1016, 504);
  context.fillStyle = '#00963e'; context.fillRect(24, 24, 976, 464);
  context.fillStyle = '#ffffff'; context.font = 'bold 260px Arial, sans-serif';
  context.fillText('Exit', 65, 355, 540);
  context.strokeStyle = '#ffffff'; context.lineWidth = 7;
  context.beginPath(); context.moveTo(735, 310); context.lineTo(735, 85); context.lineTo(950, 85);
  context.lineTo(950, 395); context.lineTo(920, 425); context.lineTo(705, 425); context.lineTo(735, 395); context.lineTo(735, 350); context.stroke();
  context.beginPath(); context.arc(825, 151, 30, 0, Math.PI * 2); context.fill();
  context.fill(new Path2D('M790 190 L858 190 L888 244 L930 244 L930 273 L870 273 L839 230 L825 285 L881 349 L853 372 L790 309 L780 345 L739 407 L708 387 L750 311 L762 239 L735 239 L702 284 L675 265 L718 204 L762 195 Z'));
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
    const geometry = new THREE.BoxGeometry(.56, .28, .014); geometry.clearGroups();
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
