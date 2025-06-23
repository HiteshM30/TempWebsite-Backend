const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const OpenAI = require('openai');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const KNOWLEDGE_SECTIONS = [
  { name: 'Condeco', url: 'https://knowledge.eptura.com/condeco' },
  { name: 'Proxyclick', url: 'https://knowledge.eptura.com/proxyclick' },
  { name: 'Serraview', url: 'https://knowledge.eptura.com/serraview' },
  { name: 'iOFFICE', url: 'https://knowledge.eptura.com/ioffice' },
  { name: 'ManagerPlus', url: 'https://knowledge.eptura.com/managerplus' },
  { name: 'SpaceIQ', url: 'https://knowledge.eptura.com/spaceiq' },
  { name: 'Archibus', url: 'https://knowledge.eptura.com/archibus' },
];
const SCRAPE_INTERVAL = 24 * 60 * 60 * 1000;

const knowledgeBase = new Map();
let lastScrapeTime = null;

app.use(morgan('combined')); // Added detailed logging
app.use(helmet());
app.use(compression());
app.use(express.json());
app.use(express.static('public'));
app.use(
  cors({
    origin: '*', // Temporary for debugging; revert to specific origins later
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function scrapeSectionRecursively(section, depth, maxDepth) {
  if (depth > maxDepth) return;
  try {
    const response = await axios.get(section.url, { timeout: 10000 });
    const $ = cheerio.load(response.data);
    const pageTitle = $('title').text() || section.name;
    const content = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 1000);
    knowledgeBase.set(section.url, {
      title: pageTitle,
      content,
      url: section.url,
    });

    const links = [];
    $('a').each((_, element) => {
      const href = $(element).attr('href');
      if (
        href &&
        href.startsWith('https://knowledge.eptura.com') &&
        !knowledgeBase.has(href)
      ) {
        links.push({ name: $(element).text(), url: href });
      }
    });

    for (const link of links) {
      await scrapeSectionRecursively(link, depth + 1, maxDepth);
      await new Promise(resolve => setTimeout(resolve, 2000)); // Added delay
    }
  } catch (error) {
    console.error(`❌ Failed to scrape ${section.url}:`, error.message);
  }
}

async function scrapeEpturaKnowledge() {
  console.log('🔁 Starting scraping...');
  try {
    for (const section of KNOWLEDGE_SECTIONS) {
      await scrapeSectionRecursively(section, 0, 1); // Reduced maxDepth
      await new Promise(resolve => setTimeout(resolve, 2000)); // Added delay
    }
    lastScrapeTime = new Date();
    console.log(`✅ Scraping done. Total: ${knowledgeBase.size}`);
  } catch (error) {
    console.error('❌ Scraping failed:', error.message);
  }
}

async function initialize() {
  console.log('🚀 Initializing...');
  // if (!lastScrapeTime || (Date.now() - lastScrapeTime) > SCRAPE_INTERVAL) {
  //   await scrapeEpturaKnowledge(); // Disabled on startup
  // }
  setInterval(() => {
    console.log('🕒 Scheduled scrape...');
    scrapeEpturaKnowledge();
  }, SCRAPE_INTERVAL);
}

function searchKnowledgeBase(query, limit = 3) {
  const results = [];
  const queryLower = query.toLowerCase();
  for (const [url, doc] of knowledgeBase.entries()) {
    if (
      doc.title.toLowerCase().includes(queryLower) ||
      doc.content.toLowerCase().includes(queryLower)
    ) {
      results.push({
        title: doc.title,
        excerpt: doc.content.substring(0, 200) + '...',
        url: doc.url,
      });
    }
    if (results.length >= limit) break;
  }
  return results;
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK' });
});

app.post('/api/chat', async (req, res) => {
  try {
    console.log('Received /api/chat request:', req.body);
    if (!req.body || !req.body.message) {
      console.error('Missing message in request body');
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
      content: `You are an AI assistant for Eptura Asset Management.\n\n${context}`
    };
    const messages = [
      systemMessage,
      ...conversation.slice(-10),
      { role: 'user', content: message }
    ];
    try {
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
    } catch (openaiError) {
      console.error('OpenAI API error:', openaiError.message);
      res.status(500).json({ error: 'Failed to process request with OpenAI', details: openaiError.message });
    }
  } catch (error) {
    console.error('Error in /api/chat:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

app.post('/api/search', (req, res) => {
  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }
  const results = searchKnowledgeBase(query, 5);
  res.json({ results });
});

app.post('/api/scrape', async (req, res) => {
  try {
    await scrapeEpturaKnowledge();
    res.json({ message: 'Scraping completed', total: knowledgeBase.size });
  } catch (error) {
    res.status(500).json({ error: 'Scraping failed', details: error.message });
  }
});

app.get('/api/knowledge/stats', (req, res) => {
  res.json({
    totalArticles: knowledgeBase.size,
    lastScraped: lastScrapeTime ? lastScrapeTime.toISOString() : null,
  });
});

app.post('/api/ask', (req, res) => {
  const { prompt } = req.body;
  const imageMap = {
    'workflow': 'workflow-module.jpg',
    'dashboard': 'dashboard.png',
    'sensor': 'sensor-mapping.png',
    'asset': 'sample-asset.png'
  };
  let imageKey = Object.keys(imageMap).find(key => prompt && prompt.toLowerCase().includes(key));
  const imageUrl = imageKey ? `/images/${imageMap[imageKey]}` : null;
  res.json({
    text: `Here's the architecture diagram for: ${prompt}`,
    image: imageUrl,
    imageAlt: imageKey ? `Image for ${imageKey}` : 'No image'
  });
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initialize();
});