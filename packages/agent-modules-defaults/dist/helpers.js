"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequireString = RequireString;
exports.CreateToolResult = CreateToolResult;
/** 校验字符串字段，避免工具/配置输入直接进入请求层或持久化。 */
function RequireString(value, field, maxLength = 20000) {
    if (typeof value !== 'string' || !value.trim() || value.length > maxLength)
        throw new Error(`${field} is invalid.`);
    return value.trim();
}
/** 生成符合 Chat Completions 协议的脱敏工具结果；可携带统一 disposition 与 receipt。 */
function CreateToolResult(toolCallId, payload, extra = {}) {
    return {
        role: 'tool',
        tool_call_id: toolCallId,
        content: JSON.stringify(payload),
        ...(extra.disposition ? { disposition: extra.disposition } : {}),
        ...(extra.receipt ? { receipt: extra.receipt } : {}),
    };
}
