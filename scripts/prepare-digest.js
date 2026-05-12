#!/usr/bin/env node

// ============================================================================
// Follow Builders — Prepare Digest
// ============================================================================
// Fetches content from the central feed and outputs JSON for LLM remixing.
// Uses https.get instead of fetch (fetch hangs on some Node.js versions).
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import https from 'https';

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');

const CENTRAL_X = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const CENTRAL_PODCASTS = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const CENTRAL_BLOGS = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json';
const PROMPTS_BASE = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/prompts';

const PROMPT_FILES = [
  'summarize-podcast.md', 'summarize-tweets.md', 'summarize-blogs.md',
  'digest-intro.md', 'translate.md'
];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchJSON(url) {
  try { const text = await httpGet(url); return JSON.parse(text); }
  catch { return null; }
}

async function fetchText(url) {
  try { return await httpGet(url); }
  catch { return null; }
}

async function main() {
  const errors = [];

  // 1. Read user config
  let config = { language: 'zh', frequency: 'daily', delivery: { method: 'telegram', chatId: '8510087191' } };
  if (existsSync(CONFIG_PATH)) {
    try { config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8')); }
    catch (err) { errors.push(`Could not read config: ${err.message}`); }
  }

  // 2. Fetch feeds
  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    fetchJSON(CENTRAL_X), fetchJSON(CENTRAL_PODCASTS), fetchJSON(CENTRAL_BLOGS)
  ]);

  if (!feedX) errors.push('Could not fetch tweet feed');
  if (!feedPodcasts) errors.push('Could not fetch podcast feed');
  if (!feedBlogs) errors.push('Could not fetch blog feed');

  // 3. Load prompts
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const localPromptsDir = join(scriptDir, '..', 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');
  const prompts = {};

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);
    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      continue;
    }
    const remote = await fetchText(`${PROMPTS_BASE}/${filename}`);
    if (remote) { prompts[key] = remote; continue; }
    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
    } else {
      errors.push(`Could not load prompt: ${filename}`);
    }
  }

  // 4. Output
  const xContent = feedX?.x || [];
  console.log(JSON.stringify({
    status: 'ok',
    generatedAt: new Date().toISOString(),
    config: { language: config.language || 'zh', frequency: config.frequency || 'daily', delivery: config.delivery || { method: 'stdout' } },
    podcasts: feedPodcasts?.podcasts || [],
    x: xContent,
    blogs: feedBlogs?.blogs || [],
    stats: {
      podcastEpisodes: feedPodcasts?.podcasts?.length || 0,
      xBuilders: xContent.length,
      totalTweets: xContent.reduce((sum, a) => sum + a.tweets.length, 0),
      blogPosts: feedBlogs?.blogs?.length || 0,
    },
    prompts,
    errors: errors.length > 0 ? errors : undefined
  }, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
});
