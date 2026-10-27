import * as THREE from 'three';
import { createRoom } from './room-visual';
import { type MaterialSet } from './materials';
import { withDistanceFade, visibilityRange } from './visibility';
import { DOOR_HEIGHT, EXIT_TUNNEL_LENGTH, portalAngle, portalPosition } from './world';

/** Ordinary room architecture/materials; only the white exterior is special. */
export function createExitTunnel(source: MaterialSet, environment: THREE.Texture, optimizations: THREE.IUniform<boolean>) {
  const materials = Object.fromEntries(Object.entries(source).map(([key, original]) => {
    const material = original.clone();
    material.onBeforeCompile = original.onBeforeCompile.bind(original);
    const cache = original.customProgramCacheKey(); material.customProgramCacheKey = () => cache;
    return [key, material];
  })) as MaterialSet;
  const room = createRoom('T', materials, optimizations, environment), scene = room.scene;
  scene.background = new THREE.Color(0);
  room.walls.forEach(wall => { wall.solid.visible = false; wall.open.visible = true; });
  room.contactOpenings.value.fill(1);
  room.portals[1].mesh.visible = false;
  // The fixed bake includes the complete local fixture, including its spot share.
  room.shadowLights.forEach(light => { light.intensity = 0; light.castShadow = false; });
  scene.traverse(object => { if (object.name === 'ceiling-lamp') object.name = 'tunnel-ceiling-lamp'; });
  const surfaces = new Set<THREE.MeshStandardMaterial>();
  scene.traverse(object => { if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial) surfaces.add(object.material); });
  for (const material of surfaces) {
    const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      before(shader, renderer);
      shader.vertexShader = 'varying float tunnelZ;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        tunnelZ = (modelMatrix * vec4(transformed, 1.)).z;`);
      shader.fragmentShader = 'varying float tunnelZ;\n' + shader.fragmentShader;
      // Ambient room fill and ceiling emission fade with the only nearby lamp.
      // Actual local and transported illumination comes from the shared bake.
      shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', `
        float fill = max(1. - smoothstep(6., 24., tunnelZ), smoothstep(72., 96., tunnelZ));
        reflectedLight.indirectDiffuse *= fill; reflectedLight.indirectSpecular *= fill;
        totalEmissiveRadiance *= fill;
        #include <aomap_fragment>`);
    };
    material.customProgramCacheKey = () => `${key}:tunnel-fill`;
  }
  const exitLight = new THREE.SpotLight(0xffffff, 1800, 32, 1.2, .8, 2);
  exitLight.position.set(0, DOOR_HEIGHT / 2, EXIT_TUNNEL_LENGTH + 4);
  exitLight.target.position.set(0, DOOR_HEIGHT / 2, EXIT_TUNNEL_LENGTH - 1);
  exitLight.castShadow = true; exitLight.shadow.mapSize.set(2048, 2048);
  exitLight.shadow.camera.near = .1; exitLight.shadow.camera.far = exitLight.distance;
  exitLight.shadow.bias = -.00002; exitLight.shadow.normalBias = .0015;
  exitLight.shadow.autoUpdate = false; exitLight.shadow.needsUpdate = true;
  scene.add(exitLight, exitLight.target);
  const white = withDistanceFade(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), white);
  backdrop.rotation.y = Math.PI; backdrop.position.z = EXIT_TUNNEL_LENGTH + .2; scene.add(backdrop);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), white);
  floor.rotation.x = -Math.PI / 2; floor.position.z = EXIT_TUNNEL_LENGTH + 1000; scene.add(floor);
  const transforms = Array.from({ length: 4 }, (_, side) => {
    const from = portalPosition('A', side);
    return new THREE.Matrix4().makeRotationY(-portalAngle({ room: 'A', side }, { room: 'A', side: 0 }))
      .multiply(new THREE.Matrix4().makeTranslation(-from.x, 0, -from.z));
  });
  scene.updateMatrixWorld(true); scene.traverse(object => { object.matrixAutoUpdate = false; });
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
  return { room, scene, visibility: visibilityRange, portal: room.portals[0], transforms,
    returnTransforms: transforms.map(transform => transform.clone().invert()), exitLight, screenScene, screenCamera, screenMaterial };
}
