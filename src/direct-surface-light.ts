import * as THREE from 'three';
import { chartTriangles, prepareSurfaceLayout, type SurfaceChart, type SurfaceLayout } from './lightmap-layout';
import { BALL_RADIUS, PEDESTAL_HEIGHT, portalPosition, ROOM_IDS, SOCKET_DEPTH, SOCKET_OPENING, wallNormal, type RoomId } from './world';

interface DirectSurface { layout: Pick<SurfaceLayout, 'width' | 'height'>; target: THREE.WebGLRenderTarget; scene: THREE.Scene; passages: THREE.Vector4[]; active: number[] }

/** Fine direct irradiance is rendered only when a connection changes. Normal
 * frames need one bilinear lookup, independent of the number of neighbor lamps. */
export class DirectSurfaceLight {
  readonly fields: Record<RoomId, DirectSurface>;
  readonly uniform = { value: null as THREE.Texture | null };
  updates = 0;
  private readonly material: THREE.ShaderMaterial;
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly bakePassage = { value: -1 };
  private readonly bakeLocalStart = { value: 0 };
  private readonly bakeLocalCount = { value: 0 };

  constructor(rooms: Record<RoomId, { scene: THREE.Scene }>, uniforms: Record<string, THREE.IUniform>, declarations: string, shadows: string) {
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, bakePassage: this.bakePassage, bakeLocalStart: this.bakeLocalStart, bakeLocalCount: this.bakeLocalCount },
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: `attribute vec2 directUv; attribute vec4 directBounds; varying vec4 bakeBounds; varying vec3 directWorldPosition; varying vec3 bakeNormal;
        void main() { directWorldPosition = position; bakeNormal = normal; bakeBounds = directBounds; gl_Position = vec4(directUv * 2. - 1., 0., 1.); }`,
      fragmentShader: `${declarations}\n#include <packing>\n${shadows}
        varying vec3 bakeNormal; varying vec4 bakeBounds; uniform int bakePassage, bakeLocalStart, bakeLocalCount;
        void main() {
          if (any(lessThan(gl_FragCoord.xy, bakeBounds.xy)) || any(greaterThanEqual(gl_FragCoord.xy, bakeBounds.zw))) discard;
          vec3 normal = normalize(bakeNormal);
          float light = 0.;
          if (bakePassage < 0) light = directNeighborLight(directWorldPosition, normal, normal);
          else for (int lamp = 0; lamp < 28; lamp++) {
            if (lamp >= directNeighborCount) break;
            // Both halves must use the same filtered depth silhouettes. A hard
            // aperture cut on only the transported half biases edge texels.
            light += directVisibility(lamp, directWorldPosition, normal)
              * directEnergy(directWorldPosition, normal, directRecord(lamp, 0).xy);
          }
          if (bakePassage >= 0) for (int lamp = 0; lamp < 7; lamp++) {
            if (lamp >= bakeLocalCount) break;
            int index = bakeLocalStart + lamp;
            light += directVisibility(index, directWorldPosition, normal) * directEnergy(directWorldPosition, normal, directRecord(index, 0).xy);
          }
          gl_FragColor = vec4(light, 0., 0., 1.);
        }`,
    });
    this.fields = Object.fromEntries(ROOM_IDS.map(room => {
      const layout = prepareSurfaceLayout(rooms[room].scene, room, true), scene = new THREE.Scene(), passages: THREE.Vector4[] = [];
      const positions: number[] = [], normals: number[] = [], uvs: number[] = [], bounds: number[] = [];
      for (const chart of layout.charts) {
        if (chart.passage !== undefined) {
          const p = portalPosition(room, chart.passage), n = wallNormal(room, chart.passage);
          passages[chart.passage] = new THREE.Vector4((chart.x + 1.5 - chart.min.x / chart.step.x) / layout.width,
            (chart.y + 1.5 - chart.min.y / chart.step.y) / layout.height, 1 / (chart.step.x * layout.width), 1 / (chart.step.y * layout.height));
          const xs = [chart.min.x - chart.step.x, chart.min.x + (chart.width - 2) * chart.step.x];
          const ys = [-chart.step.y, (chart.height - 2) * chart.step.y];
          const corners = [new THREE.Vector2(xs[0], ys[0]), new THREE.Vector2(xs[1], ys[0]), new THREE.Vector2(xs[1], ys[1]), new THREE.Vector2(xs[0], ys[1])];
          const vertex = (v: THREE.Vector2) => new THREE.Vector3(p.x - n.x * v.y - n.z * v.x, 0, p.z - n.z * v.y + n.x * v.x);
          const passPositions: number[] = [], passNormals: number[] = [], passUvs: number[] = [], passBounds: number[] = [];
          for (const indices of [[0, 1, 2], [0, 2, 3]]) this.triangle(layout, chart, indices.map(i => corners[i]), indices.map(i => vertex(corners[i])),
            indices.map(() => new THREE.Vector3(0, 1, 0)), passPositions, passNormals, passUvs, passBounds);
          const mesh = this.mesh(passPositions, passNormals, passUvs, passBounds); mesh.userData.passage = chart.passage; scene.add(mesh);
        } else if (chart.curvedMesh) {
          // These charts contain only 8×6 useful samples. Rasterizing every
          // triangle of each shared 64×48 sphere would duplicate megabytes of
          // geometry without adding lighting detail.
          const object = chart.curvedMesh, normalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);
          const sample = (uv: THREE.Vector2) => {
            let point: THREE.Vector3, normal: THREE.Vector3;
            if (object.name === 'socket-ball') {
              const phi = uv.x * Math.PI * 2, theta = (1 - uv.y) * Math.PI;
              normal = new THREE.Vector3(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
              point = normal.clone().multiplyScalar(BALL_RADIUS);
            } else {
              const t = 1 - uv.y, radius = SOCKET_OPENING * t, phi = uv.x * Math.PI * 2;
              point = new THREE.Vector3(radius * Math.sin(phi), -SOCKET_DEPTH * (1 - t * t) ** 2 * (1 + t * t), radius * Math.cos(phi));
              const slope = 2 * SOCKET_DEPTH / (SOCKET_OPENING * SOCKET_OPENING) * (1 + 2 * t * t - 3 * t ** 4);
              normal = new THREE.Vector3(-slope * point.x, 1, -slope * point.z).normalize();
            }
            point.applyMatrix4(object.matrixWorld); normal.applyMatrix3(normalMatrix).normalize();
            if (object.name === 'socket-bowl') point.y = Math.max(point.y, PEDESTAL_HEIGHT + .002);
            return { point, normal };
          };
          for (let y = 0; y < 5; y++) for (let x = 0; x < 7; x++) {
            const uv = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].map(([u, v]) =>
              new THREE.Vector2(chart.min.x + (chart.max.x - chart.min.x) * u / 7, chart.min.y + (chart.max.y - chart.min.y) * v / 5));
            for (const indices of [[0, 1, 2], [0, 2, 3]]) {
              const vertices = indices.map(i => sample(uv[i]));
              this.triangle(layout, chart, indices.map(i => uv[i]), vertices.map(v => v.point), vertices.map(v => v.normal), positions, normals, uvs, bounds);
            }
          }
        } else for (const triangle of chartTriangles(chart)) {
          const points = triangle.positions.map(p => p.clone());
          if (triangle.mesh.name === 'socket-bowl') points.forEach(p => { p.y = Math.max(p.y, PEDESTAL_HEIGHT + .002); });
          this.triangle(layout, chart, triangle.uv, points, triangle.normals, positions, normals, uvs, bounds);
        }
      }
      const mesh = this.mesh(positions, normals, uvs, bounds); mesh.userData.passage = -1; scene.add(mesh);
      const target = new THREE.WebGLRenderTarget(layout.width, layout.height,
        { type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      return [room, { layout: { width: layout.width, height: layout.height }, target, scene, passages, active: [] as number[] }];
    })) as Record<RoomId, DirectSurface>;
    this.uniform.value = this.fields.A.target.texture;
  }
  private mesh(positions: number[], normals: number[], uv: number[], bounds: number[]) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('directUv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setAttribute('directBounds', new THREE.Float32BufferAttribute(bounds, 4));
    const mesh = new THREE.Mesh(geometry, this.material); mesh.frustumCulled = false; return mesh;
  }
  private triangle(layout: SurfaceLayout, chart: SurfaceChart, coordinates: THREE.Vector2[], points: THREE.Vector3[], directions: THREE.Vector3[],
    positions: number[], normals: number[], uvs: number[], bounds: number[]) {
    const uv = coordinates.map(p => new THREE.Vector2(chart.x + 1.5 + (p.x - chart.min.x) / chart.step.x, chart.y + 1.5 + (p.y - chart.min.y) / chart.step.y));
    const area = (uv[1].x - uv[0].x) * (uv[2].y - uv[0].y) - (uv[1].y - uv[0].y) * (uv[2].x - uv[0].x);
    if (Math.abs(area) < 1.e-10) return;
    // Conservative one-texel padding in atlas space. Extrapolating the original
    // plane keeps real triangle interiors exact and prevents dark chart edges.
    const edges = uv.map((a, i) => { const b = uv[(i + 1) % 3]; return new THREE.Vector2(b.y - a.y, a.x - b.x).normalize().multiplyScalar(Math.sign(area)); });
    uv.forEach((p, i) => {
      const a = edges[(i + 2) % 3], b = edges[i], expanded = p.clone().add(a.clone().add(b).multiplyScalar(1 / Math.max(.02, 1 + a.dot(b))));
      const dx = expanded.x - uv[0].x, dy = expanded.y - uv[0].y;
      const v = (dx * (uv[2].y - uv[0].y) - dy * (uv[2].x - uv[0].x)) / area;
      const w = ((uv[1].x - uv[0].x) * dy - (uv[1].y - uv[0].y) * dx) / area;
      const point = points[0].clone().multiplyScalar(1 - v - w).addScaledVector(points[1], v).addScaledVector(points[2], w);
      const normal = directions[0].clone().multiplyScalar(1 - v - w).addScaledVector(directions[1], v).addScaledVector(directions[2], w).normalize();
      positions.push(point.x, point.y, point.z); normals.push(normal.x, normal.y, normal.z); uvs.push(expanded.x / layout.width, expanded.y / layout.height);
      bounds.push(chart.x, chart.y, chart.x + chart.width, chart.y + chart.height);
    });
  }
  render(renderer: THREE.WebGLRenderer, room: RoomId, bind: () => void, starts: Int32Array, counts: Int32Array, preparing = false) {
    const field = this.fields[room]; bind();
    for (const object of field.scene.children) {
      const side = object.userData.passage as number, index = field.active.indexOf(side);
      object.visible = preparing || side < 0 || index >= 0;
      object.onBeforeRender = () => {
        this.bakePassage.value = side; this.bakeLocalStart.value = index < 0 ? 0 : starts[index]; this.bakeLocalCount.value = index < 0 ? 0 : counts[index];
        this.material.uniformsNeedUpdate = true;
      };
    }
    // The target's viewport already spans its physical texels. setViewport()
    // scales logical pixels by DPR and would misalign UV charts on Retina.
    renderer.setRenderTarget(field.target);
    renderer.setClearColor(0, 0); renderer.clear(); renderer.render(field.scene, this.camera); this.updates++;
  }
  dispose() {
    this.material.dispose();
    for (const field of Object.values(this.fields)) { field.target.dispose(); field.scene.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose(); }); }
  }
}
