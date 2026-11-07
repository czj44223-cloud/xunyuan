import crypto from 'node:crypto';

export function newRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `r_${stamp}_${crypto.randomBytes(3).toString('hex')}`;
}

export function newId(prefix = 's') {
  return `${prefix}${crypto.randomBytes(4).toString('hex')}`;
}
