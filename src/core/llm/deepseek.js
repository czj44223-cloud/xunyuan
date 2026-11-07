import { getKey } from '../config.js';
import { postJson } from '../util/http.js';
import { extractJson } from '../util/text.js';

export class LLM {
  constructor(config = {}) {
    if (config.llm?.baseUrl && config.llm.baseUrl !== 'https://api.deepseek.com') throw new Error('只允许官方DeepSeek目标');
    this.baseUrl = 'https://api.deepseek.com';
    this.model = config.llm?.model || 'deepseek-chat';
    this.timeoutMs = config.llm?.timeoutMs || 120000;
    this.stats = { calls: 0, promptTokens: 0, completionTokens: 0 };
  }

  get ready() {
    return Boolean(getKey('deepseek'));
  }

  async chat({ messages, temperature = 0.2, maxTokens = 4096, signal, json = false } = {}) {
    const key = getKey('deepseek');
    if (!key) throw new Error('未配置 DeepSeek API Key');
    const payload = {
      model: this.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    if (json) payload.response_format = { type: 'json_object' };
    const data = await postJson(`${this.baseUrl}/chat/completions`, payload, {
      headers: { authorization: `Bearer ${key}` },
      signal,
      timeoutMs: this.timeoutMs,
      retries: 2,
      maxBytes: 8 * 1024 * 1024,
    });
    this.stats.calls++;
    if (data.usage) {
      this.stats.promptTokens += data.usage.prompt_tokens || 0;
      this.stats.completionTokens += data.usage.completion_tokens || 0;
    }
    const text = data.choices?.[0]?.message?.content || '';
    if (!text.trim()) throw new Error('模型返回为空');
    return { text, usage: data.usage };
  }

  async json({ system, user, signal, maxTokens = 2000, temperature = 0.2 } = {}) {
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    const first = await this.chat({ messages, temperature, maxTokens, signal, json: true });
    const parsed = extractJson(first.text);
    if (parsed) return parsed;

    const retryMessages = [
      ...messages,
      { role: 'assistant', content: first.text },
      { role: 'user', content: '上面的输出不是合法 JSON。请严格只输出一个合法的 JSON 对象，不要解释、不要 Markdown 代码围栏。' },
    ];
    const second = await this.chat({ messages: retryMessages, temperature: 0, maxTokens, signal, json: true });
    const repaired = extractJson(second.text);
    if (repaired) return repaired;
    throw new Error('模型未能返回合法 JSON');
  }
}
