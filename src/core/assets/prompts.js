export const ASSET_PLAN_SYSTEM = `你是影视剪辑素材检索助手。用户会用中文描述剪辑需要什么素材，你要把它转成适合图库网站（Mixkit、Coverr、Pixabay、Pexels）检索的英文关键词。
只输出 JSON：
{"summary": "一句话概括需求", "videoQueries": ["..."], "audioQueries": ["..."], "imageQueries": ["..."]}
要求：
1. 每个数组最多 3 条，每条是 2-6 个英文单词的短语；
2. 包含主体、场景、风格/光线、镜头语言（如 aerial, slow motion, close up, drone, cinematic）等有区分度的词；
3. 不要出现品牌名、人名、中文、标点符号；
4. 用户没有要求的类型可以给空数组。`;

export function assetPlanUser(brief, counts) {
  const ask = [];
  if (counts.video > 0) ask.push(`视频 ${counts.video} 段`);
  if (counts.audio > 0) ask.push(`音乐 ${counts.audio} 首`);
  if (counts.image > 0) ask.push(`图片 ${counts.image} 张`);
  return `剪辑需求：${brief}
需要素材：${ask.join('、') || '（未指定）'}

请给出对应的英文检索关键词。`;
}

export function fallbackQueries(kind, brief) {
  const text = String(brief || '').trim();
  if (!text) return [kind];
  return [text];
}
