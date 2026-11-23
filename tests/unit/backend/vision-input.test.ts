import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CreateVisionUserMessage, DetectSupportedImageMimeType, HydrateVisionHistory, HydrateVisionMessage, SupportsVisionInput } from '../../../apps/backend/src/electron/backend/vision-input';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('vision input', () => {
  it('历史图片缺失时拒绝请求且不改变原文和引用', async () => {
    const message = { role: 'user' as const, content: '这张图是参考', imageAttachments: [{ uri: 'attachment://missing/old.png', mimeType: 'image/png' as const, detail: 'auto' as const }] };
    const original = structuredClone(message);
    await expect(HydrateVisionMessage(message, async () => null)).rejects.toMatchObject({ code: 'STORAGE_ERROR', details: { reason: 'HISTORY_IMAGE_UNAVAILABLE' } });
    expect(message).toEqual(original);
    expect(message).not.toHaveProperty('providerContent');
    await expect(CreateVisionUserMessage('本轮新图', [{ name: 'old.png', path: 'attachment://missing/old.png' }], async () => null)).rejects.toThrow('unavailable');
  });

  it('混合图片中任意一张损坏也不能部分发送，恢复后按原顺序重放', async () => {
    const root = mkdtempSync(join(tmpdir(), 'avery-vision-mixed-')); temporaryDirectories.push(root);
    const good = join(root, 'good.png'), broken = join(root, 'broken.png');
    writeFileSync(good, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); writeFileSync(broken, 'broken');
    const references = ['good', 'broken'].map(id => ({ uri: `attachment://${id}/image.png`, mimeType: 'image/png' as const, detail: 'auto' as const }));
    const resolve = async (uri: string) => ({ physicalPath: uri.includes('/good/') ? good : broken, mimeType: 'image/png' });
    const message = { role: 'user' as const, content: '比较图片', imageAttachments: references };
    await expect(HydrateVisionMessage(message, resolve)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    writeFileSync(broken, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const recovered = await HydrateVisionMessage(message, resolve);
    expect(recovered.providerContent).toHaveLength(3);
    expect(recovered.providerContent?.[0]).toEqual({ type: 'text', text: '比较图片' });
  });

  it('历史批量读取最多四条并发并保留顺序，取消不会变成图片失效说明', async () => {
    let active = 0, maximum = 0;
    const controller = new AbortController();
    const history = Array.from({ length: 15 }, (_, index) => ({ role: 'user' as const, content: String(index), imageAttachments: [{ uri: `attachment://image-${index}/old.png`, mimeType: 'image/png' as const, detail: 'auto' as const }] }));
    const root = mkdtempSync(join(tmpdir(), 'avery-vision-concurrency-')); temporaryDirectories.push(root);
    const file = join(root, 'image.png'); writeFileSync(file, Buffer.from('iVBORw0KGgo=', 'base64'));
    const result = await HydrateVisionHistory(history, async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return { physicalPath: file }; }, controller.signal);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(result.map(message => message.content)).toEqual(history.map(message => message.content));
    controller.abort();
    await expect(HydrateVisionMessage(history[0], async () => null, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('只为声明支持视觉的官方模型启用图片输入', () => {
    expect(SupportsVisionInput('DeepSeek', 'deepseek-v4-flash-vision-exp')).toBe(true);
    expect(SupportsVisionInput('Z.AI', 'glm-5.3-flash')).toBe(true);
    expect(SupportsVisionInput('DeepSeek', 'deepseek-v4-flash')).toBe(true);
    expect(SupportsVisionInput('DeepSeek', 'deepseek-flash')).toBe(true);
    expect(SupportsVisionInput('DeepSeek', 'deepseek-v4-pro')).toBe(false);
    expect(SupportsVisionInput('自定义', 'glm-5.3-flash')).toBe(false);
    // MiMo 官方声明 v2.6 全系与 mimo-v2.5 支持图片输入；mimo-v2.5-pro 与语音系模型不支持
    expect(SupportsVisionInput('MIMO', 'mimo-v2.6-flash')).toBe(true);
    expect(SupportsVisionInput('MIMO', 'mimo-v2.6-pro-ultraspeed')).toBe(true);
    expect(SupportsVisionInput('MIMO', 'mimo-v2.5')).toBe(true);
    expect(SupportsVisionInput('MIMO', 'mimo-v2.5-pro')).toBe(false);
    expect(SupportsVisionInput('MIMO', 'mimo-v2.5-tts')).toBe(false);
  });
  it('按真实文件签名识别官方支持格式，不信任文件名', () => {
    expect(DetectSupportedImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg');
    expect(DetectSupportedImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(DetectSupportedImageMimeType(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(DetectSupportedImageMimeType(Buffer.from('RIFF0000WEBP'))).toBe('image/webp');
    expect(DetectSupportedImageMimeType(Buffer.from('%PDF-1.7'))).toBeNull();
  });

  it('将受控附件转换成 image_url data URL，并可由虚拟 URI 在后续 Run 重新水合', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'avery-vision-'));
    temporaryDirectories.push(directory);
    const physicalPath = join(directory, 'misleading.txt');
    writeFileSync(physicalPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    const resolve = async () => ({ mimeType: 'text/plain', physicalPath });

    const current = await CreateVisionUserMessage('描述图片', [{ name: 'misleading.txt', path: 'attachment://image/misleading.txt' }], resolve);
    expect(current.providerContent).toEqual([
      { type: 'text', text: '描述图片' },
      expect.objectContaining({ type: 'image_url', image_url: expect.objectContaining({ url: expect.stringMatching(/^data:image\/png;base64,/) }) }),
    ]);
    expect(current.imageAttachments).toEqual([{ uri: 'attachment://image/misleading.txt', mimeType: 'image/png', detail: 'auto', sha256: createHash('sha256').update(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])).digest('hex') }]);

    const hydrated = await HydrateVisionMessage({ ...current, providerContent: undefined }, resolve);
    expect(hydrated.providerContent?.[1]).toMatchObject({ type: 'image_url', image_url: { detail: 'auto' } });
    expect(hydrated.providerContent).toEqual(current.providerContent);
    writeFileSync(physicalPath, Buffer.from('iVBORw0KGgo=', 'base64'));
    await expect(HydrateVisionMessage({ ...current, providerContent: undefined }, resolve)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });

  it('声明为图片但实际内容不受支持时显式拒绝', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'avery-vision-invalid-'));
    temporaryDirectories.push(directory);
    const physicalPath = join(directory, 'fake.png');
    writeFileSync(physicalPath, 'not an image');

    await expect(CreateVisionUserMessage('识别', [{ name: 'fake.png', path: 'attachment://image/fake.png' }], async () => ({ mimeType: 'image/png', physicalPath })))
      .rejects.toThrow(/not a valid JPEG, PNG, GIF, or WebP/);
  });
});
