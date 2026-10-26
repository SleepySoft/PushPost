import type { APIRoute } from 'astro';
import { absoluteUrl, getSiteData, postPath } from '../snapshot';

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export const GET: APIRoute = () => {
  const { snapshot, articles } = getSiteData();
  const items = articles.map((article) => {
    const url = absoluteUrl(postPath(article), snapshot.siteUrl);
    return `    <item>\n      <title>${escapeXml(article.title)}</title>\n      <link>${escapeXml(url)}</link>\n      <guid>${escapeXml(url)}</guid>\n      <pubDate>${new Date(article.publishedAt!).toUTCString()}</pubDate>\n      <description>${escapeXml(article.summary)}</description>\n    </item>`;
  }).join('\n');
  const homeUrl = absoluteUrl('/', snapshot.siteUrl);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n    <title>${escapeXml(snapshot.siteTitle)}</title>\n    <link>${escapeXml(homeUrl)}</link>\n    <description>${escapeXml(snapshot.siteTitle)}</description>\n    <language>${escapeXml(snapshot.settings.defaultLang)}</language>\n    <lastBuildDate>${new Date(snapshot.generatedAt).toUTCString()}</lastBuildDate>\n${items}\n  </channel>\n</rss>\n`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
};
