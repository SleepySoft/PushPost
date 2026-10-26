import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Article, SiteSnapshot } from '@pushpost/core';

let cachedSnapshot: SiteSnapshot | undefined;

function emptySnapshot(): SiteSnapshot {
  return {
    sourceCommit: '',
    generatedAt: new Date().toISOString(),
    visibilityHash: '',
    settings: { schemaVersion: 1, defaultLang: 'zh-CN', timezone: 'Asia/Shanghai' },
    siteUrl: 'http://localhost:4321',
    siteTitle: 'PushPost',
    articles: [],
    categories: [],
    targets: [],
    redirects: [],
  };
}

export function loadSnapshot(): SiteSnapshot {
  if (cachedSnapshot) return cachedSnapshot;

  const snapshotPath = process.env.PUSHPOST_SNAPSHOT;
  if (snapshotPath === undefined) return emptySnapshot();

  const filename = resolve(process.cwd(), snapshotPath);
  let snapshot: SiteSnapshot;
  try {
    snapshot = JSON.parse(readFileSync(filename, 'utf8')) as SiteSnapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取快照 ${filename}：${message}`);
  }

  if (
    !snapshot ||
    typeof snapshot.siteUrl !== 'string' ||
    typeof snapshot.siteTitle !== 'string' ||
    typeof snapshot.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.generatedAt)) ||
    !Array.isArray(snapshot.articles) ||
    !Array.isArray(snapshot.redirects) ||
    !snapshot.settings
  ) {
    throw new Error(`快照 ${filename} 不是有效的 SiteSnapshot JSON。`);
  }

  cachedSnapshot = snapshot;
  return snapshot;
}

export function getVisibleArticles(snapshot: SiteSnapshot): Article[] {
  const generatedAt = Date.parse(snapshot.generatedAt);
  return snapshot.articles
    .filter((article) => {
      const publishedAt = article.publishedAt ? Date.parse(article.publishedAt) : Number.NaN;
      const visible = (article as Article & { visible?: boolean }).visible;
      return (
        article.status === 'published' &&
        visible !== false &&
        Number.isFinite(publishedAt) &&
        publishedAt <= generatedAt
      );
    })
    .sort((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!));
}

export function getSiteData() {
  const snapshot = loadSnapshot();
  return { snapshot, articles: getVisibleArticles(snapshot) };
}

export function postPath(article: Pick<Article, 'slug'>): string {
  return `/posts/${encodeURIComponent(article.slug)}/`;
}

export function categoryPath(category: string): string {
  return `/categories/${encodeURIComponent(category)}/`;
}

export function tagPath(tag: string): string {
  return `/tags/${encodeURIComponent(tag)}/`;
}

export function absoluteUrl(path: string, siteUrl: string): string {
  return new URL(path, siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`).href;
}

export function decodeRouteParam(value: string | undefined): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function formatDate(value: string, lang: string, timezone: string): string {
  return new Intl.DateTimeFormat(lang, {
    dateStyle: 'long',
    timeZone: timezone,
  }).format(new Date(value));
}
