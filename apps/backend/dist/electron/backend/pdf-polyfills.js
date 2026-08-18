"use strict";
// @ts-nocheck
/**
 * 为纯 Node 的 Backend Utility Process 提供 pdf-parse 依赖的浏览器几何全局。
 * Electron 主进程由 Chromium 注入 DOMMatrix/ImageData，utilityProcess 缺失；这里提供最小但数学正确的 2D 仿射实现。
 */
Object.defineProperty(exports, "__esModule", { value: true });
/** 构造一个标准 2D 仿射矩阵类；pdf-parse 内部仅使用文本提取相关的矩阵运算。 */
function CreateDOMMatrixPolyfill() {
    class DOMMatrixPolyfill {
        constructor(init) {
            this.a = 1;
            this.b = 0;
            this.c = 0;
            this.d = 1;
            this.e = 0;
            this.f = 0;
            if (init === undefined || init === null)
                return;
            if (Array.isArray(init)) {
                if (init.length === 6) {
                    [this.a, this.b, this.c, this.d, this.e, this.f] = init;
                }
                else if (init.length === 16) {
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
        get m11() { return this.a; }
        set m11(value) { this.a = value; }
        get m12() { return this.b; }
        set m12(value) { this.b = value; }
        get m21() { return this.c; }
        set m21(value) { this.c = value; }
        get m22() { return this.d; }
        set m22(value) { this.d = value; }
        get m41() { return this.e; }
        set m41(value) { this.e = value; }
        get m42() { return this.f; }
        set m42(value) { this.f = value; }
        get m13() { return 0; }
        get m14() { return 0; }
        get m23() { return 0; }
        get m24() { return 0; }
        get m31() { return 0; }
        get m32() { return 0; }
        get m33() { return 1; }
        get m34() { return 0; }
        get m43() { return 0; }
        get m44() { return 1; }
        get is2D() { return true; }
        get isIdentity() { return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0; }
        /** 返回 后乘 后的新矩阵：result = this × other。 */
        multiply(other) {
            return new DOMMatrixPolyfill([
                this.a * other.a + this.c * other.b,
                this.b * other.a + this.d * other.b,
                this.a * other.c + this.c * other.d,
                this.b * other.c + this.d * other.d,
                this.a * other.e + this.c * other.f + this.e,
                this.b * other.e + this.d * other.f + this.f,
            ]);
        }
        multiplySelf(other) {
            const result = this.multiply(other);
            this.a = result.a;
            this.b = result.b;
            this.c = result.c;
            this.d = result.d;
            this.e = result.e;
            this.f = result.f;
            return this;
        }
        /** 返回平移后的新矩阵：result = this × translate(tx, ty)。 */
        translate(tx, ty = 0) {
            return this.multiply(new DOMMatrixPolyfill([1, 0, 0, 1, tx, ty]));
        }
        translateSelf(tx, ty = 0) {
            const result = this.translate(tx, ty);
            this.a = result.a;
            this.b = result.b;
            this.c = result.c;
            this.d = result.d;
            this.e = result.e;
            this.f = result.f;
            return this;
        }
        /** 返回缩放后的新矩阵：result = this × scale(sx, sy)。 */
        scale(sx, sy = sx) {
            return this.multiply(new DOMMatrixPolyfill([sx, 0, 0, sy, 0, 0]));
        }
        scaleSelf(sx, sy = sx) {
            const result = this.scale(sx, sy);
            this.a = result.a;
            this.b = result.b;
            this.c = result.c;
            this.d = result.d;
            this.e = result.e;
            this.f = result.f;
            return this;
        }
        /** 返回绕原点旋转后的新矩阵：result = this × rotate(angleDeg)。 */
        rotate(angleDeg) {
            const radians = (angleDeg * Math.PI) / 180;
            const cos = Math.cos(radians);
            const sin = Math.sin(radians);
            return this.multiply(new DOMMatrixPolyfill([cos, sin, -sin, cos, 0, 0]));
        }
        rotateSelf(angleDeg) {
            const result = this.rotate(angleDeg);
            this.a = result.a;
            this.b = result.b;
            this.c = result.c;
            this.d = result.d;
            this.e = result.e;
            this.f = result.f;
            return this;
        }
        /** 返回 X 轴倾斜后的新矩阵：result = this × skewX(angleDeg)。 */
        skewX(angleDeg) {
            const tangent = Math.tan((angleDeg * Math.PI) / 180);
            return this.multiply(new DOMMatrixPolyfill([1, 0, tangent, 1, 0, 0]));
        }
        skewXSelf(angleDeg) {
            const result = this.skewX(angleDeg);
            this.a = result.a;
            this.b = result.b;
            this.c = result.c;
            this.d = result.d;
            this.e = result.e;
            this.f = result.f;
            return this;
        }
        /** 返回 Y 轴倾斜后的新矩阵：result = this × skewY(angleDeg)。 */
        skewY(angleDeg) {
            const tangent = Math.tan((angleDeg * Math.PI) / 180);
            return this.multiply(new DOMMatrixPolyfill([1, tangent, 0, 1, 0, 0]));
        }
        skewYSelf(angleDeg) {
            const result = this.skewY(angleDeg);
            this.a = result.a;
            this.b = result.b;
            this.c = result.c;
            this.d = result.d;
            this.e = result.e;
            this.f = result.f;
            return this;
        }
        /** 返回当前矩阵的逆；退化矩阵抛错，供 pdf-parse 检测几何无效。 */
        inverse() {
            const det = this.a * this.d - this.b * this.c;
            if (det === 0)
                throw new Error('Cannot invert a degenerate DOMMatrix.');
            return new DOMMatrixPolyfill([
                this.d / det, -this.b / det,
                -this.c / det, this.a / det,
                (this.c * this.f - this.d * this.e) / det,
                (this.b * this.e - this.a * this.f) / det,
            ]);
        }
        invertSelf() {
            const result = this.inverse();
            this.a = result.a;
            this.b = result.b;
            this.c = result.c;
            this.d = result.d;
            this.e = result.e;
            this.f = result.f;
            return this;
        }
        /** 把点经当前矩阵变换后返回；仅处理 2D 平面。 */
        transformPoint(point) {
            const x = typeof point?.x === 'number' ? point.x : 0;
            const y = typeof point?.y === 'number' ? point.y : 0;
            return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
        }
        /** 解析 matrix(a,b,c,d,e,f) 字符串；其它函数形式解析失败时忽略，保持当前值。 */
        setMatrixValue(value) {
            const matched = /^matrix\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/i.exec(String(value));
            if (matched) {
                [this.a, this.b, this.c, this.d, this.e, this.f] = matched.slice(1).map(Number);
            }
            return this;
        }
        flipX() { return this.scaleSelf(-1, 1); }
        flipY() { return this.scaleSelf(1, -1); }
        toJSON() { return { a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f }; }
        toString() { return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`; }
    }
    return DOMMatrixPolyfill;
}
/** 构造一个最小 ImageData 全局；pdf-parse 仅在渲染路径使用，文本提取不依赖像素数据。 */
function CreateImageDataPolyfill() {
    return class ImageDataPolyfill {
        constructor(width, height) {
            if (typeof width === 'object' && width !== null) {
                const source = width;
                this.width = source.width;
                this.height = source.height;
                this.data = source.data;
                return;
            }
            if (arguments.length >= 3 && arguments[2]) {
                this.data = new Uint8ClampedArray(arguments[2]);
                this.width = width;
                this.height = height;
                return;
            }
            this.width = width;
            this.height = height;
            this.data = new Uint8ClampedArray((width * height * 4) | 0);
        }
    };
}
/** 在 Backend 启动时注入缺失的浏览器几何全局；已存在则跳过（兼容未来 Chromium 注入）。 */
function InstallBrowserPolyfills() {
    if (typeof globalThis.DOMMatrix !== 'function')
        globalThis.DOMMatrix = CreateDOMMatrixPolyfill();
    if (typeof globalThis.ImageData !== 'function')
        globalThis.ImageData = CreateImageDataPolyfill();
}
module.exports = { InstallBrowserPolyfills };
