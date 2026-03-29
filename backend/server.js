require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// --- Config ---
const MODEL_TYPE = process.env.MODEL_TYPE || 'groq'; // options: 'groq', 'keywords'
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GROQ_API_KEY || GROQ_API_KEY === 'your_api_key_here') {
  console.warn('⚠️ GROQ_API_KEY is not set in .env. AI grouping will fail and fallback to keyword matching.');
}

app.use(cors());
app.use(express.json());

// --- Request Logging Middleware ---
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// --- Health Check ---
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Smart Tab Manager Backend',
    version: '2.1.0',
    mode: MODEL_TYPE,
    uptime: Math.floor(process.uptime())
  });
});

// --- Categories Endpoint ---
app.get('/categories', (req, res) => {
  res.json({
    categories: CATEGORIES,
    mode: MODEL_TYPE
  });
});

// --- Tab Analysis Endpoint ---
app.post('/analyze', async (req, res) => {
  try {
    const { tabs } = req.body;
    const requestModelType = req.headers['x-model-type']; // groq, keywords

    if (!tabs || !Array.isArray(tabs)) {
      return res.status(400).json({ error: 'Invalid request: "tabs" must be an array' });
    }

    if (tabs.length === 0) {
      return res.json({ groups: [], close_tabs: [] });
    }

    const activeModelType = requestModelType || MODEL_TYPE;
    let analysis;

    console.log(`  🔍 Analyzing with mode: ${activeModelType}`);

    try {
      if (activeModelType === 'groq') {
        if (GROQ_API_KEY && GROQ_API_KEY !== 'your_api_key_here') {
          analysis = await analyzeWithGroq(tabs, GROQ_API_KEY.trim());
        } else {
          throw new Error('Groq API key not configured in backend .env');
        }
      } else {
        console.log('  🔍 Falling back to local keyword engine.');
        analysis = analyzeWithKeywords(tabs);
      }
    } catch (aiError) {
      console.error(`  ❌ AI analysis failed (${activeModelType}):`, aiError.message);
      analysis = analyzeWithKeywords(tabs);
      analysis._fallback = true;
      analysis._error = aiError.message;
    }

    res.json(analysis);
  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
//  GROQ (Cloud Open Source Engine)
// ============================================================

const CATEGORIES = ['Study', 'Shopping', 'Social', 'Work', 'Entertainment', 'AI Tools', 'Other'];

async function analyzeWithGroq(tabs, targetApiKey) {
  const tabList = tabs.map((tab, i) =>
    `${i + 1}. [id:${tab.id}] Title: "${tab.title}" | URL: ${tab.url}`
  ).join('\n');

  // Use more modern Groq model
  const modelToUse = 'llama-3.3-70b-versatile';

  const prompt = `You are a tab manager. Analyze these tabs and create EXACTLY 4 dynamic categories to best organize them based on content. Return JSON only.
Format: {"groups": [{"name": "Created Category Name", "summary": "desc", "tab_ids": [ids]}], "close_tab_ids": [ids]}
Tabs:
${tabList}`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${targetApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: modelToUse,
      messages: [
        { role: 'system', content: 'You are a tab manager that responds only in JSON.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errorMsg = errorData.error ? errorData.error.message : response.statusText;
    throw new Error(`Groq error: ${errorMsg}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content;
  const parsed = JSON.parse(content);

  console.log(`  ✅ Groq successfully categorized ${tabs.length} tabs into ${parsed.groups?.length || 0} groups.`);

  return processAIResult(tabs, parsed, 'ai-groq');
}

// Helper to map IDs back to tab objects
function processAIResult(tabs, parsed, mode) {
  const tabMap = new Map(tabs.map(t => [t.id, t]));
  const groups = [];

  for (const group of parsed.groups || []) {
    const groupTabs = (group.tab_ids || [])
      .map(id => tabMap.get(id))
      .filter(Boolean);

    if (groupTabs.length > 0) {
      groups.push({
        name: group.name,
        summary: group.summary,
        tabs: groupTabs
      });
    }
  }

  return {
    groups,
    close_tabs: parsed.close_tab_ids || [],
    total_tabs: tabs.length,
    mode: mode
  };
}

// ============================================================
//  KEYWORD-BASED FALLBACK
// ============================================================

const keywords = {
  Study: [
    'tutorial', 'learn', 'course', 'education',
    'udemy', 'coursera', 'stackoverflow', 'github',
    'w3schools', 'mdn', 'geeksforgeeks', 'leetcode',
    'hackerrank', 'codepen', 'documentation', 'wiki',
    'research', 'scholar', 'arxiv'
  ],
  Shopping: [
    'amazon', 'flipkart', 'ebay', 'shop', 'cart',
    'product', 'aliexpress', 'walmart', 'etsy',
    'bestbuy', 'target.com', 'myntra', 'meesho'
  ],
  Social: [
    'instagram', 'twitter', 'facebook', 'linkedin',
    'reddit', 'tiktok', 'pinterest', 'snapchat',
    'discord', 'threads.net', 'mastodon', '//x.com'
  ],
  Work: [
    'docs.google', 'drive.google', 'notion', 'slack',
    'zoom', 'meet.google', 'teams', 'outlook',
    'gmail', 'calendar', 'jira', 'confluence',
    'asana', 'trello', 'figma', 'canva'
  ],
  Entertainment: [
    'netflix', 'spotify', 'twitch', 'disney', 'hulu',
    'music', 'games', 'game', 'youtube', 'vimeo',
    'primevideo', 'crunchyroll', 'hotstar', 'imdb',
    'rottentomatoes', 'soundcloud'
  ],
  'AI Tools': [
    'chatgpt', 'chat.openai', 'openai.com',
    'gemini.google', 'aistudio.google',
    'claude', 'anthropic',
    'ollama', 'huggingface', 'perplexity',
    'copilot', 'bard', 'poe.com',
    'midjourney', 'stable-diffusion',
    'deepseek', 'groq'
  ]
};

const summaries = {
  Study: 'Learning and development resources including tutorials, documentation, and courses',
  Shopping: 'E-commerce and shopping sites with products and carts',
  Social: 'Social media platforms for networking and content sharing',
  Work: 'Work-related tools including email, documents, and communication',
  Entertainment: 'Streaming, music, video, and gaming content',
  'AI Tools': 'AI assistants, LLMs, and generative AI platforms',
  Other: 'Miscellaneous tabs that do not fit into specific categories'
};

const lowValueKeywords = [
  'login', 'signup', 'sign up', 'sign in', 'sign-in', 'sign-up',
  'cart', 'checkout', 'ads', 'promo', 'offer',
  'unsubscribe', 'verify', 'confirm', 'reset password',
  'cookie', 'consent', 'captcha'
];

function analyzeWithKeywords(tabs) {
  const groups = {};
  for (const cat of CATEGORIES) {
    groups[cat] = [];
  }

  tabs.forEach(tab => {
    const urlLower = (tab.url || '').toLowerCase();
    const titleLower = (tab.title || '').toLowerCase();
    const combined = urlLower + ' ' + titleLower;

    let categorized = false;

    for (const [category, categoryKeywords] of Object.entries(keywords)) {
      if (categoryKeywords.some(keyword => combined.includes(keyword))) {
        groups[category].push(tab);
        categorized = true;
        break;
      }
    }

    if (!categorized) {
      groups.Other.push(tab);
    }
  });

  // Identify low-value tabs
  const closeTabIds = [];

  tabs.forEach(tab => {
    const titleLower = (tab.title || '').toLowerCase();
    const urlLower = (tab.url || '').toLowerCase();
    const combined = titleLower + ' ' + urlLower;

    if (lowValueKeywords.some(keyword => combined.includes(keyword))) {
      closeTabIds.push(tab.id);
    }
  });

  // Build result — only include non-empty groups
  const resultGroups = [];

  for (const [name, tabsInGroup] of Object.entries(groups)) {
    if (tabsInGroup.length > 0) {
      resultGroups.push({
        name,
        summary: summaries[name] || 'Other tabs',
        tabs: tabsInGroup
      });
    }
  }

  return {
    groups: resultGroups,
    close_tabs: closeTabIds,
    total_tabs: tabs.length,
    mode: 'keyword-fallback'
  };
}

// --- Server Startup ---
const server = app.listen(PORT, () => {
  console.log(`\n  ⚡ Smart Tab Manager backend running on http://localhost:${PORT}`);
  console.log(`  📋 Mode: ${MODEL_TYPE}\n`);
});

// --- Graceful Shutdown ---
function shutdown(signal) {
  console.log(`\n  Received ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log('  Server closed.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('  Forced shutdown after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
