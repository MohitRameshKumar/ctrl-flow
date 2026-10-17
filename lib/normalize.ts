export interface NormalizedUrl {
  url: string;
  domain: string;
}

/** Strips query/fragment, keeping `v` on youtube.com since it identifies the video. Returns null for non-http(s) URLs (chrome://, about:, etc). */
export function normalizeUrl(rawUrl: string | undefined): NormalizedUrl | null {
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const domain = parsed.hostname;
  let search = '';
  if (domain === 'youtube.com' || domain.endsWith('.youtube.com')) {
    const v = parsed.searchParams.get('v');
    if (v) search = `?v=${encodeURIComponent(v)}`;
  }

  return {
    url: `${parsed.protocol}//${parsed.host}${parsed.pathname}${search}`,
    domain,
  };
}
