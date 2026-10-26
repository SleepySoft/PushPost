const imageSourcePattern = /(<img\b[^>]*?\ssrc\s*=\s*)(["'])(.*?)\2/gi;

function resolveAssetUrl(source: string, category: string): string {
  if (!source.startsWith('./assets/')) return source;

  const assetPath = source.slice('./assets/'.length);
  try {
    const segments = assetPath.split('/').map((segment) => {
      const decoded = decodeURIComponent(segment);
      if (
        !decoded ||
        decoded === '.' ||
        decoded === '..' ||
        /[/\\]/.test(decoded) ||
        Array.from(decoded).some((character) => {
          const code = character.charCodeAt(0);
          return code <= 31 || code === 127;
        })
      ) {
        throw new Error('Unsafe asset path');
      }
      return encodeURIComponent(decoded);
    });
    return `/content/${encodeURIComponent(category)}/assets/${segments.join('/')}`;
  } catch {
    return source;
  }
}

export function resolveArticleAssetUrls(html: string, category: string): string {
  return html.replace(imageSourcePattern, (_match, prefix: string, quote: string, source: string) => {
    return `${prefix}${quote}${resolveAssetUrl(source, category)}${quote}`;
  });
}
