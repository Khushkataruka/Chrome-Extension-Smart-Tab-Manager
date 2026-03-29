require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Config ---
const MODEL_TYPE = process.env.MODEL_TYPE || 'gemini'; // options: 'gemini', 'ollama', 'groq', 'fallback'
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// --- AI Setup (Primary) ---
let genAI = null;
let model = null;

if (MODEL_TYPE === 'gemini' && GEMINI_API_KEY && GEMINI_API_KEY !== 'your_api_key_here') {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
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
    const requestModelType = req.headers['x-model-type']; // gemini, groq, ollama, keywords
    const requestKey = req.headers['x-api-key'];
    const requestOllamaUrl = req.headers['x-ollama-url'];

    if (!tabs || !Array.isArray(tabs)) {
      return res.status(400).json({ error: 'Invalid request: "tabs" must be an array' });
    }

    if (tabs.length === 0) {
      return res.json({ groups: [], close_tabs: [] });
    }

    // Determine target model for this request
    const activeModelType = requestModelType || MODEL_TYPE;
    let analysis;

    console.log(`  🔍 Analyzing with mode: ${activeModelType} ${requestKey ? '(User Key)' : '(Server Key)'}`);

    try {
      if (activeModelType === 'gemini') {
        const apiKeyToUse = requestKey || GEMINI_API_KEY;
        if (apiKeyToUse && apiKeyToUse !== 'your_api_key_here') {
          const tempGenAI = new GoogleGenerativeAI(apiKeyToUse.trim());
          const geminiModel = tempGenAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
          analysis = await analyzeWithAI(tabs, geminiModel);
        } else {
          throw new Error('Gemini API key not configured');
        }
      } else if (activeModelType === 'groq') {
        const apiKeyToUse = requestKey || GROQ_API_KEY;
        if (apiKeyToUse && apiKeyToUse !== 'your_api_key_here') {
          analysis = await analyzeWithGroq(tabs, apiKeyToUse.trim());
        } else {
          throw new Error('Groq API key not configured');
        }
      } else if (activeModelType === 'ollama') {
        const urlToUse = requestOllamaUrl || OLLAMA_URL;
        analysis = await analyzeWithOllama(tabs, urlToUse);
      } else {
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
//  AI-POWERED ANALYSIS (Gemini)
// ============================================================

const CATEGORIES = ['Study', 'Shopping', 'Social', 'Work', 'Entertainment', 'AI Tools', 'Other'];

async function analyzeWithAI(tabs, targetModel) {
  const tabList = tabs.map((tab, i) =>
    `${i + 1}. [id:${tab.id}] Title: "${tab.title}" | URL: ${tab.url}`
  ).join('\n');

  const prompt = `You are a browser tab classifier. Analyze the following browser tabs and return a JSON object.

RULES:
- Analyze the tabs and create EXACTLY 4 dynamic categories that best group them based on their content (e.g., "Research", "Development", "Media", "Admin"). You decide the best names.
- Classify each tab into exactly ONE of your 4 created categories based on its title AND URL context.
- "AI Tools" (ChatGPT, Gemini, Claude) should be grouped logically.
- YouTube, Reddit, etc. can be in any category depending on content type.

CLOSE SUGGESTIONS:
- Flag tabs that are low-value: login/signup pages, empty carts, checkout pages, cookie consent, captcha, reset password, unsubscribe, promotional/ad pages.
- Do NOT flag useful pages as closeable.

TABS:
${tabList}

Respond ONLY with valid JSON in this exact format, no markdown fences:
{
  "groups": [
    {
      "name": "Category Name",
      "summary": "Brief 1-line description of this group",
      "tab_ids": [1, 2, 3]
    }
  ],
  "close_tab_ids": [4, 5]
}

Use the actual tab IDs (from [id:X]), not the line numbers. Only include categories that have tabs.`;

  const result = await targetModel.generateContent(prompt);
  const responseText = result.response.text();

  // Parse JSON from response (strip markdown fences if model adds them)
  const jsonStr = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const parsed = JSON.parse(jsonStr);

  // Map AI response back to tab objects
  const tabMap = new Map(tabs.map(t => [t.id, t]));
  const groups = [];

  for (const group of parsed.groups) {
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
    mode: 'ai-gemini'
  };
}

// ============================================================
//  OLLAMA (Local) ANALYSIS
// ============================================================

async function analyzeWithOllama(tabs, targetUrl) {
  const tabList = tabs.map((tab, i) =>
    `${i + 1}. [id:${tab.id}] Title: "${tab.title}" | URL: ${tab.url}`
  ).join('\n');

  const prompt = `Analyze these browser tabs and return ONLY a JSON response.
RULES: Analyze the tabs and create EXACTLY 4 dynamic categories that best group them. Classify each tab into one of your 4 categories.
${tabList}
JSON Format: {"groups": [{"name": "Created Category Name", "summary": "1-line desc", "tab_ids": [id1, id2]}], "close_tab_ids": [id3]}`;

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: prompt,
      stream: false,
      format: 'json'
    })
  });

  if (!response.ok) throw new Error(`Ollama error: ${response.statusText}`);

  const data = await response.json();
  const parsed = typeof data.response === 'string' ? JSON.parse(data.response) : data.response;

  return processAIResult(tabs, parsed, 'ai-ollama');
}

// ============================================================
//  GROQ (Cloud Open Source) ANALYSIS
// ============================================================

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
