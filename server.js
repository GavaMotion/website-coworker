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

app.get('/api/ssh-test', async (req, res) => {
  const ssh = new NodeSSH();
  try {
    await ssh.connect(getSSHConfig());
    const result = await ssh.execCommand('whoami');
    ssh.dispose();
    res.json({ success: true, user: result.stdout });
  } catch (err) {
    res.json({ success: false, error: err.message, config: {
      host: process.env.SSH_HOST,
      port: process.env.SSH_PORT,
      user: process.env.SSH_USER,
      hasKey: !!process.env.SSH_KEY_BASE64 || !!process.env.SSH_PRIVATE_KEY,
      hasPassword: !!process.env.SSH_PASSWORD,
    }});
  }
});

function getSSHConfig() {
  const config = {
    host: process.env.SSH_HOST,
    port: parseInt(process.env.SSH_PORT) || 65002,
    username: process.env.SSH_USER,
  };

  const b64Key = process.env.SSH_KEY_BASE64;
  const rawKey = process.env.SSH_PRIVATE_KEY;
  const password = process.env.SSH_PASSWORD;

  if (b64Key) {
    config.privateKey = Buffer.from(b64Key, 'base64').toString('utf8');
    console.log('SSH: using base64 key');
  } else if (rawKey) {
    config.privateKey = rawKey.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
    console.log('SSH: using raw key, length:', config.privateKey.length);
  } else if (password) {
    config.password = password;
    console.log('SSH: using password');
  } else {
    console.log('SSH: no auth configured');
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
    const tmpFile = path.join(os.tmpdir(), 'coworker_' + Date.now());
    fs.writeFileSync(tmpFile, content, 'utf8');
    await ssh.putFile(tmpFile, remotePath);
    fs.unlinkSync(tmpFile);
    ssh.dispose();
    return { success: true, path: remotePath };
  } catch (err) {
    return { error: err.message, success: false };
  }
}

function downloadFile(url, destPath, redirectCount) {
  redirectCount = redirectCount || 0;
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) return reject(new Error('Too many redirects'));
    const proto = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/*,*/*',
      }
    };
    const file = fs.createWriteStream(destPath);
    proto.get(url, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        file.close();
        try { fs.unlinkSync(destPath); } catch (e) {}
        const location = res.headers.location;
        if (!location) return reject(new Error('Redirect with no location'));
        const nextUrl = location.startsWith('http') ? location : 'https://drive.google.com' + location;
        return downloadFile(nextUrl, destPath, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath); } catch (e) {}
        return reject(new Error('Download failed with status ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', (err) => {
      try { fs.unlinkSync(destPath); } catch (e) {}
      reject(err);
    });
  });
}

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

app.get('/api/drive-list', (req, res) => {
  const folderId = process.env.DRIVE_FOLDER_ID;
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!folderId) return res.status(400).json({ error: 'DRIVE_FOLDER_ID not set' });
  if (!apiKey) return res.status(400).json({ error: 'GOOGLE_API_KEY not set' });

  const query = encodeURIComponent("'" + folderId + "' in parents and mimeType contains 'image/' and trashed=false");
  const fields = encodeURIComponent('files(id,name,mimeType)');
  const url = 'https://www.googleapis.com/drive/v3/files?q=' + query + '&fields=' + fields + '&key=' + apiKey;

  https.get(url, (response) => {
    let data = '';
    response.on('data', (chunk) => { data += chunk; });
    response.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.error) return res.status(400).json({ error: parsed.error.message });
        res.json({ files: parsed.files || [] });
      } catch (err) {
        res.status(500).json({ error: 'Could not parse response: ' + err.message });
      }
    });
  }).on('error', (err) => res.status(500).json({ error: err.message }));
});

app.post('/api/upload-image', async (req, res) => {
  const { base64_data, filename } = req.body;
  if (!base64_data || !filename) return res.status(400).json({ error: 'Missing data' });
  const ssh = new NodeSSH();
  try {
    await ssh.connect(getSSHConfig());
    const remotePath = process.env.SITE_ROOT + '/jewelry_images/' + filename;
    await ssh.execCommand('mkdir -p ' + process.env.SITE_ROOT + '/jewelry_images');
    const tmpFile = path.join(os.tmpdir(), filename);
    fs.writeFileSync(tmpFile, Buffer.from(base64_data, 'base64'));
    await ssh.putFile(tmpFile, remotePath);
    fs.unlinkSync(tmpFile);
    ssh.dispose();
    res.json({ success: true, path: remotePath, url: '/jewelry_images/' + filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drive-image', async (req, res) => {
  const { driveUrl, fileId: directFileId, filename } = req.body;
  const fileId = directFileId || (driveUrl ? extractDriveFileId(driveUrl) : null);
  if (!fileId) return res.status(400).json({ error: 'Missing file ID or Drive URL' });

  const downloadUrl = 'https://drive.google.com/uc?export=download&id=' + fileId;
  const safeFilename = filename || ('drive-image-' + Date.now() + '.jpg');
  const tmpFile = path.join(os.tmpdir(), safeFilename);

  try {
    console.log('Downloading from Drive: ' + downloadUrl);
    await downloadFile(downloadUrl, tmpFile);
    const stat = fs.statSync(tmpFile);
    console.log('Downloaded ' + stat.size + ' bytes');

    if (stat.size < 100) {
      const content = fs.readFileSync(tmpFile, 'utf8');
      fs.unlinkSync(tmpFile);
      return res.status(500).json({ error: 'Drive returned invalid file: ' + content.slice(0, 200) });
    }

    const ssh = new NodeSSH();
    await ssh.connect(getSSHConfig());
    const remotePath = process.env.SITE_ROOT + '/jewelry_images/' + safeFilename;
    await ssh.execCommand('mkdir -p ' + process.env.SITE_ROOT + '/jewelry_images');
    await ssh.putFile(tmpFile, remotePath);
    fs.unlinkSync(tmpFile);
    ssh.dispose();

    console.log('Uploaded to ' + remotePath);
    res.json({ success: true, path: remotePath, url: '/jewelry_images/' + safeFilename, filename: safeFilename });
  } catch (err) {
    console.error('drive-image error:', err.message);
    try { fs.unlinkSync(tmpFile); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

const tools = [
  { type: 'function', function: { name: 'run_ssh_command', description: 'Run a shell command on the Hostinger server via SSH.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command to execute' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'write_remote_file', description: 'Write or overwrite a file on the server. Always back up first.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Full absolute path on the server' }, content: { type: 'string', description: 'Full file content' } }, required: ['path', 'content'] } } },
];

const SYSTEM_PROMPT = 'You are a Website Coworker — an autonomous AI agent with SSH access to a Hostinger web server. Site root: ' + (process.env.SITE_ROOT || '/home/user/public_html') + '. Images folder: ' + (process.env.SITE_ROOT || '/home/user/public_html') + '/jewelry_images/. Your responsibilities: update HTML pages, manage files. Rules: always back up files before editing, verify changes after uploading, never delete files unless told to, report what changed after every task. When a user says an image was uploaded, it already exists on the server — just insert the correct img tag using the /jewelry_images/ path.';

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

  const trimmed = messages.slice(-10);
  let currentMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...trimmed.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
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
app.listen(PORT, () => console.log('Website Coworker running on http://localhost:' + PORT));
