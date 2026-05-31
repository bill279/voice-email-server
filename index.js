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
const FROM_EMAIL = process.env.FROM_EMAIL || 'stewart@bilmedia.ca';
const FROM_NAME = process.env.FROM_NAME || 'Bilmedia AI';

app.get('/', (req, res) => res.json({ status: 'ok' }));

// — Chat with web search —
app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const systemPrompt = `You are Bilmedia AI, a smart personal assistant for Stewart at bilmedia.ca. Today is ${today}.

Use web search whenever asked about current events, news, weather, sports, stocks, or anything time-sensitive.

Write responses like a knowledgeable assistant — clear, well-structured, with proper paragraph breaks between ideas. No markdown symbols (no **, no *, no #, no -). Just clean prose.

You can send emails. When the user asks to send or email something, confirm you are doing it and that it will arrive shortly.`;

    let msgs = [...messages];
    let reply = '';

    for (let i = 0; i < 6; i++) {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        system: systemPrompt,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: msgs
      }, {
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        timeout: 60000
      });

      const { content, stop_reason } = r.data;

      if (stop_reason === 'end_turn') {
        reply = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        break;
      }

      if (stop_reason === 'tool_use') {
        msgs.push({ role: 'assistant', content });
        const results = content.filter(b => b.type === 'tool_use').map(b => ({
          type: 'tool_result', tool_use_id: b.id, content: 'Search completed.'
        }));
        msgs.push({ role: 'user', content: results });
        continue;
      }

      reply = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      break;
    }

    if (!reply) reply = 'I was unable to complete that request. Please try again.';

    // Strip Claude's "I can't send emails" disclaimers
    reply = reply
      .replace(/I('m| am) (unable|not able) to (send|compose|write) (emails?|messages?)[^.]*\./gi, '')
      .replace(/I don'?t have (the ability|access|capability) to (send|compose) (emails?)[^.]*\./gi, '')
      .replace(/unfortunately[^.]*I can'?t[^.]*email[^.]*\./gi, '')
      .replace(/I (can'?t|cannot|don'?t) (actually |really )?(send|access|use)[^.]*email[^.]*\./gi, '')
      .replace(/\n{3,}/g, '\n\n').trim();

    // Detect email intent — inject [SHOW_EMAIL] tag automatically
    const last = (messages[messages.length - 1]?.content || '').toLowerCase();
    if (/\b(email|send|mail)\b/.test(last) && !reply.includes('[SHOW_EMAIL]')) {
      reply += '\n[SHOW_EMAIL]';
    }

    res.json({ reply });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// — Generate email subject + body —
app.post('/generate-email', async (req, res) => {
  try {
    const { messages } = req.body;
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 800,
      system: 'Generate a professional email from the conversation. Return ONLY valid JSON: {"subject":"...","body":"..."}. No markdown, no extra text.',
      messages: [...messages, { role: 'user', content: 'Write the email now. Return only JSON.' }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    });
    const text = r.data.content[0].text.trim().replace(/```json|```/g, '').trim();
    res.json(JSON.parse(text));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// — Transcribe audio —
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const FormData = require('form-data');
    const fd = new FormData();
    fd.append('file', req.file.buffer, { filename: 'audio.webm', contentType: req.file.mimetype });
    fd.append('model', 'whisper-1');
    const r = await axios.post('https://api.openai.com/v1/audio/transcriptions', fd, {
      headers: { ...fd.getHeaders(), 'Authorization': 'Bearer ' + OPENAI_KEY }
    });
    res.json({ text: r.data.text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// — Text to speech —
app.post('/speak', async (req, res) => {
  try {
    const { text, voice } = req.body;
    const r = await axios.post('https://api.openai.com/v1/audio/speech', {
      model: 'tts-1', input: text.substring(0, 4000), voice: voice || 'alloy'
    }, {
      headers: { 'Authorization': 'Bearer ' + OPENAI_KEY, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer'
    });
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(r.data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// — Send email —
app.post('/email', upload.single('attachment'), async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'Missing fields' });
    const payload = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject: subject || 'Bilmedia AI',
      content: [{ type: 'text/plain', value: body }]
    };
    if (req.file) {
      payload.attachments = [{
        content: req.file.buffer.toString('base64'),
        filename: req.file.originalname,
        type: req.file.mimetype,
        disposition: 'attachment'
      }];
    }
    await axios.post('https://api.sendgrid.com/v3/mail/send', payload, {
      headers: { 'Authorization': `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' }
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bilmedia AI running on ${PORT}`));
