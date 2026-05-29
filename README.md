# Voice Email Server

Speak → Claude writes the email → SendGrid sends it with attachments. Works from iPhone, Mac, Windows, anywhere.

## Deploy to Render (5 minutes)

### 1. Push to GitHub
Create a new GitHub repo and push these files to it.

### 2. Deploy on Render
1. Go to render.com and sign up (free)
2. Click **New → Web Service**
3. Connect your GitHub repo
4. Render auto-detects the settings from render.yaml
5. Add these **Environment Variables** in Render dashboard:

| Key | Value |
|-----|-------|
| `ANTHROPIC_API_KEY` | your Anthropic API key |
| `SENDGRID_API_KEY` | your SendGrid API key |
| `FROM_EMAIL` | stewart@bilmedia.ca |
| `FROM_NAME` | Stewart |

6. Click **Deploy** — your server URL will be something like `https://voice-email-server.onrender.com`

## API Usage

### Send an email (no attachment)
```bash
curl -X POST https://your-server.onrender.com/send \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Tell Bill the pricing doc is ready and ask if he has questions",
    "to": "bill@bilmedia.com",
    "to_name": "Bill"
  }'
```

### Send an email with attachment
```bash
curl -X POST https://your-server.onrender.com/send \
  -F "prompt=Send Bill the pricing breakdown doc" \
  -F "to=bill@bilmedia.com" \
  -F "attachment=@/path/to/pricing.docx"
```

### Response
```json
{
  "success": true,
  "subject": "Pricing Breakdown Ready",
  "body": "Hi Bill, just wanted to let you know...",
  "attachment": "pricing.docx"
}
```

## iPhone — Siri Shortcut

1. Open the **Shortcuts** app on iPhone
2. Tap **+** to create a new shortcut
3. Add these actions in order:
   - **Dictate Text** → "What would you like to say?"
   - **Ask for Input** → "Who to send to?" (Text input, variable: RecipientEmail)
   - **Get Contents of URL**
     - URL: `https://your-server.onrender.com/send`
     - Method: POST
     - Request Body: JSON
     - Add fields: `prompt` = Dictated Text, `to` = RecipientEmail
   - **Show Result** → Show result from previous action
4. Name it **"Send Email"** and add it to your home screen

Now just say "Hey Siri, Send Email" — it asks what to say and who to send it to, done.

## Mac / Windows — Voice Web App

Open `webapp.html` in any browser. Click the mic, speak, hit send. Works on any device with a browser.
