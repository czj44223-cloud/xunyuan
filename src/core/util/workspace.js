import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export const WORK_ROOT = path.resolve(process.env.XUNYUAN_WORK_ROOT || path.join(os.homedir(), 'xunyuan-work'));
const fail = () => Object.assign(new Error('路径必须位于专用工作根内，且不能包含符号链接或穿越'), { status: 403 });
export async function workPath(raw, { create = false, directory = false } = {}) {
  const text = String(raw || WORK_ROOT);
  if (text.includes('\0') || /%[0-9a-f]{2}/i.test(text) || text.split(/[\\/]/).includes('..')) throw fail();
  const abs = path.resolve(text);
  if (abs !== WORK_ROOT && !abs.startsWith(WORK_ROOT + path.sep)) throw fail();
  // lstat every component, including root ancestors; never follow a symlink.
  const parsed = path.parse(abs); let current = parsed.root;
  const parts = abs.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let st;
    try { st = await fs.lstat(current); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const inRoot = current === WORK_ROOT || current.startsWith(WORK_ROOT + path.sep);
      if (create && inRoot && (directory || i < parts.length - 1)) {
        await fs.mkdir(current, { mode: 0o700 }); st = await fs.lstat(current);
      } else if (create && inRoot && i === parts.length - 1) return abs;
      else throw fail();
    }
    if (st.isSymbolicLink() || (i < parts.length - 1 && !st.isDirectory())) throw fail();
  }
  const real = await fs.realpath(abs);
  if (real !== abs) throw fail();
  if (directory && !(await fs.lstat(abs)).isDirectory()) throw fail();
  return abs;
}
export async function initWorkRoot() { return workPath(WORK_ROOT, { create: true, directory: true }); }
