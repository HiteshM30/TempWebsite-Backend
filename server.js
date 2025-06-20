const express = require('express');
const cors = require('cors');
const app = express();
const axios = require('axios');
const cheerio = require('cheerio');
const { OpenAI } = require('openai');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
require('dotenv').config();

const PORT = process.env.PORT || 3001;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const allowedOrigins = [
  'https://temp-website-frontend.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
];

app.use(express.json({ limit: '10mb' }));
app.use(helmet());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use('/images', express.static('public/images'));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

let knowledgeBase = new Map();
let lastScrapeTime = null;
const SCRAPE_INTERVAL = 24 * 60 * 60 * 1000;

const EPTURA_BASE_URL = 'https://knowledge.eptura.com';
const KNOWLEDGE_SECTIONS = [
  '/Asset/Modules',
  '/Asset/Product_Information',
  '/Asset/Eptura_Asset_Modules',
  '/ManagerPlus',
  '/Space/Modules'
];

async function scrapeEpturaKnowledge() {
  console.log('🔁 Starting scraping...');
  try {
    for (const section of KNOWLEDGE_SECTIONS) {
      await scrapeSectionRecursively(section);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    lastScrapeTime = new Date();
    console.log(`✅ Scraping done. Total: ${knowledgeBase.size}`);
  } catch (error) {
    console.error('❌ Scraping failed:', error.message);
  }
}

async function scrapeSectionRecursively(path, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) return;

  try {
    const url = `${EPTURA_BASE_URL}${path}`;
    console.log(`🔍 Scraping: ${url}`);
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const $ = cheerio.load(response.data);
    const title = $('title').text() || $('h1').first().text() || 'Untitled';
    const content = extractContent($);

    if (content && content.length > 50) {
      knowledgeBase.set(url, {
        title: title.trim(),
        content: content.trim(),
        url,
        lastUpdated: new Date()
      });
    }

    const links = $('a[href*="/Asset/"], a[href*="/ManagerPlus/"], a[href*="/Space/"]')
      .map((i, el) => $(el).attr('href'))
      .get()
      .filter(href => href && href.startsWith('/'))
      .slice(0, 10);

    for (const link of links) {
      if (!knowledgeBase.has(`${EPTURA_BASE_URL}${link}`)) {
        await scrapeSectionRecursively(link, depth + 1, maxDepth);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

  } catch (error) {
    console.error(`❌ Error scraping ${path}:`, error.message);
  }
}

function extractContent($) {
  $('script, style, nav, header, footer, .sidebar').remove();
  let content = '';

  const selectors = ['.content', '.main-content', '#content', 'main', '.article-content', 'body'];
  for (const selector of selectors) {
    const element = $(selector);
    if (element.length > 0) {
      content = element.text();
      break;
    }
  }

  return content.replace(/\s+/g, ' ').replace(/\n+/g, '\n').trim();
}

function searchKnowledgeBase(query, limit = 5) {
  const queryLower = query.toLowerCase();
  const results = [];

  for (const [url, data] of knowledgeBase.entries()) {
    const titleScore = data.title.toLowerCase().includes(queryLower) ? 2 : 0;
    const contentScore = data.content.toLowerCase().includes(queryLower) ? 1 : 0;
    const score = titleScore + contentScore;

    if (score > 0) {
      results.push({
        ...data,
        score,
        excerpt: extractExcerpt(data.content, queryLower)
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

function extractExcerpt(content, query, length = 300) {
  const index = content.toLowerCase().indexOf(query);
  if (index === -1) return content.substring(0, length) + '...';
  const start = Math.max(0, index - 150);
  const end = Math.min(content.length, index + query.length + 150);
  return (start > 0 ? '...' : '') + content.substring(start, end) + (end < content.length ? '...' : '');
}

// Health check
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

// Chat route
app.post('/api/chat', async (req, res) => {
  try {
    if (!req.body || !req.body.message) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    const { message, conversation = [] } = req.body;

    const relevantDocs = searchKnowledgeBase(message, 3);
    let context = '';

    if (relevantDocs.length > 0) {
      context = 'Based on Eptura knowledge:\n\n';
      relevantDocs.forEach((doc, i) => {
        context += `${i + 1}. ${doc.title}\n${doc.excerpt}\nSource: ${doc.url}\n\n`;
      });
    }

    const systemMessage = {
      role: 'system',
      content: `You are an AI assistant for Eptura Asset Management.

You help users with:
- Asset Management
- Work Orders
- Maintenance
- Analytics
- Admin and Settings

${context ? `Use this:\n${context}` : ''}`
    };

    const messages = [
      systemMessage,
      ...conversation.slice(-10),
      { role: 'user', content: message }
    ];

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      messages,
      max_tokens: 1000,
      temperature: 0.7
    });

    const response = completion.choices[0].message.content;

    res.json({
      response,
      sources: relevantDocs.map(doc => ({
        title: doc.title,
        url: doc.url
      }))
    });

  } catch (error) {
    console.error('Error in /api/chat:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Image prompt route — ✅ single version
app.post('/api/ask', (req, res) => {
  const { prompt } = req.body;

  const imageMap = {
    'workflow': 'workflow-module.jpg',
    'dashboard': 'dashboard.png',
    'sensor': 'sensor-mapping.png',
    'asset': 'sample-asset.png'
  };

  const promptLower = prompt ? prompt.toLowerCase() : '';
  const imageKey = Object.keys(imageMap).find(key => promptLower.includes(key));
  const imageUrl = imageKey ? `/images/${imageMap[imageKey]}` : null;

  res.json({
    text: `Here's the architecture diagram for: ${prompt}`,
    image: imageUrl,
    imageAlt: imageKey ? `Image for ${imageKey}` : 'No image'
  });
});

// Search endpoint
app.get('/api/search', (req, res) => {
  try {
    const { q, limit = 10 } = req.query;
    if (!q) return res.status(400).json({ error: 'Query is required' });

    const results = searchKnowledgeBase(q, parseInt(limit));
    res.json({ results });
  } catch (error) {
    console.error('❌ Search error:', error.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Scraping trigger
app.route('/api/scrape')
  .get(async (req, res) => {
    try {
      await scrapeEpturaKnowledge();
      res.json({ message: 'Scraping complete (GET)', entriesCount: knowledgeBase.size });
    } catch (error) {
      res.status(500).json({ error: 'Scrape failed', details: error.message });
    }
  })
  .post(async (req, res) => {
    try {
      await scrapeEpturaKnowledge();
      res.json({ message: 'Scraping complete (POST)', entriesCount: knowledgeBase.size });
    } catch (error) {
      res.status(500).json({ error: 'Scrape failed', details: error.message });
    }
  });

// Stats endpoint
app.get('/api/knowledge/stats', (req, res) => {
  res.json({
    totalEntries: knowledgeBase.size,
    lastScrapeTime,
    needsUpdate: !lastScrapeTime || (Date.now() - lastScrapeTime.getTime()) > SCRAPE_INTERVAL
  });
});

// Root
app.get('/', (req, res) => {
  res.send('Eptura Backend is running!');
});

// Logging middleware
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url} - Origin: ${req.headers.origin}`);
  res.on('finish', () => {
    console.log(`Response Headers: ${JSON.stringify(res.getHeaders())}`);
  });
  next();
});

// 404 fallback
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Init
async function initialize() {
  console.log('🚀 Initializing...');
  if (!lastScrapeTime || (Date.now() - lastScrapeTime) > SCRAPE_INTERVAL) {
    await scrapeEpturaKnowledge();
  }

  setInterval(() => {
    console.log('🕒 Scheduled scrape...');
    scrapeEpturaKnowledge();
  }, SCRAPE_INTERVAL);
}
initialize();

module.exports = app;
