const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { NodeSSH } = require('node-ssh');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Auth middleware ───────────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  if (req.headers['x-password'] !== process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ── Ping ─────────────────────────────────────────────────────────────────────
app.get('/api/ping', (req, res) => res.json({ ok: true }));

// ── SSH helpers ───────────────────────────────────────────────────────────────
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

async function uploadImage(base64Data, remotePath) {
  const ssh = new NodeSSH();
  try {
    await ssh.connect(getSSHConfig());
    const tmpFile = path.join(os.tmpdir(), `coworker_img_${Date.now()}`);
    fs.writeFileSync(tmpFile, Buffer.from(base64Data, 'base64'));
    await ssh.putFile(tmpFile, remotePath);
    fs.unlinkSync(tmpFile);
    ssh.dispose();
    return { success: true, path: remotePath };
  } catch (err) {
    return { error: err.message, success: false };
  }
}

// ── Gemini tool definitions ───────────────────────────────────────────────────
const tools = [
  {
    functionDeclarations: [
      {
        name: 'run_ssh_command',
        description: 'Run a shell command on the Hostinger server via SSH. Use for reading files, listing directories, making backups, and in-place edits.',
        parameters: {
          type: 'OBJECT',
          properties: {
            command: { type: 'STRING', description: 'Shell command to execute on the server' },
          },
          required: ['command'],
        },
      },
      {
        name: 'write_remote_file',
        description: 'Write or overwrite a file on the server. Always back up the original first.',
        parameters: {
          type: 'OBJECT',
          properties: {
            path:    { type: 'STRING', description: 'Full absolute path on the server' },
            content: { type: 'STRING', description: 'Full file content to write'       },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'upload_image',
        description: 'Upload a base64-encoded image to the server.',
        parameters: {
          type: 'OBJECT',
          properties: {
            base64_data: { type: 'STRING', description: 'Base64 image data (no data URI prefix)' },
            remote_path: { type: 'STRING', description: 'Full absolute path on the server'       },
          },
          required: ['base64_data', 'remote_path'],
        },
      },
    ],
  },
];

const SYSTEM_INSTRUCTION = `You are a Website Coworker — an autonomous AI agent with SSH access to a Hostinger web server.

Site root: ${process.env.SITE_ROOT || '/home/user/public_html'}

Your responsibilities:
- Update HTML pages on request
- Upload and insert images
- Manage files and directories on the server

Rules you always follow:
1. Before editing any file, back it up: cp file.html file.html.bak
2. After uploading, verify by reading the file back
3. Never delete files unless explicitly told to
4. Match existing code style and CSS framework
5. After every task, report: what changed, which files, and the live URL path
6. If a request is ambiguous, ask before acting`;

// ── Chat endpoint ─────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // Convert history to Gemini format
  const history = messages.slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const lastMessage = messages[messages.length - 1].content;

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: SYSTEM_INSTRUCTION,
      tools,
    });

    const chat = model.startChat({ history });

    let response = await chat.sendMessage(lastMessage);

    // Agentic loop — keep going until no more tool calls
    while (true) {
      const candidate = response.response.candidates[0];
      const parts = candidate.content.parts;

      // Send any text parts to the UI
      for (const part of parts) {
        if (part.text) {
          send({ type: 'text', text: part.text });
        }
      }

      // Find function calls
      const fnCalls = parts.filter(p => p.functionCall);
      if (fnCalls.length === 0) break;

      // Execute each tool call
      const fnResponses = [];
      for (const part of fnCalls) {
        const { name, args } = part.functionCall;
        send({ type: 'tool_start', name, input: args });

        let result;
        if (name === 'run_ssh_command') {
          result = await runSSHCommand(args.command);
        } else if (name === 'write_remote_file') {
          result = await writeRemoteFile(args.path, args.content);
        } else if (name === 'upload_image') {
          result = await uploadImage(args.base64_data, args.remote_path);
        }

        send({ type: 'tool_result', name, result });
        fnResponses.push({ functionResponse: { name, response: result } });
      }

      // Send tool results back to Gemini and continue
      response = await chat.sendMessage(fnResponses);
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
