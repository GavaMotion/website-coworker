const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { NodeSSH } = require('node-ssh');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Auth middleware ──────────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  const password = req.headers['x-password'];
  if (password !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ── SSH helpers ──────────────────────────────────────────────────────────────
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
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      success: !result.stderr || result.stderr.trim() === '',
    };
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

async function uploadImage(base64Data, remotePath) {
  const ssh = new NodeSSH();
  try {
    await ssh.connect(getSSHConfig());
    const buffer = Buffer.from(base64Data, 'base64');
    const tmpFile = path.join(os.tmpdir(), `coworker_img_${Date.now()}`);
    fs.writeFileSync(tmpFile, buffer);
    await ssh.putFile(tmpFile, remotePath);
    fs.unlinkSync(tmpFile);
    ssh.dispose();
    return { success: true, path: remotePath };
  } catch (err) {
    return { error: err.message, success: false };
  }
}

// ── Tool definitions ─────────────────────────────────────────────────────────
const tools = [
  {
    name: 'run_ssh_command',
    description: 'Run a shell command on the Hostinger server. Use for reading files, listing directories, making backups, running sed replacements, etc.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute on the server' },
      },
      required: ['command'],
    },
  },
  {
    name: 'write_remote_file',
    description: 'Write or overwrite a file on the server with new content. Always back up the original first using run_ssh_command.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full absolute path on the server' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'upload_image',
    description: 'Upload a base64-encoded image to the server.',
    input_schema: {
      type: 'object',
      properties: {
        base64_data: { type: 'string', description: 'Base64-encoded image data (no data URI prefix)' },
        remote_path: { type: 'string', description: 'Full absolute path where the image should be saved' },
      },
      required: ['base64_data', 'remote_path'],
    },
  },
];

const SYSTEM_PROMPT = `You are a Website Coworker — an autonomous AI agent with SSH access to a Hostinger web server.

Site root: ${process.env.SITE_ROOT || '/home/user/public_html'}

Your responsibilities:
- Update HTML pages on request
- Upload and insert images
- Manage files and directories on the server
- Keep the site clean, valid, and well-organized

Rules you always follow:
1. Before editing any file, back it up: cp file.html file.html.bak
2. After uploading, verify the change by reading the file back
3. Never delete files unless explicitly instructed
4. Match the existing code style, indentation, and CSS framework
5. After every task, report: what changed, which files, and the live URL path
6. If a request is ambiguous, ask before acting

You have three tools: run_ssh_command, write_remote_file, and upload_image.
Use them autonomously — fetch, edit, upload, verify — without asking the user to do anything manually.`;

// ── Ping (password check) ────────────────────────────────────────────────────
app.get('/api/ping', (req, res) => res.json({ ok: true }));

// ── Chat endpoint (SSE streaming) ────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let currentMessages = messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  try {
    while (true) {
      const response = await client.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools,
        messages: currentMessages,
      });

      // Send text blocks to UI
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          send({ type: 'text', text: block.text });
        }
      }

      if (response.stop_reason === 'end_turn') break;

      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
        const toolResults = [];

        for (const toolUse of toolUseBlocks) {
          send({ type: 'tool_start', name: toolUse.name, input: toolUse.input });

          let result;
          if (toolUse.name === 'run_ssh_command') {
            result = await runSSHCommand(toolUse.input.command);
          } else if (toolUse.name === 'write_remote_file') {
            result = await writeRemoteFile(toolUse.input.path, toolUse.input.content);
          } else if (toolUse.name === 'upload_image') {
            result = await uploadImage(toolUse.input.base64_data, toolUse.input.remote_path);
          }

          send({ type: 'tool_result', name: toolUse.name, result });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          });
        }

        currentMessages = [
          ...currentMessages,
          { role: 'assistant', content: response.content },
          { role: 'user', content: toolResults },
        ];
      } else {
        break;
      }
    }
  } catch (err) {
    send({ type: 'error', message: err.message });
  }

  send({ type: 'done' });
  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Website Coworker running on http://localhost:${PORT}`);
});
