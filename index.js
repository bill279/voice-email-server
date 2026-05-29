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
    const systemPrompt = system || `You are Bilmedia AI, a smart personal assistant for Stewart at bilmedia. Today's date is ${today}. You have access to real-time web search — use it whenever asked about current events, news, prices, weather, sports, or anything requiring up-to-date info. Be concise and natural. If the user asks to email, send, or mail something, end your reply with exactly: [SHOW_EMAIL]. Only include [SHOW_EMAIL] if explicitly asked.`;

    const tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    let currentMessages = [...messages];
    let finalReply = '';

    // Agentic loop — keep going until Claude stops using tools
    for (let i = 0; i < 5; i++) {
      const claudeRes = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-5',
          max_tokens: 2000,
          system: systemPrompt,
          tools,
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

      const { content, stop_reason } = claudeRes.data;

      // If Claude is done, extract text and break
      if (stop_reason === 'end_turn') {
        const textBlock = content.find(b => b.type === 'text');
        finalReply = textBlock ? textBlock.text : 'Done.';
        break;
      }

      // If Claude used tools, add assistant message and tool results to messages
      if (stop_reason === 'tool_use') {
        currentMessages.push({ role: 'assistant', content });

        // Build tool results
        const toolResults = content
          .filter(b => b.type === 'tool_use')
          .map(b => ({
            type: 'tool_result',
            tool_use_id: b.id,
            content: b.input ? JSON.stringify(b.input) : 'Search completed.'
          }));

        currentMessages.push({ role: 'user', content: toolResults });
      } else {
        // Unexpected stop reason — just grab text if any
        const textBlock = content.find(b => b.type === 'text');
        finalReply = textBlock ? textBlock.text : 'I was unable to complete that request.';
        break;
      }
    }

    if (!finalReply) finalReply = 'I was unable to complete that request.';
    res.json({ reply: finalReply });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
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
      { model: 'tts-1', input: text.substring(0, 500), voice: voice || 'alloy' },
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
