import { getKey } from '../../config.js';
import { requestJson } from '../../util/http.js';

export const id = 'pixabay';
export const label = 'Pixabay';
export const kinds = ['video', 'image'];

export function readiness() {
  return getKey('pixabay')
    ? { ready: true, reason: '已配置 API Key' }
    : { ready: false, reason: '未配置 PIXABAY_API_KEY（免费注册）' };
}

function pickVideoFile(videos = {}) {
  const order = ['large', 'medium', 'small', 'tiny'];
  for (const key of order) {
    if (videos[key]?.url) return { url: videos[key].url, width: videos[key].width, height: videos[key].height };
  }
  return null;
}

export async function search(kind, query, { count = 12, signal, config } = {}) {
  const key = getKey('pixabay');
  if (!key) throw new Error('未配置 Pixabay API Key');
  const perPage = Math.min(50, Math.max(3, count * 2));

  if (kind === 'video') {
    const params = new URLSearchParams({
      key, q: query, per_page: String(perPage), safesearch: 'true', video_type: 'all',
    });
    const data = await requestJson(`https://pixabay.com/api/videos/?${params}`, {
      signal, timeoutMs: config?.search?.timeoutMs ?? 20000, retries: 1,
    });
    return (data.hits || []).map((hit) => {
      const file = pickVideoFile(hit.videos);
      if (!file?.url) return null;
      return {
        source: id,
        sourceLabel: label,
        kind: 'video',
        title: String(hit.tags || `Pixabay video ${hit.id}`).split(',').slice(0, 4).join(', '),
        pageUrl: hit.pageURL,
        fileUrl: file.url,
        license: 'Pixabay Content License（可商用，部分需署名）',
        licenseUrl: 'https://pixabay.com/service/license-summary/',
        author: hit.user || 'Pixabay',
        meta: { width: file.width, height: file.height, duration: hit.duration },
      };
    }).filter(Boolean);
  }

  if (kind === 'image') {
    const params = new URLSearchParams({
      key, q: query, image_type: 'photo', per_page: String(perPage), safesearch: 'true',
    });
    const data = await requestJson(`https://pixabay.com/api/?${params}`, {
      signal, timeoutMs: config?.search?.timeoutMs ?? 20000, retries: 1,
    });
    return (data.hits || []).map((hit) => {
      const url = hit.largeImageURL || hit.webformatURL;
      if (!url) return null;
      return {
        source: id,
        sourceLabel: label,
        kind: 'image',
        title: String(hit.tags || `Pixabay image ${hit.id}`).split(',').slice(0, 4).join(', '),
        pageUrl: hit.pageURL,
        fileUrl: url,
        license: 'Pixabay Content License（可商用，部分需署名）',
        licenseUrl: 'https://pixabay.com/service/license-summary/',
        author: hit.user || 'Pixabay',
        meta: { width: hit.imageWidth, height: hit.imageHeight },
      };
    }).filter(Boolean);
  }
  return [];
}
