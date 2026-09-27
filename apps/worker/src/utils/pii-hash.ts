/**
 * [Craval security M-5] PII（line_user_id・表示名）をログに直接出さず、短い SHA-256 プレフィクスで出す。
 * Cloudflare Logpush 経由でログ集約先に PII が流出するのを防ぐ。デバッグに必要な相関は取れる。
 */
export async function hashPIIPrefix(value: string | null | undefined): Promise<string> {
  if (!value) return 'null';
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 12); // 48bit: 相関には十分・逆引きほぼ不可
}

/**
 * [Craval security M-2] 定数時間の文字列比較（API キー照合のタイミングオラクル対策）。
 * 長さ不一致は即 false（キー長は機密性が低い）。値の比較は早期 return しない。
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
