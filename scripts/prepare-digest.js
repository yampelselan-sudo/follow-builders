#!/usr/bin/env node

// ============================================================================
// Follow Builders — Prepare Digest
// ============================================================================
// Gathers everything the LLM needs to produce a digest:
// - Fetches the central feeds (tweets + podcasts)
// - Fetches the latest prompts from GitHub
// - Reads the user's config (language, delivery method)
// - Outputs a single JSON blob to stdout
//
// The LLM's ONLY job is to read this JSON, remix the content, and output
// the digest text. Everything else is handled here deterministically.
//
// Usage: node prepare-digest.js
// Output: JSON to stdout
// ============================================================================

import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');

// Try user's fork first, fall back to original central feed
const MY_FEED_X = 'https://raw.githubusercontent.com/yampelselan-sudo/follow-builders/main/feed-x.json';
const MY_FEED_PODCASTS = 'https://raw.githubusercontent.com/yampelselan-sudo/follow-builders/main/feed-podcasts.json';
const MY_FEED_BLOGS = 'https://raw.githubusercontent.com/yampelselan-sudo/follow-builders/main/feed-blogs.json';
const ORIGINAL_FEED_X = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const ORIGINAL_FEED_PODCASTS = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const ORIGINAL_FEED_BLOGS = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json';

const NITTER_INSTANCES = [
  "https://nitter.net",
  "https://nitter.privacydev.net",
  "https://nitter.poast.org",
  "https://nitter.lucabased.xyz",
  "https://nitter.esmailelbob.xyz",
];

const PROMPTS_BASE = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/prompts';
const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'summarize-blogs.md',
  'digest-intro.md',
  'translate.md'
];

// -- Fetch helpers -----------------------------------------------------------

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

// -- Nitter RSS Fetching (local, no API key needed) --------------------------

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNitterRss(xml) {
  const tweets = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch ? titleMatch[1].trim() : "";
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/);
    const desc = descMatch ? descMatch[1].trim() : title;
    const guidMatch = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const guid = guidMatch ? guidMatch[1].trim() : "";
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const pubDate = pubDateMatch ? new Date(pubDateMatch[1].trim()).toISOString() : null;
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const link = linkMatch ? linkMatch[1].trim() : guid;
    const id = guid.split("/status/")[1] || guid.split("/").pop();
    if (id && title) {
      tweets.push({ id, text: stripHtml(desc), createdAt: pubDate, url: link, likes: 0, retweets: 0, replies: 0, isQuote: false, quotedTweetId: null });
    }
  }
  return tweets;
}

async function fetchXFromRss(handle, name, state) {
  const seen = state?.seenTweets || {};
  for (const instance of NITTER_INSTANCES) {
    try {
      const res = await fetch(`${instance}/${handle}/rss`, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const allTweets = parseNitterRss(xml);
      const newTweets = [];
      const now = Date.now();
      for (const t of allTweets) {
        if (seen[t.id] || newTweets.length >= 3) continue;
        if (t.text.startsWith("RT @")) continue;
        newTweets.push(t);
      }
      if (newTweets.length === 0) return null;
      return { source: "x", name, handle, bio: "", tweets: newTweets };
    } catch { continue; }
  }
  return null;
}

// -- Main --------------------------------------------------------------------

async function main() {
  const errors = [];

  // 1. Read user config
  let config = {
    language: 'en',
    frequency: 'daily',
    delivery: { method: 'stdout' }
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  // 2. Fetch feeds — try user's fork first, fall back to original
  let [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    fetchJSON(MY_FEED_X),
    fetchJSON(MY_FEED_PODCASTS),
    fetchJSON(MY_FEED_BLOGS),
  ]);

  // If user's feed is empty, fall back to original central feed
  if (!feedX || !feedX.x || feedX.x.length === 0) {
    const original = await fetchJSON(ORIGINAL_FEED_X);
    if (original && original.x && original.x.length > 0) {
      feedX = original;
      errors.push("Custom accounts unavailable — falling back to original 25 builders");
    }
  }
  if (!feedPodcasts || !feedPodcasts.podcasts || feedPodcasts.podcasts.length === 0) {
    const original = await fetchJSON(ORIGINAL_FEED_PODCASTS);
    if (original?.podcasts?.length) feedPodcasts = original;
  }
  if (!feedBlogs || !feedBlogs.blogs || feedBlogs.blogs.length === 0) {
    const original = await fetchJSON(ORIGINAL_FEED_BLOGS);
    if (original?.blogs?.length) feedBlogs = original;
  }

  if (!feedX) errors.push('Could not fetch tweet feed');
  if (!feedPodcasts) errors.push('Could not fetch podcast feed');
  if (!feedBlogs) errors.push('Could not fetch blog feed');

  // 3. Try to fetch custom accounts via Nitter RSS (from local machine)
  // These are accounts in our sources but not in the fallback feed
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const sourcesPath = join(scriptDir, '..', 'config', 'default-sources.json');
  let customAccounts = [];
  if (existsSync(sourcesPath)) {
    try {
      const sources = JSON.parse(await readFile(sourcesPath, 'utf-8'));
      const feedHandles = new Set((feedX?.x || []).map(b => b.handle.toLowerCase()));
      customAccounts = (sources.x_accounts || []).filter(a => !feedHandles.has(a.handle.toLowerCase()));
    } catch {}
  }

  if (customAccounts.length > 0) {
    const rssResults = await Promise.all(
      customAccounts.map(acct => fetchXFromRss(acct.handle, acct.name, {}))
    );
    const validResults = rssResults.filter(Boolean);
    if (validResults.length > 0) {
      if (!feedX) feedX = { x: [] };
      feedX.x.push(...validResults);
    }
  }

  // 4. Load prompts
  const prompts = {};
  const localPromptsDir = join(scriptDir, '..', 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

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

  // 5. Build output
  const xContent = feedX?.x || [];
  const output = {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    config: {
      language: config.language || 'en',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' }
    },
    podcasts: feedPodcasts?.podcasts || [],
    x: xContent,
    blogs: feedBlogs?.blogs || [],
    stats: {
      podcastEpisodes: feedPodcasts?.podcasts?.length || 0,
      xBuilders: xContent.length,
      totalTweets: xContent.reduce((sum, a) => sum + a.tweets.length, 0),
      blogPosts: feedBlogs?.blogs?.length || 0,
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt || null
    },
    prompts,
    errors: errors.length > 0 ? errors : undefined
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    message: err.message
  }));
  process.exit(1);
});
