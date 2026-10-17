import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { bakingLayout } from '../src/lightmap-layout';
import { PEDESTAL_TEXTURE_SIZE } from '../src/materials';
import { pedestalOutline, ROOMS } from '../src/world';

const layout = bakingLayout('G');
const bodies = [...new Set(layout.charts.flatMap(chart => chart.triangles.map(t => t.mesh)))].filter(mesh => mesh.name === 'pedestal-body');
const fixtures = ROOMS.G.pedestals.map(p => ({ ...p, mesh: bodies.find(mesh => Math.hypot(mesh.parent!.position.x - p.x, mesh.parent!.position.z - p.z) < .00001)! }));

test('all seven pedestal outlines have non-mirrored UVs on every outer side triangle', () => {
  assert.equal(bodies.length, 7);
  for (const { controls, mesh } of fixtures) {
    const g = mesh.geometry, positions = g.getAttribute('position'), normals = g.getAttribute('normal'), uv = g.getAttribute('uv');
    const outline = pedestalOutline(controls); let sides = 0;
    for (let i = 0; i < (g.index?.count ?? positions.count); i += 3) {
      const indices = [0, 1, 2].map(k => g.index ? g.index.getX(i + k) : i + k);
      const normal = new THREE.Vector3().fromBufferAttribute(normals, indices[0]);
      if (Math.abs(normal.y) > .1) continue;
      const p = indices.map(index => new THREE.Vector3().fromBufferAttribute(positions, index));
      const center = p[0].clone().add(p[1]).add(p[2]).divideScalar(3);
      const outer = outline.some((a, edge) => {
        const b = outline[(edge + 1) % outline.length], dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
        const along = ((center.x - a.x) * dx + (center.z - a.z) * dz) / length;
        return (normal.x * dz - normal.z * dx) / length > .9999 && along >= 0 && along <= length &&
          Math.abs((center.x - a.x) * dz - (center.z - a.z) * dx) / length < .00001;
      });
      if (!outer) continue;
      const t = indices.map(index => new THREE.Vector2(uv.getX(index), uv.getY(index)));
      const uvArea = t[1].clone().sub(t[0]).cross(t[2].clone().sub(t[0]));
      const area = p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0])).dot(normal);
      assert.ok(uvArea * area > 0, `${controls}: mirrored or collapsed triangle at ${center.toArray()}`); sides++;
    }
    assert.equal(sides, outline.length * 2, `${controls}: every outer prism face was checked`);
  }
});

test('neighboring pedestal faces meet continuously, including the final periodic wrap', () => {
  for (const { controls, mesh } of fixtures) {
    const g = mesh.geometry, positions = g.getAttribute('position'), normals = g.getAttribute('normal'), uv = g.getAttribute('uv');
    const outline = pedestalOutline(controls);
    const ends = outline.map((a, edge) => {
      const b = outline[(edge + 1) % outline.length], dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      const values = [a, b].map(point => {
        for (let i = 0; i < positions.count; i++) if (Math.abs(normals.getY(i)) < .1 &&
          (normals.getX(i) * dz - normals.getZ(i) * dx) / length > .9999 &&
          Math.hypot(positions.getX(i) - point.x, positions.getZ(i) - point.z) < .00001) return uv.getX(i) * 2 / PEDESTAL_TEXTURE_SIZE;
        assert.fail(`${controls}: missing side endpoint`);
      });
      assert.ok(values[1] < values[0], `${controls}: U follows the same outward orientation`);
      return values;
    });
    for (let edge = 0; edge < ends.length; edge++) {
      const delta = ends[edge][1] - ends[(edge + 1) % ends.length][0];
      assert.ok(Math.abs(delta - Math.round(delta)) < .00001, `${controls}: seam at corner ${edge}`);
      if (edge < ends.length - 1) assert.ok(Math.abs(delta) < .00001, `${controls}: adjacent faces restart the texture`);
    }
  }
});

test('pedestal top and vertical texture scale retain their existing projections', () => {
  for (const { mesh } of fixtures) {
    const positions = mesh.geometry.getAttribute('position'), normals = mesh.geometry.getAttribute('normal'), uv = mesh.geometry.getAttribute('uv');
    for (let i = 0; i < positions.count; i++) {
      if (normals.getY(i) > .999) {
        assert.ok(Math.abs(uv.getX(i) - positions.getX(i) / 2) < .000001);
        assert.ok(Math.abs(uv.getY(i) + positions.getZ(i) / 2) < .000001);
      } else if (Math.abs(normals.getY(i)) < .1) assert.ok(Math.abs(uv.getY(i) - positions.getY(i) / 2) < .000001);
    }
  }
});
