const express = require('express');
const Groq = require('groq-sdk');
const { NodeSSH } = require('node-ssh');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static('.'));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use('/api', (req, res, next) => {
  if (req.headers['x-password'] !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/api/ping', (req, res) => res.json({ ok: true }));

function getSSHConfig() {
  const config = {
    host: process.env.SSH_HOST,
    port: parseInt(process.env.SSH_PORT) || 65002,
    username: process.env.SSH_USER,
  };
  if (process.env.SSH_PRIVATE_KEY) {
    config.privateKey = process.env.SSH_PRIVATE_KEY.replace(/\\n/g, '\n');
  } else if (process.env.SSH_PASSWORD) {
    config.password = process.env.SSH_PASSWORD;
  }
  return config;
}

async function runSSHCommand(command) {
  const ssh = new NodeSSH();
  try {
    await ssh.connect(getSSHConfig());
    const result = await ssh.execCommand(command, { cwd: process.env.SITE_ROOT });
    ssh.dispose();
    return { stdout: result.stdout || '', stderr: result.stderr || '', success: true };
  } catch (err) {
    return { error: err.message, success: false };
  }
}

async function writeRemoteFile(remotePath, content) {
  const ssh = new NodeSSH();
  try {
    await ssh.connect(getSSHConfig());
    const tmpFile = path.join(os.tmpdir(), `coworker_${Date.now()}`);
    fs.writeFileSync(tmpFile, content, 'utf8');
    await ssh.putFile(tmpFile, remotePath);
    fs.unlinkSync(tmpFile);
    ssh.dispose();
    return { success: true, path: remotePath };
  } catch (err) {
    return { error: err.message, success: false };
  }
}

// ── Download a file from URL following redirects ──────────────────────────────
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

// ── Extract Google Drive file ID from any Drive URL ───────────────────────────
function extractDriveFileId(url) {
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ── List files from Drive folder using API key ───────────────────────────────
app.get('/api/drive-list', async (req, res) => {
  const folderId = process.env.DRIVE_FOLDER_ID;
  const apiKey   = process.env.GOOGLE_API_KEY;
  if (!folderId) return res.status(400).json({ error: 'DRIVE_FOLDER_ID not set' });
  if (!apiKey)   return res.status(400).json({ error: 'GOOGLE_API_KEY not set' });

  const query = encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/' and trashed=false`);
  const fields = encodeURIComponent('files(id,name,mimeType)');
  const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=${fields}&key=${apiKey}`;

  https.get(url, (response) => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.error) return res.status(400).json({ error: parsed.error.message });
        res.json({ files: parsed.files || [] });
      } catch (err) {
        res.status(500).json({ error: 'Could not parse response: ' + err.message });
      }
    });
  }).on('error', err => res.status(500).json({ error: err.message }));
});

// ── Direct image upload endpoint ──────────────────────────────────────────────
app.post('/api/upload-image', async (req, res) => {
  const { base64_data, filename } = req.body;
  if (!base64_data || !filename) return res.status(400).json({ error: 'Missing data' });
  const ssh = new NodeSSH();
  try {
    await ssh.connect(getSSHConfig());
    const remotePath = `${process.env.SITE_ROOT}/jewelry_images/${filename}`;
    await ssh.execCommand(`mkdir -p ${process.env.SITE_ROOT}/jewelry_images`);
    const tmpFile = path.join(os.tmpdir(), filename);
    fs.writeFileSync(tmpFile, Buffer.from(base64_data, 'base64'));
    await ssh.putFile(tmpFile, remotePath);
    fs.unlinkSync(tmpFile);
    ssh.dispose();
    res.json({ success: true, path: remotePath, url: `/jewelry_images/${filename}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Google Drive image fetch + upload endpoint ────────────────────────────────
app.post('/api/drive-image', async (req, res) => {
  const { driveUrl, fileId: directFileId, filename } = req.body;
  
  const fileId = directFileId || (driveUrl ? extractDriveFileId(driveUrl) : null);
  if (!fileId) return res.status(400).json({ error: 'Missing file ID or Drive URL' });

  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  const safeFilename = filename || `drive-image-${Date.now()}.jpg`;
  const tmpFile = path.join(os.tmpdir(), safeFilename);

  try {
    await downloadFile(downloadUrl, tmpFile);

    const ssh = new NodeSSH();
    await ssh.connect(getSSHConfig());
    const remotePath = `${process.env.SITE_ROOT}/jewelry_images/${safeFilename}`;
    await ssh.execCommand(`mkdir -p ${process.env.SITE_ROOT}/jewelry_images`);
    await ssh.putFile(tmpFile, remotePath);
    fs.unlinkSync(tmpFile);
    ssh.dispose();

    res.json({ success: true, path: remotePath, url: `/jewelry_images/${safeFilename}`, filename: safeFilename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const tools = [
  { type: 'function', function: { name: 'run_ssh_command', description: 'Run a shell command on the Hostinger server via SSH.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command to execute' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'write_remote_file', description: 'Write or overwrite a file on the server. Always back up first.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Full absolute path on the server' }, content: { type: 'string', description: 'Full file content' } }, required: ['path', 'content'] } } },
];

const SYSTEM_PROMPT = `You are a Website Coworker — an autonomous AI agent with SSH access to a Hostinger web server.
Site root: ${process.env.SITE_ROOT || '/home/user/public_html'}
Your responsibilities: update HTML pages, manage files.
Rules: always back up files before editing (cp file.html file.html.bak), verify changes after uploading, never delete files unless told to, report what changed after every task.
Note: images are uploaded directly to the server before you receive the message into /jewelry_images/ folder. When the user says an image was uploaded, it already exists at the stated path — just insert the correct <img> tag into the HTML using the /jewelry_images/ path.`;

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const trimmed = messages.slice(-10);
  let currentMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...trimmed.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
  ];

  try {
    while (true) {
      const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: currentMessages,
        tools,
        tool_choice: 'auto',
        max_tokens: 4096,
      });

      const message = response.choices[0].message;
      if (message.content) send({ type: 'text', text: message.content });
      if (!message.tool_calls || message.tool_calls.length === 0) break;

      currentMessages.push(message);

      for (const toolCall of message.tool_calls) {
        const name = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        send({ type: 'tool_start', name, input: args });

        let result;
        if (name === 'run_ssh_command') result = await runSSHCommand(args.command);
        else if (name === 'write_remote_file') result = await writeRemoteFile(args.path, args.content);

        send({ type: 'tool_result', name, result });
        currentMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) });
      }
    }
  } catch (err) {
    send({ type: 'error', message: err.message });
  }

  send({ type: 'done' });
  res.end();
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Website Coworker running on http://localhost:${PORT}`));
