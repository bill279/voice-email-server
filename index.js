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

app.get('/', (req, res) => res.json({ status: 'Bilmedia AI Server running' }));

app.post('/chat', async (req, res) => {
  try {
    const { messages, system } = req.body;
    const today = new Date().toLocaleDateString('en-US', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
    const systemPrompt = system || `You are Bilmedia AI, a smart personal assistant for Stewart at bilmedia. Today's date is ${today}. Use web search for current events, news, weather, sports, prices. Write well-structured responses like a knowledgeable assistant. Use clear paragraphs and complete thoughts. No markdown symbols — no asterisks, bullets, or headers. Just clean flowing prose. You have full email sending capability. When the user asks to send or email something, confirm you are sending it.`;

    let currentMessages = [...messages];
    let finalReply = '';

    for (let i = 0; i < 8; i++) {
      const claudeRes = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-5',
          max_tokens: 2000,
          system: systemPrompt,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: currentMessages
        },
        {
          headers: {
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          },
          timeout: 60000
        }
      );

      const { content, stop_reason } = claudeRes.data;

      if (stop_reason === 'end_turn') {
        const textBlocks = content.filter(b => b.type === 'text').map(b => b.text);
        finalReply = textBlocks.join('\n').trim();
        break;
      }

      if (stop_reason === 'tool_use') {
        currentMessages.push({ role: 'assistant', content });
        const toolResults = content
          .filter(b => b.type === 'tool_use')
          .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'Search completed.' }));
        currentMessages.push({ role: 'user', content: toolResults });
        continue;
      }

      const textBlocks = content.filter(b => b.type === 'text').map(b => b.text);
      finalReply = textBlocks.join('\n').trim() || 'Unable to complete request.';
      break;
    }

    if (!finalReply) finalReply = 'I was unable to get a complete answer. Please try again.';

    // Detect email intent — inject [SHOW_EMAIL] tag automatically
    const lastUserMsg = (messages[messages.length - 1]?.content || '').toLowerCase();
    const emailIntent = /\b(email|send|mail)\b/.test(lastUserMsg);
    if (emailIntent && !finalReply.includes('[SHOW_EMAIL]')) {
      finalReply = finalReply + '\n[SHOW_EMAIL]';
    }

    res.json({ reply: finalReply });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Generate proper email subject + body from conversation
app.post('/generate-email', async (req, res) => {
  try {
    const { messages } = req.body;
    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        system: 'You are an email writing assistant. Generate a professional email based on the conversation. Respond with ONLY valid JSON: {"subject": "...", "body": "..."}. No markdown, no extra text, just the JSON.',
        messages: [
          ...messages,
          { role: 'user', content: 'Write a professional email based on our conversation. Return only JSON with subject and body.' }
        ]
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );
    const text = claudeRes.data.content[0].text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    res.json({ subject: parsed.subject, body: parsed.body });
  } catch (err) {
    console.error(err.response?.data || err.message);
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
      headers: { ...fd.getHeaders(), 'Authorization': 'Bearer ' + OPENAI_KEY }
    });
    res.json({ text: whisperRes.data.text });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/speak', async (req, res) => {
  try {
    const { text, voice } = req.body;
    const ttsRes = await axios.post(
      'https://api.openai.com/v1/audio/speech',
      { model: 'tts-1', input: text.substring(0, 4000), voice: voice || 'alloy' },
      { headers: { 'Authorization': 'Bearer ' + OPENAI_KEY, 'Content-Type': 'application/json' }, responseType: 'arraybuffer' }
    );
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(ttsRes.data));
  } catch (err) {
    console.error(err.response?.data || err.message);
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
      headers: { 'Authorization': `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' }
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bilmedia AI Server listening on port ${PORT}`));
