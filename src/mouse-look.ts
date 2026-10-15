/** Sum relative input for the nearest render, without filtering or interpolation. */
export class MouseLook {
  private x = 0;
  private y = 0;
  private readonly delta = { x: 0, y: 0 };

  reset() { this.x = this.y = 0; }

  push(x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.x += x; this.y += y;
  }

  consume() {
    this.delta.x = this.x; this.delta.y = this.y;
    this.reset();
    return this.delta;
  }
}
