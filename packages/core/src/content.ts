import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type {
  Article,
  Category,
  ContentValidationIssue,
  DistributionIntent,
  LoadContentOptions,
  PlatformTarget,
  RedirectRule,
  SiteSettings,
  SiteSnapshot,
  SnapshotArticle,
} from './types.js';

const slugPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const assetExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']);

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

const articleFields = z.object({
  id: z.string().trim().min(1).max(256).refine((value) => !hasControlCharacter(value), 'contains control characters'),
  title: z.string().trim().min(1),
  slug: z.string().regex(slugPattern),
  summary: z.string().default(''),
  status: z.enum(['draft', 'published', 'archived']),
  published_at: z.string().nullable().default(null),
  lang: z.string().trim().min(1).optional(),
  tags: z.array(z.string()).default([]),
  cover: z.string().nullable().default(null),
  canonical_url: z.string().nullable().default(null),
  distribution: z.array(z.object({
    target: z.string(),
    mode: z.enum(['draft', 'published']).optional(),
    trigger: z.enum(['auto', 'manual']).optional(),
  }).strict()).default([]),
}).strict();

const pushpostSchema = z.object({
  schema_version: z.literal(1),
  site: z.object({
    default_lang: z.string().trim().min(1),
    timezone: z.string().trim().min(1),
  }).strict(),
}).strict();

const targetSchema = z.object({
  type: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  credential_ref: z.string().trim().min(1).optional(),
  defaults: z.object({
    mode: z.enum(['draft', 'published']).optional(),
    trigger: z.enum(['auto', 'manual']).optional(),
  }).strict().default({}),
  options: z.record(z.string(), z.unknown()).default({}),
}).strict();

const platformsSchema = z.object({
  targets: z.record(z.string(), targetSchema).default({}),
}).strict();

const redirectsSchema = z.object({
  redirects: z.array(z.object({
    from: z.string(),
    article_id: z.string().min(1),
    status: z.union([z.literal(301), z.literal(302)]).default(301),
  }).strict()).default([]),
}).strict();

export class ContentValidationError extends Error {
  readonly issues: ContentValidationIssue[];

  constructor(issue: ContentValidationIssue) {
    super(`${issue.sourcePath}${issue.field ? ` (${issue.field})` : ''}: ${issue.reason} [${issue.sourceCommit}]`);
    this.name = 'ContentValidationError';
    this.issues = [issue];
  }
}

function fail(sourceCommit: string, sourcePath: string, field: string | null, reason: string): never {
  throw new ContentValidationError({ sourceCommit, sourcePath, field, reason });
}

function parseYamlText(text: string, sourcePath: string, sourceCommit: string): unknown {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0) {
    fail(sourceCommit, sourcePath, null, document.errors.map((error) => error.message).join('; '));
  }
  return document.toJS({ maxAliasCount: 100 });
}

function parseYaml(filePath: string, sourcePath: string, sourceCommit: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(sourceCommit, sourcePath, null, `cannot read file: ${errorMessage(error)}`);
  }
  return parseYamlText(text, sourcePath, sourceCommit);
}

function validateSchema<T>(schema: z.ZodType<T>, value: unknown, sourceCommit: string, sourcePath: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    fail(sourceCommit, sourcePath, issue?.path.join('.') || null, issue?.message ?? 'invalid value');
  }
  return result.data;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertLanguage(language: string, sourceCommit: string, sourcePath: string, field: string): void {
  try {
    Intl.getCanonicalLocales(language);
  } catch {
    fail(sourceCommit, sourcePath, field, 'invalid BCP 47 language tag');
  }
}

function assertTimezone(timezone: string, sourceCommit: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    fail(sourceCommit, 'metadata/pushpost.yml', 'site.timezone', 'invalid IANA timezone');
  }
}

function normalizeTimestamp(value: string | null, sourceCommit: string, sourcePath: string): string | null {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  const numbers = match?.slice(1).map((part) => part === undefined ? 0 : Number(part));
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = numbers ?? [];
  const leapYear = year !== undefined && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 ? (leapYear ? 29 : 28) : month !== undefined && [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (!match || month === undefined || month < 1 || month > 12 || day === undefined || day < 1 || day > daysInMonth
    || hour === undefined || hour > 23 || minute === undefined || minute > 59 || second === undefined || second > 59
    || offsetHour === undefined || offsetHour > 23 || offsetMinute === undefined || offsetMinute > 59 || Number.isNaN(Date.parse(value))) {
    fail(sourceCommit, sourcePath, 'published_at', 'must be a valid RFC 3339 timestamp with Z or a UTC offset');
  }
  return new Date(value).toISOString();
}

function assertHttpUrl(value: string, sourceCommit: string, sourcePath: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(sourceCommit, sourcePath, field, 'must be an absolute HTTP(S) URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail(sourceCommit, sourcePath, field, 'must be an absolute HTTP(S) URL');
  }
  return url;
}

function assertSafeName(name: string, sourceCommit: string, sourcePath: string): void {
  if (name === '.' || name === '..' || /[/\\]/.test(name) || hasControlCharacter(name)) {
    fail(sourceCommit, sourcePath, null, 'invalid category name');
  }
}

function registerPath(paths: Map<string, string>, relativePath: string, sourceCommit: string): void {
  const folded = relativePath.normalize('NFKC').toLocaleLowerCase('en-US');
  const previous = paths.get(folded);
  if (previous !== undefined && previous !== relativePath) {
    fail(sourceCommit, relativePath, null, `case-insensitive path collision with ${previous}`);
  }
  paths.set(folded, relativePath);
}

function walkTree(rootDir: string, directory: string, relativeDirectory: string, sourceCommit: string, paths: Map<string, string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const absolutePath = path.join(directory, entry.name);
    registerPath(paths, relativePath, sourceCommit);
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) fail(sourceCommit, relativePath, null, 'symbolic links are not supported');
    if (stat.isDirectory()) walkTree(rootDir, absolutePath, relativePath, sourceCommit, paths);
    else if (!stat.isFile()) fail(sourceCommit, relativePath, null, 'only regular files and directories are supported');
  }
}

function assertRegularDirectory(directory: string, sourceCommit: string, sourcePath: string): void {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch {
    fail(sourceCommit, sourcePath, null, 'required directory is missing');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(sourceCommit, sourcePath, null, 'must be a real directory, not a file or symbolic link');
  }
}

function safeAssetReference(
  reference: string,
  categoryDirectory: string,
  category: string,
  sourceCommit: string,
  sourcePath: string,
  field: string,
): string {
  if (!reference.startsWith('./assets/') || reference.includes('\\') || reference.includes('\0')) {
    fail(sourceCommit, sourcePath, field, 'asset must use a relative ./assets/... path');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(reference);
  } catch {
    fail(sourceCommit, sourcePath, field, 'invalid percent encoding in asset path');
  }
  if (decoded.includes('?') || decoded.includes('#')
    || decoded.split('/').some((part, index) => part === '..' || (index > 0 && part === '.'))) {
    fail(sourceCommit, sourcePath, field, 'asset path contains traversal or URL components');
  }
  const assetsRoot = path.resolve(categoryDirectory, 'assets');
  const absolutePath = path.resolve(categoryDirectory, decoded);
  const relativeToAssets = path.relative(assetsRoot, absolutePath);
  if (relativeToAssets === '' || relativeToAssets.startsWith('..') || path.isAbsolute(relativeToAssets)) {
    fail(sourceCommit, sourcePath, field, 'asset path escapes the category assets directory');
  }
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch {
    fail(sourceCommit, sourcePath, field, `asset does not exist: ${reference}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(sourceCommit, sourcePath, field, 'asset must be a regular file');
  const normalized = decoded.slice(2).split('/').join('/');
  return `./${normalized}`;
}

function validateAsset(filePath: string, relativePath: string, sourceCommit: string, maxAssetBytes: number): void {
  const extension = path.extname(filePath).toLowerCase();
  if (!assetExtensions.has(extension)) fail(sourceCommit, relativePath, null, `unsupported asset extension ${extension || '(none)'}`);
  const stat = statSync(filePath);
  if (stat.size === 0 || stat.size > maxAssetBytes) {
    fail(sourceCommit, relativePath, null, `asset size must be between 1 and ${maxAssetBytes} bytes`);
  }
  const bytes = readFileSync(filePath);
  const matches = extension === '.png'
    ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : extension === '.jpg' || extension === '.jpeg'
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : extension === '.gif'
        ? bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
        : extension === '.webp'
          ? bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
          : bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp' && ['avif', 'avis'].includes(bytes.subarray(8, 12).toString('ascii'));
  if (!matches) fail(sourceCommit, relativePath, null, 'asset contents do not match its image extension');
}

function validateAssets(directory: string, relativeDirectory: string, sourceCommit: string, maxAssetBytes: number): void {
  if (!statSync(directory).isDirectory()) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) validateAssets(absolutePath, relativePath, sourceCommit, maxAssetBytes);
    else validateAsset(absolutePath, relativePath, sourceCommit, maxAssetBytes);
  }
}

function renderMarkdown(markdown: string): { html: string; imageSources: string[]; links: string[] } {
  const rendered = marked.parse(markdown, { gfm: true, async: false, breaks: false });
  const attributes = (name: 'src' | 'href'): string[] => [...rendered.matchAll(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi'))]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '');
  const html = sanitizeHtml(rendered, {
    allowedTags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote', 'pre', 'code', 'em', 'strong', 'del', 'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'],
    allowedAttributes: {
      a: ['href', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      th: ['align'],
      td: ['align'],
      code: ['class'],
      input: ['type', 'checked', 'disabled'],
    },
    allowedClasses: { code: [/^language-[a-zA-Z0-9_-]+$/] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attribs) => ({ tagName: 'a', attribs: { ...attribs, rel: 'noopener noreferrer nofollow' } }),
      input: (_tagName, attribs) => attribs.type === 'checkbox'
        ? { tagName: 'input', attribs: { type: 'checkbox', disabled: 'disabled', ...(attribs.checked !== undefined ? { checked: 'checked' } : {}) } }
        : { tagName: 'input', attribs: { type: 'hidden' } },
    },
  });
  return { html, imageSources: attributes('src'), links: attributes('href') };
}

function articleRoute(slug: string): string {
  return `/posts/${slug}/`;
}

function validateRedirectPath(value: string, sourceCommit: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || /[?#\\]/.test(value) || hasControlCharacter(value)) {
    fail(sourceCommit, 'metadata/redirects.yml', 'from', 'redirect must be a local absolute path without query, fragment, or backslashes');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    fail(sourceCommit, 'metadata/redirects.yml', 'from', 'invalid percent encoding');
  }
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
    fail(sourceCommit, 'metadata/redirects.yml', 'from', 'redirect path traversal is not allowed');
  }
  return value.length > 1 && !value.endsWith('/') ? `${value}/` : value;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function visibilityHash(snapshot: Omit<SiteSnapshot, 'visibilityHash' | 'generatedAt' | 'sourceCommit'>): string {
  const visibleIds = new Set(snapshot.articles.filter((article) => article.visible).map((article) => article.id));
  const publicValue = {
    settings: snapshot.settings,
    siteUrl: snapshot.siteUrl,
    siteTitle: snapshot.siteTitle,
    articles: snapshot.articles.filter((article) => article.visible).map((article) => ({
      id: article.id,
      title: article.title,
      slug: article.slug,
      summary: article.summary,
      status: article.status,
      publishedAt: article.publishedAt,
      lang: article.lang,
      tags: article.tags,
      cover: article.cover,
      canonicalUrl: article.canonicalUrl,
      distribution: [...article.distribution].sort((a, b) => a.target.localeCompare(b.target)),
      category: article.category,
      markdown: article.markdown,
      html: article.html,
      assets: article.assets,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    categories: snapshot.categories,
    targets: snapshot.targets.map((target) => ({
      alias: target.alias,
      type: target.type,
      enabled: target.enabled,
      defaultMode: target.defaultMode,
      defaultTrigger: target.defaultTrigger,
      options: target.options,
    })),
    redirects: snapshot.redirects.filter((redirect) => visibleIds.has(redirect.articleId)),
  };
  return createHash('sha256').update(JSON.stringify(stableValue(publicValue))).digest('hex');
}

export function loadContentRepository(options: LoadContentOptions): SiteSnapshot {
  const sourceCommit = options.sourceCommit.trim();
  if (!sourceCommit) fail(sourceCommit, '.', null, 'sourceCommit is required');
  const rootDir = path.resolve(options.rootDir);
  const contentDir = path.join(rootDir, 'content');
  const metadataDir = path.join(rootDir, 'metadata');
  assertRegularDirectory(contentDir, sourceCommit, 'content');
  assertRegularDirectory(metadataDir, sourceCommit, 'metadata');
  const paths = new Map<string, string>();
  for (const required of ['content', 'metadata']) registerPath(paths, required, sourceCommit);
  walkTree(rootDir, contentDir, 'content', sourceCommit, paths);
  walkTree(rootDir, metadataDir, 'metadata', sourceCommit, paths);

  const pushpost = validateSchema(pushpostSchema, parseYaml(path.join(metadataDir, 'pushpost.yml'), 'metadata/pushpost.yml', sourceCommit), sourceCommit, 'metadata/pushpost.yml');
  const platforms = validateSchema(platformsSchema, parseYaml(path.join(metadataDir, 'platforms.yml'), 'metadata/platforms.yml', sourceCommit), sourceCommit, 'metadata/platforms.yml');
  const redirectConfig = validateSchema(redirectsSchema, parseYaml(path.join(metadataDir, 'redirects.yml'), 'metadata/redirects.yml', sourceCommit), sourceCommit, 'metadata/redirects.yml');
  assertLanguage(pushpost.site.default_lang, sourceCommit, 'metadata/pushpost.yml', 'site.default_lang');
  assertTimezone(pushpost.site.timezone, sourceCommit);
  const settings: SiteSettings = { schemaVersion: 1, defaultLang: pushpost.site.default_lang, timezone: pushpost.site.timezone };
  const adapterTypes = new Set(options.registeredAdapterTypes);
  const targets = new Map<string, PlatformTarget>();
  for (const [alias, target] of Object.entries(platforms.targets)) {
    if (!slugPattern.test(alias)) fail(sourceCommit, 'metadata/platforms.yml', `targets.${alias}`, 'invalid target alias');
    if (!adapterTypes.has(target.type)) fail(sourceCommit, 'metadata/platforms.yml', `targets.${alias}.type`, `unregistered adapter type: ${target.type}`);
    targets.set(alias, {
      alias,
      type: target.type,
      enabled: target.enabled,
      ...(target.credential_ref === undefined ? {} : { credentialRef: target.credential_ref }),
      defaultMode: target.defaults.mode ?? 'draft',
      defaultTrigger: target.defaults.trigger ?? 'manual',
      options: target.options,
    });
  }

  const siteUrl = assertHttpUrl(options.siteUrl, sourceCommit, '<load>', 'siteUrl');
  siteUrl.hash = '';
  siteUrl.search = '';
  const normalizedSiteUrl = siteUrl.toString().replace(/\/$/, '');
  const siteTitle = options.siteTitle.trim();
  if (!siteTitle) fail(sourceCommit, '<load>', 'siteTitle', 'site title must not be empty');
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) fail(sourceCommit, '<load>', 'now', 'invalid current time');
  const maxAssetBytes = options.maxAssetBytes ?? 10 * 1024 * 1024;
  if (!Number.isSafeInteger(maxAssetBytes) || maxAssetBytes < 1) fail(sourceCommit, '<load>', 'maxAssetBytes', 'must be a positive safe integer');

  const articles: SnapshotArticle[] = [];
  const ids = new Map<string, string>();
  const slugs = new Map<string, string>();
  const categories: Category[] = [];
  for (const categoryEntry of readdirSync(contentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const categoryPath = `content/${categoryEntry.name}`;
    if (!categoryEntry.isDirectory()) fail(sourceCommit, categoryPath, null, 'content root may contain only category directories');
    assertSafeName(categoryEntry.name, sourceCommit, categoryPath);
    const categoryDirectory = path.join(contentDir, categoryEntry.name);
    let visibleCount = 0;
    for (const entry of readdirSync(categoryDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const sourcePath = `${categoryPath}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() !== 'assets') fail(sourceCommit, sourcePath, null, 'nested category directories are not supported');
        validateAssets(path.join(categoryDirectory, entry.name), sourcePath, sourceCommit, maxAssetBytes);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      const markdownFile = readFileSync(path.join(categoryDirectory, entry.name), 'utf8');
      const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdownFile);
      if (!frontmatterMatch) fail(sourceCommit, sourcePath, null, 'missing or malformed YAML frontmatter');
      const parsed = validateSchema(articleFields, parseYamlText(frontmatterMatch[1] ?? '', sourcePath, sourceCommit), sourceCommit, sourcePath);
      const previousId = ids.get(parsed.id);
      if (previousId) fail(sourceCommit, sourcePath, 'id', `duplicate article id also used by ${previousId}`);
      const previousSlug = slugs.get(parsed.slug);
      if (previousSlug) fail(sourceCommit, sourcePath, 'slug', `duplicate slug also used by ${previousSlug}`);
      ids.set(parsed.id, sourcePath);
      slugs.set(parsed.slug, sourcePath);
      const lang = parsed.lang ?? settings.defaultLang;
      assertLanguage(lang, sourceCommit, sourcePath, 'lang');
      const publishedAt = normalizeTimestamp(parsed.published_at, sourceCommit, sourcePath);
      const tags = [...new Set(parsed.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
      if (tags.length !== parsed.tags.length || parsed.tags.some((tag, index) => tags[index] !== tag)) {
        fail(sourceCommit, sourcePath, 'tags', 'tags must be non-empty, trimmed, and unique after trimming');
      }
      let canonicalUrl: string | null = null;
      if (parsed.canonical_url !== null) canonicalUrl = assertHttpUrl(parsed.canonical_url, sourceCommit, sourcePath, 'canonical_url').toString();
      const assets = new Set<string>();
      if (parsed.cover !== null) assets.add(safeAssetReference(parsed.cover, categoryDirectory, categoryEntry.name, sourceCommit, sourcePath, 'cover'));
      const markdown = markdownFile.slice(frontmatterMatch[0].length);
      const rendered = renderMarkdown(markdown);
      const html = rendered.html;
      for (const reference of rendered.imageSources) {
        if (/^https?:\/\//i.test(reference)) {
          if (!options.allowExternalImages) fail(sourceCommit, sourcePath, 'markdown', 'external images are disabled by the main-site asset policy');
        } else {
          assets.add(safeAssetReference(reference, categoryDirectory, categoryEntry.name, sourceCommit, sourcePath, 'markdown'));
        }
      }
      if (rendered.links.some((link) => /^file:/i.test(link) || /^[a-z]:[\\/]/i.test(link) || link.startsWith('\\\\'))) {
        fail(sourceCommit, sourcePath, 'markdown', 'local file links are not allowed');
      }
      const distributionTargets = new Set<string>();
      const distribution: DistributionIntent[] = parsed.distribution.map((intent, index) => {
        if (distributionTargets.has(intent.target)) fail(sourceCommit, sourcePath, `distribution.${index}.target`, 'duplicate distribution target');
        distributionTargets.add(intent.target);
        const target = targets.get(intent.target);
        if (!target) fail(sourceCommit, sourcePath, `distribution.${index}.target`, `unknown target: ${intent.target}`);
        return { target: intent.target, mode: intent.mode ?? target.defaultMode, trigger: intent.trigger ?? target.defaultTrigger };
      });
      const visible = parsed.status === 'published' && (publishedAt === null || Date.parse(publishedAt) <= now.getTime());
      if (visible) visibleCount += 1;
      const article: Article = {
        id: parsed.id,
        title: parsed.title,
        slug: parsed.slug,
        summary: parsed.summary,
        status: parsed.status,
        publishedAt,
        lang,
        tags,
        cover: parsed.cover === null ? null : [...assets][0] ?? null,
        canonicalUrl,
        distribution,
        category: categoryEntry.name,
        sourcePath,
        markdown,
        html,
        assets: [...assets].sort(),
      };
      articles.push({ ...article, visible });
    }
    categories.push({ name: categoryEntry.name, path: `/${encodeURIComponent(categoryEntry.name)}/`, articleCount: visibleCount });
  }

  const redirects: RedirectRule[] = [];
  const redirectPaths = new Set<string>();
  for (const [index, redirect] of redirectConfig.redirects.entries()) {
    const from = validateRedirectPath(redirect.from, sourceCommit);
    if (redirectPaths.has(from)) fail(sourceCommit, 'metadata/redirects.yml', `redirects.${index}.from`, 'duplicate redirect path');
    redirectPaths.add(from);
    if (!ids.has(redirect.article_id)) fail(sourceCommit, 'metadata/redirects.yml', `redirects.${index}.article_id`, 'redirect target article does not exist');
    const target = articles.find((article) => article.id === redirect.article_id);
    if (target && from === articleRoute(target.slug)) fail(sourceCommit, 'metadata/redirects.yml', `redirects.${index}.from`, 'redirect conflicts with its target article route');
    redirects.push({ from, articleId: redirect.article_id, status: redirect.status });
  }
  for (const slug of slugs.keys()) {
    if (redirectPaths.has(articleRoute(slug))) fail(sourceCommit, 'metadata/redirects.yml', 'from', `redirect conflicts with article route ${articleRoute(slug)}`);
  }

  const base = {
    settings,
    siteUrl: normalizedSiteUrl,
    siteTitle,
    articles,
    categories,
    targets: [...targets.values()].sort((a, b) => a.alias.localeCompare(b.alias)),
    redirects,
  };
  return { sourceCommit, generatedAt: now.toISOString(), visibilityHash: visibilityHash(base), ...base };
}
