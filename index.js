const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const TAVILY_KEY = process.env.TAVILY_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'stewart@bilmedia.ca';
const FROM_NAME = process.env.FROM_NAME || 'Bilmedia AI';
const USER_EMAIL = process.env.USER_EMAIL || FROM_EMAIL;

app.get('/', (req, res) => res.json({ status: 'Bilmedia AI Server running' }));
app.get('/config', (req, res) => res.json({ userEmail: USER_EMAIL }));

async function webSearch(query) {
  if (!TAVILY_KEY) return 'No search API key configured.';
  try {
    const res = await axios.post('https://api.tavily.com/search', {
      query,
      search_depth: 'basic',
      max_results: 5,
      include_answer: true
    }, {
      timeout: 10000,
      headers: {
        'Authorization': 'Bearer ' + TAVILY_KEY,
        'Content-Type': 'application/json'
      }
    });
    const d = res.data;
    let out = '';
    if (d.answer) out += 'Answer: ' + d.answer + '\n\n';
    if (d.results) out += d.results.slice(0, 4).map(r => '[' + r.title + ']\n' + r.content).join('\n\n');
    console.log('Tavily returned:', out.substring(0, 300));
    return out || 'No results found.';
  } catch(e) {
    const detail = e.response ? JSON.stringify(e.response.data) : e.message;
    console.error('Tavily error:', detail);
    return 'Search error: ' + detail;
  }
}

app.post('/chat', async (req, res) => {
  try {
    const { messages, system } = req.body;
    const now = new Date().toLocaleString('en-CA', {
      timeZone: 'America/Edmonton',
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const systemPrompt = system || 'You are Bilmedia AI, a smart personal assistant for Stewart at Bilmedia in Edmonton, Alberta. The current date and time is ' + now + '.\n\nYou have real-time web search — use it for anything current: news, weather, sports, prices, events, schedules. ALWAYS use the search results to answer. Never say you cannot access the web — just summarize what the search returns. Be conversational, direct, and helpful. Format responses with clear paragraphs.\n\nIf the user asks to email or send something to someone, end your reply with exactly: [SHOW_EMAIL]. If the user names a recipient without an email address, ask for their email first before including [SHOW_EMAIL].';

    const tools = [{
      name: 'web_search',
      description: 'Search the web for real-time or current information — news, weather, sports, events, prices, anything recent.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' }
        },
        required: ['query']
      }
    }];

    let currentMessages = [...messages];
    let finalText = '';

    for (let i = 0; i < 5; i++) {
      const claudeRes = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          system: systemPrompt,
          tools: tools,
          messages: currentMessages
        },
        {
          headers: {
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          }
        }
      );

      const data = claudeRes.data;

      if (data.stop_reason === 'end_turn') {
        finalText = data.content.find(b => b.type === 'text') ? data.content.find(b => b.type === 'text').text : '';
        break;
      }

      if (data.stop_reason === 'tool_use') {
        const toolBlocks = data.content.filter(b => b.type === 'tool_use');
        if (!toolBlocks.length) {
          finalText = data.content.find(b => b.type === 'text') ? data.content.find(b => b.type === 'text').text : '';
          break;
        }

        const searchResults = await Promise.all(
          toolBlocks.map(tb => {
            console.log('Searching:', tb.input.query);
            return webSearch(tb.input.query);
          })
        );

        currentMessages = currentMessages.concat([
          { role: 'assistant', content: data.content },
          {
            role: 'user',
            content: toolBlocks.map((tb, idx) => ({
              type: 'tool_result',
              tool_use_id: tb.id,
              content: searchResults[idx]
            }))
          }
        ]);
      } else {
        finalText = data.content.find(b => b.type === 'text') ? data.content.find(b => b.type === 'text').text : '';
        break;
      }
    }

    res.json({ reply: finalText });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.response ? err.response.data.error.message : err.message });
  }
});

app.post('/generate-email', async (req, res) => {
  try {
    const { messages } = req.body;
    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: 'Generate a professional email based on the conversation. Return ONLY valid JSON with "subject" and "body" fields. No markdown, no explanation.',
        messages: (messages || []).concat([
          { role: 'user', content: 'Write an email based on our conversation. Return JSON only: {"subject": "...", "body": "..."}' }
        ])
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );
    const text = claudeRes.data.content[0].text;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response');
    const parsed = JSON.parse(match[0]);
    res.json({ subject: parsed.subject || '', body: parsed.body || '' });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file' });
    const FormData = require('form-data');
    const fd = new FormData();
    fd.append('file', req.file.buffer, { filename: 'audio.webm', contentType: req.file.mimetype });
    fd.append('model', 'whisper-1');
    const whisperRes = await axios.post('https://api.openai.com/v1/audio/transcriptions', fd, {
      headers: Object.assign({}, fd.getHeaders(), { 'Authorization': 'Bearer ' + OPENAI_KEY })
    });
    res.json({ text: whisperRes.data.text });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/speak', async (req, res) => {
  try {
    const { text, voice } = req.body;
    const ttsRes = await axios.post(
      'https://api.openai.com/v1/audio/speech',
      { model: 'tts-1', input: text.substring(0, 800), voice: voice || 'alloy' },
      { headers: { 'Authorization': 'Bearer ' + OPENAI_KEY, 'Content-Type': 'application/json' }, responseType: 'arraybuffer' }
    );
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(ttsRes.data));
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/email', upload.single('attachment'), async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'to and body required' });

    const sgPayload = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject: subject || 'Bilmedia AI — Your results',
      content: [{ type: 'text/plain', value: body }]
    };

    if (req.file) {
      sgPayload.attachments = [{
        content: req.file.buffer.toString('base64'),
        filename: req.file.originalname,
        type: req.file.mimetype || 'application/octet-stream',
        disposition: 'attachment'
      }];
    }

    await axios.post('https://api.sendgrid.com/v3/mail/send', sgPayload, {
      headers: { 'Authorization': 'Bearer ' + SENDGRID_KEY, 'Content-Type': 'application/json' }
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Bilmedia AI Server listening on port ' + PORT); });
