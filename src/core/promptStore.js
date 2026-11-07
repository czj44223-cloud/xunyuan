import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './paths.js';

const FILE = path.join(DATA_DIR, 'prompts.json');

const DEFAULTS = [
  { id: 'p_city_night', icon: '🌃', title: '城市夜景航拍', content: '城市夜景航拍，霓虹灯光，雨夜街道的慢镜头，电影感调色' },
  { id: 'p_tech_bg', icon: '🚀', title: '科技感片头背景', content: '科技感粒子背景，蓝色光效，抽象数据流，适合片头与转场' },
  { id: 'p_product', icon: '📦', title: '产品特写展示', content: '简洁产品特写展示，白色背景，柔光，浅景深，环绕镜头' },
  { id: 'p_nature', icon: '🌊', title: '自然风光航拍', content: '山川湖海，日出云海，航拍自然风景，画面稳定，色彩通透' },
  { id: 'p_ambient_music', icon: '🎵', title: '氛围感背景音乐', content: '氛围感电子音乐，节奏舒缓，适合旁白与情绪铺垫，不带人声' },
];

async function writeAll(list) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
  await fs.rename(tmp, FILE);
}

async function readAll() {
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
  } catch { /* 首次运行，写入默认合集 */ }
  const seeded = DEFAULTS.map((p) => ({ ...p, builtin: true, createdAt: new Date().toISOString() }));
  await writeAll(seeded).catch(() => {});
  return seeded;
}

export async function listPrompts() {
  return readAll();
}

export async function upsertPrompt(input = {}) {
  const list = await readAll();
  const title = String(input.title || '').trim().slice(0, 40);
  const content = String(input.content || '').trim().slice(0, 1000);
  const icon = String(input.icon || '').trim().slice(0, 8) || '💡';
  if (!content) throw Object.assign(new Error('提示词内容不能为空'), { status: 400 });

  if (input.id) {
    const index = list.findIndex((p) => p.id === input.id);
    if (index >= 0) {
      list[index] = {
        ...list[index],
        title: title || list[index].title,
        content,
        icon,
        updatedAt: new Date().toISOString(),
      };
      await writeAll(list);
      return list[index];
    }
  }

  if (list.length >= 200) throw Object.assign(new Error('提示词数量已达上限'), { status: 400 });
  const prompt = {
    id: `p_${crypto.randomBytes(4).toString('hex')}`,
    title: title || content.slice(0, 20),
    content,
    icon,
    builtin: false,
    createdAt: new Date().toISOString(),
  };
  list.unshift(prompt);
  await writeAll(list);
  return prompt;
}

export async function deletePrompt(id) {
  const list = await readAll();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) throw Object.assign(new Error('提示词不存在'), { status: 404 });
  await writeAll(next);
  return true;
}
