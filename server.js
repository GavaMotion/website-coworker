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

// ── List files from public Drive folder (no API key needed) ─────────────────
app.get('/api/drive-list', async (req, res) => {
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) return res.status(400).json({ error: 'DRIVE_FOLDER_ID not set' });

  const url = `https://drive.google.com/drive/folders/${folderId}`;
  const options = {
    hostname: 'drive.google.com',
    path: `/drive/folders/${folderId}`,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html',
    }
  };

  https.get(options, (response) => {
    let html = '';
    response.on('data', chunk => html += chunk);
    response.on('end', () => {
      try {
        // Extract file entries from Drive's embedded JSON data
        // Drive embeds file data in a pattern like ["FILE_ID","NAME","mimeType",...]
        const imageTypes = ['image/jpeg','image/jpg','image/png','image/gif','image/webp'];
        const files = [];
        const seen = new Set();

        // Pattern to find file IDs and names in the embedded JSON
        const pattern = /\["([-\w]{25,})"(?:,null)*,"([^"]+)","(image\/[^"]+)"/g;
        let match;
        while ((match = pattern.exec(html)) !== null) {
          const [, id, name, mimeType] = match;
          if (!seen.has(id) && imageTypes.includes(mimeType)) {
            seen.add(id);
            files.push({ id, name, mimeType });
          }
        }

        if (files.length > 0) {
          return res.json({ files });
        }

        // Fallback: extract any file IDs referenced in thumbnail URLs
        const thumbPattern = /thumbnail\?id=([-\w]{25,})/g;
        const namePattern = /"([^"]+\.(jpg|jpeg|png|gif|webp))"/gi;
        const ids = [];
        while ((match = thumbPattern.exec(html)) !== null) {
          if (!seen.has(match[1])) { seen.add(match[1]); ids.push(match[1]); }
        }
        const fallbackFiles = ids.map((id, i) => ({ id, name: `image-${i+1}.jpg`, mimeType: 'image/jpeg' }));
        res.json({ files: fallbackFiles });
      } catch (err) {
        res.status(500).json({ error: 'Could not parse folder: ' + err.message });
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
    const remotePath = `${process.env.SITE_ROOT}/images/${filename}`;
    await ssh.execCommand(`mkdir -p ${process.env.SITE_ROOT}/images`);
    const tmpFile = path.join(os.tmpdir(), filename);
    fs.writeFileSync(tmpFile, Buffer.from(base64_data, 'base64'));
    await ssh.putFile(tmpFile, remotePath);
    fs.unlinkSync(tmpFile);
    ssh.dispose();
    res.json({ success: true, path: remotePath, url: `/images/${filename}` });
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
    const remotePath = `${process.env.SITE_ROOT}/images/${safeFilename}`;
    await ssh.execCommand(`mkdir -p ${process.env.SITE_ROOT}/images`);
    await ssh.putFile(tmpFile, remotePath);
    fs.unlinkSync(tmpFile);
    ssh.dispose();

    res.json({ success: true, path: remotePath, url: `/images/${safeFilename}`, filename: safeFilename });
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
Note: images are uploaded directly to the server before you receive the message. When the user says an image was uploaded, it already exists at the stated path — just insert the correct <img> tag into the HTML.`;

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
