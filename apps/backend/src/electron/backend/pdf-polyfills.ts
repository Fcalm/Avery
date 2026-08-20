/**
 * 为纯 Node 的 Backend Utility Process 提供 pdf-parse 依赖的浏览器几何全局。
 * Electron 主进程由 Chromium 注入 DOMMatrix/ImageData，utilityProcess 缺失；这里提供最小但数学正确的 2D 仿射实现。
 */

/** 构造一个标准 2D 仿射矩阵类；pdf-parse 内部仅使用文本提取相关的矩阵运算。 */
function CreateDOMMatrixPolyfill(): any {
  class DOMMatrixPolyfill {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;

    constructor(init?: any) {
      if (init === undefined || init === null) return;
      if (Array.isArray(init)) {
        if (init.length === 6) {
          [this.a, this.b, this.c, this.d, this.e, this.f] = init;
        } else if (init.length === 16) {
          [this.a, this.b, , , this.c, this.d, , , , , , , this.e, this.f, ,] = init;
        }
        return;
      }
      if (typeof init === 'string') {
        this.setMatrixValue(init);
        return;
      }
      if (typeof init === 'object' && typeof init.a === 'number') {
        this.a = init.a;
        this.b = init.b;
        this.c = init.c;
        this.d = init.d;
        this.e = init.e;
        this.f = init.f;
      }
    }

    get m11(): number { return this.a; }
    set m11(value: number) { this.a = value; }
    get m12(): number { return this.b; }
    set m12(value: number) { this.b = value; }
    get m21(): number { return this.c; }
    set m21(value: number) { this.c = value; }
    get m22(): number { return this.d; }
    set m22(value: number) { this.d = value; }
    get m41(): number { return this.e; }
    set m41(value: number) { this.e = value; }
    get m42(): number { return this.f; }
    set m42(value: number) { this.f = value; }
    get m13(): number { return 0; }
    get m14(): number { return 0; }
    get m23(): number { return 0; }
    get m24(): number { return 0; }
    get m31(): number { return 0; }
    get m32(): number { return 0; }
    get m33(): number { return 1; }
    get m34(): number { return 0; }
    get m43(): number { return 0; }
    get m44(): number { return 1; }
    get is2D(): boolean { return true; }
    get isIdentity(): boolean { return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0; }

    multiply(other: DOMMatrixPolyfill): DOMMatrixPolyfill {
      return new DOMMatrixPolyfill([
        this.a * other.a + this.c * other.b,
        this.b * other.a + this.d * other.b,
        this.a * other.c + this.c * other.d,
        this.b * other.c + this.d * other.d,
        this.a * other.e + this.c * other.f + this.e,
        this.b * other.e + this.d * other.f + this.f,
      ]);
    }

    multiplySelf(other: DOMMatrixPolyfill): DOMMatrixPolyfill {
      const result = this.multiply(other);
      this.a = result.a;
      this.b = result.b;
      this.c = result.c;
      this.d = result.d;
      this.e = result.e;
      this.f = result.f;
      return this;
    }

    translate(tx: number, ty = 0): DOMMatrixPolyfill {
      return this.multiply(new DOMMatrixPolyfill([1, 0, 0, 1, tx, ty]));
    }

    translateSelf(tx: number, ty = 0): DOMMatrixPolyfill {
      const result = this.translate(tx, ty);
      this.a = result.a;
      this.b = result.b;
      this.c = result.c;
      this.d = result.d;
      this.e = result.e;
      this.f = result.f;
      return this;
    }

    scale(sx: number, sy = sx): DOMMatrixPolyfill {
      return this.multiply(new DOMMatrixPolyfill([sx, 0, 0, sy, 0, 0]));
    }

    scaleSelf(sx: number, sy = sx): DOMMatrixPolyfill {
      const result = this.scale(sx, sy);
      this.a = result.a;
      this.b = result.b;
      this.c = result.c;
      this.d = result.d;
      this.e = result.e;
      this.f = result.f;
      return this;
    }

    rotate(angleDeg: number): DOMMatrixPolyfill {
      const radians = (angleDeg * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      return this.multiply(new DOMMatrixPolyfill([cos, sin, -sin, cos, 0, 0]));
    }

    rotateSelf(angleDeg: number): DOMMatrixPolyfill {
      const result = this.rotate(angleDeg);
      this.a = result.a;
      this.b = result.b;
      this.c = result.c;
      this.d = result.d;
      this.e = result.e;
      this.f = result.f;
      return this;
    }

    skewX(angleDeg: number): DOMMatrixPolyfill {
      const tangent = Math.tan((angleDeg * Math.PI) / 180);
      return this.multiply(new DOMMatrixPolyfill([1, 0, tangent, 1, 0, 0]));
    }

    skewXSelf(angleDeg: number): DOMMatrixPolyfill {
      const result = this.skewX(angleDeg);
      this.a = result.a;
      this.b = result.b;
      this.c = result.c;
      this.d = result.d;
      this.e = result.e;
      this.f = result.f;
      return this;
    }

    skewY(angleDeg: number): DOMMatrixPolyfill {
      const tangent = Math.tan((angleDeg * Math.PI) / 180);
      return this.multiply(new DOMMatrixPolyfill([1, tangent, 0, 1, 0, 0]));
    }

    skewYSelf(angleDeg: number): DOMMatrixPolyfill {
      const result = this.skewY(angleDeg);
      this.a = result.a;
      this.b = result.b;
      this.c = result.c;
      this.d = result.d;
      this.e = result.e;
      this.f = result.f;
      return this;
    }

    inverse(): DOMMatrixPolyfill {
      const det = this.a * this.d - this.b * this.c;
      if (det === 0) throw new Error('Cannot invert a degenerate DOMMatrix.');
      return new DOMMatrixPolyfill([
        this.d / det, -this.b / det,
        -this.c / det, this.a / det,
        (this.c * this.f - this.d * this.e) / det,
        (this.b * this.e - this.a * this.f) / det,
      ]);
    }

    invertSelf(): DOMMatrixPolyfill {
      const result = this.inverse();
      this.a = result.a;
      this.b = result.b;
      this.c = result.c;
      this.d = result.d;
      this.e = result.e;
      this.f = result.f;
      return this;
    }

    transformPoint(point: any): { x: number; y: number; z: number; w: number } {
      const x = typeof point?.x === 'number' ? point.x : 0;
      const y = typeof point?.y === 'number' ? point.y : 0;
      return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
    }

    setMatrixValue(value: string): this {
      const matched = /^matrix\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/i.exec(String(value));
      if (matched) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = matched.slice(1).map(Number);
      }
      return this;
    }

    flipX(): DOMMatrixPolyfill { return this.scaleSelf(-1, 1); }
    flipY(): DOMMatrixPolyfill { return this.scaleSelf(1, -1); }
    toJSON(): any { return { a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f }; }
    toString(): string { return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`; }
  }
  return DOMMatrixPolyfill;
}

/** 构造一个最小 ImageData 全局；pdf-parse 仅在渲染路径使用，文本提取不依赖像素数据。 */
function CreateImageDataPolyfill(): any {
  return class ImageDataPolyfill {
    width: number;
    height: number;
    data: Uint8ClampedArray;

    constructor(width: any, height?: number, data?: Uint8ClampedArray) {
      if (typeof width === 'object' && width !== null) {
        const source = width;
        this.width = source.width;
        this.height = source.height;
        this.data = source.data;
        return;
      }
      if (arguments.length >= 3 && data) {
        this.data = data;
        this.width = width;
        this.height = height as number;
        return;
      }
      this.width = width;
      this.height = height as number;
      this.data = new Uint8ClampedArray((this.width * this.height * 4) | 0);
    }
  };
}

/** 在 Backend 启动时注入缺失的浏览器几何全局；已存在则跳过（兼容未来 Chromium 注入）。 */
export function InstallBrowserPolyfills(): void {
  if (typeof (globalThis as any).DOMMatrix !== 'function') (globalThis as any).DOMMatrix = CreateDOMMatrixPolyfill();
  if (typeof (globalThis as any).ImageData !== 'function') (globalThis as any).ImageData = CreateImageDataPolyfill();
}
