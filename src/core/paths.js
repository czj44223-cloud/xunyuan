import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const RUNS_DIR = path.join(DATA_DIR, 'runs');
export const ASSET_JOBS_DIR = path.join(DATA_DIR, 'asset-jobs');
export const ENV_FILE = path.join(ROOT, '.env');
export const CONFIG_FILE = path.join(ROOT, 'config.json');
export const WEB_DIR = path.join(ROOT, 'src', 'web');
