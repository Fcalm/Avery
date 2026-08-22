"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NormalizeBrowserAddress = NormalizeBrowserAddress;
exports.NormalizeBrowserBounds = NormalizeBrowserBounds;
const MinimumPanelSize = 120;
/** 将用户输入规范为安全的网页地址；拒绝本地协议、内嵌凭据与超长地址。 */
function NormalizeBrowserAddress(address) {
    if (typeof address !== 'string' || !address.trim() || address.length > 2_048)
        return null;
    const candidate = address.includes('://') ? address.trim() : `https://${address.trim()}`;
    try {
        const url = new URL(candidate);
        return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.toString() : null;
    }
    catch {
        return null;
    }
}
/** 边栏坐标必须是窗口内容区内、具有最小可用面积的有限数值。 */
function NormalizeBrowserBounds(value, contentSize) {
    if (!value || typeof value !== 'object')
        return null;
    const candidate = value;
    const values = [candidate.x, candidate.y, candidate.width, candidate.height];
    if (!values.every((item) => typeof item === 'number' && Number.isFinite(item)))
        return null;
    const bounds = { x: Math.round(candidate.x), y: Math.round(candidate.y), width: Math.round(candidate.width), height: Math.round(candidate.height) };
    if (bounds.x < 0 || bounds.y < 0 || bounds.width < MinimumPanelSize || bounds.height < MinimumPanelSize)
        return null;
    const [contentWidth, contentHeight] = contentSize;
    if (!Number.isFinite(contentWidth) || !Number.isFinite(contentHeight))
        return null;
    if (bounds.x + bounds.width > contentWidth || bounds.y + bounds.height > contentHeight)
        return null;
    return bounds;
}
