import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { surfaceUV, type MaterialSet } from './materials';
import { portalMaterial, type Portal } from './room-visual';
import { CEILING_LIGHT, CEILING_PANEL_SIZE } from './lighting';
import { DOOR_HEIGHT, DOOR_WIDTH, EXIT_TUNNEL_LENGTH, EXIT_TUNNEL_WALLS, EXIT_TUNNEL_WIDTH, portalAngle, portalPosition, ROOM_HEIGHT } from './world';

/** A fixed finale scene, outside the ball-controlled room network. */
export function createExitTunnel(source: MaterialSet) {
  RectAreaLightUniformsLib.init();
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xffffff);
  const fog = new THREE.Fog(0xffffff, EXIT_TUNNEL_LENGTH * .75, EXIT_TUNNEL_LENGTH + 2); scene.fog = fog;
  const surface = (base: THREE.MeshStandardMaterial) => new THREE.MeshStandardMaterial({
    color: base.color, map: base.map, normalMap: base.normalMap, normalScale: base.normalScale.clone(),
    roughness: base.roughness, roughnessMap: base.roughnessMap,
  });
  const wall = surface(source.wall), floor = surface(source.floor), ceiling = surface(source.ceiling);
  for (const box of EXIT_TUNNEL_WALLS) {
    const geometry = new THREE.BoxGeometry(...box.size); geometry.translate(...box.position);
    const mesh = new THREE.Mesh(surfaceUV(geometry), wall); mesh.name = 'tunnel-wall'; scene.add(mesh);
  }
  const floorGeometry = new THREE.PlaneGeometry(EXIT_TUNNEL_WIDTH, EXIT_TUNNEL_LENGTH);
  floorGeometry.rotateX(-Math.PI / 2); floorGeometry.translate(0, 0, EXIT_TUNNEL_LENGTH / 2);
  const carpet = new THREE.Mesh(surfaceUV(floorGeometry), floor); carpet.name = 'tunnel-floor'; scene.add(carpet);
  const ceilingGeometry = new THREE.PlaneGeometry(EXIT_TUNNEL_WIDTH, EXIT_TUNNEL_LENGTH);
  ceilingGeometry.rotateX(Math.PI / 2); ceilingGeometry.translate(0, ROOM_HEIGHT, EXIT_TUNNEL_LENGTH / 2);
  const tiles = new THREE.Mesh(surfaceUV(ceilingGeometry), ceiling); tiles.name = 'tunnel-ceiling'; scene.add(tiles);

  const lamp = new THREE.Mesh(new THREE.PlaneGeometry(CEILING_PANEL_SIZE, CEILING_PANEL_SIZE),
    new THREE.MeshBasicMaterial({ color: source.lamp.color, map: source.lamp.map }));
  lamp.name = 'tunnel-ceiling-lamp'; lamp.rotation.x = Math.PI / 2; lamp.position.set(0, ROOM_HEIGHT - .004, 1.3); scene.add(lamp);
  const entryLight = new THREE.SpotLight(CEILING_LIGHT.color, 1.5, 12, CEILING_LIGHT.angle, CEILING_LIGHT.penumbra, 2);
  entryLight.position.set(0, CEILING_LIGHT.height, 1.3); entryLight.target.position.set(0, 0, 1.3);
  scene.add(entryLight, entryLight.target, new THREE.AmbientLight(0xffffff, .018));
  // The luminous exit opening illuminates the empty corridor analytically.
  // Its growing solid angle makes the approaching walls and carpet brighter.
  const exitLight = new THREE.RectAreaLight(0xffffff, 5000, DOOR_WIDTH, DOOR_HEIGHT);
  exitLight.position.set(0, DOOR_HEIGHT / 2, EXIT_TUNNEL_LENGTH + .16); scene.add(exitLight);
  const whiteFloor = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  whiteFloor.rotation.x = -Math.PI / 2; whiteFloor.position.z = EXIT_TUNNEL_LENGTH + 1000;
  whiteFloor.name = 'white-space-floor'; scene.add(whiteFloor);

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), portalMaterial());
  mesh.scale.set(DOOR_WIDTH, DOOR_HEIGHT, 1); mesh.position.y = DOOR_HEIGHT / 2; mesh.renderOrder = -1; scene.add(mesh);
  const portal: Portal = { side: 0, mesh, to: null, transform: new THREE.Matrix4(), normal: { x: 0, z: -1 },
    center: { x: 0, z: 0 }, distance: 0, receivingDistance: 0 };
  const transforms = Array.from({ length: 4 }, (_, side) => {
    const from = portalPosition('A', side);
    return new THREE.Matrix4().makeRotationY(-portalAngle({ room: 'A', side }, { room: 'A', side: 0 }))
      .multiply(new THREE.Matrix4().makeTranslation(-from.x, 0, -from.z));
  });
  const returnTransforms = transforms.map(transform => transform.clone().invert());
  // Match the portal's linear buffer before converting the main view to sRGB.
  const screenScene = new THREE.Scene(), screenCamera = new THREE.Camera();
  const screenMaterial = new THREE.ShaderMaterial({
    uniforms: { image: { value: null } }, depthTest: false, depthWrite: false, toneMapped: false,
    vertexShader: 'varying vec2 imageUv; void main() { imageUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: `uniform sampler2D image; varying vec2 imageUv;
      void main() {
        gl_FragColor = texture2D(image, imageUv);
        #include <colorspace_fragment>
      }`,
  });
  screenScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), screenMaterial));
  scene.updateMatrixWorld(true); scene.traverse(object => { object.matrixAutoUpdate = false; });
  return { scene, fog, portal, transforms, returnTransforms, exitLight, screenScene, screenCamera, screenMaterial };
}
