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
      exit_code: result.code,
      success: result.code === 0,
    };
  } catch (err) {
    return { error: err.message, success: false };
  }
}

function timestampSuffix() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
}

async function readRemoteFile(remotePath) {
  const ssh = new NodeSSH();
  try {
    await ssh.connect(getSSHConfig());
    const tmpFile = path.join(os.tmpdir(), `coworker_read_${Date.now()}`);
    await ssh.getFile(tmpFile, remotePath);
    const content = fs.readFileSync(tmpFile, 'utf8');
    fs.unlinkSync(tmpFile);
    ssh.dispose();
    return { success: true, path: remotePath, content, bytes: content.length };
  } catch (err) {
    return { error: err.message, success: false };
  }
}

async function editRemoteFile(remotePath, oldString, newString, replaceAll = false) {
  const ssh = new NodeSSH();
  try {
    await ssh.connect(getSSHConfig());

    const tmpFile = path.join(os.tmpdir(), `coworker_edit_${Date.now()}`);
    await ssh.getFile(tmpFile, remotePath);
    const original = fs.readFileSync(tmpFile, 'utf8');

    const occurrences = original.split(oldString).length - 1;
    if (occurrences === 0) {
      fs.unlinkSync(tmpFile);
      ssh.dispose();
      return {
        success: false,
        error: `old_string not found in ${remotePath}. Read the file first with read_remote_file and copy the exact text (including whitespace).`,
      };
    }
    if (occurrences > 1 && !replaceAll) {
      fs.unlinkSync(tmpFile);
      ssh.dispose();
      return {
        success: false,
        error: `old_string appears ${occurrences} times in ${remotePath}. Add more surrounding context to make it unique, or pass replace_all: true.`,
      };
    }

    const updated = replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, newString);

    const backupPath = `${remotePath}.bak.${timestampSuffix()}`;
    const cp = await ssh.execCommand(`cp -p "${remotePath}" "${backupPath}"`);
    if (cp.code !== 0) {
      fs.unlinkSync(tmpFile);
      ssh.dispose();
      return { success: false, error: `Backup failed before edit: ${cp.stderr || 'unknown error'}` };
    }

    fs.writeFileSync(tmpFile, updated, 'utf8');
    await ssh.putFile(tmpFile, remotePath);
    fs.unlinkSync(tmpFile);
    ssh.dispose();

    return {
      success: true,
      path: remotePath,
      backup: backupPath,
      replacements: replaceAll ? occurrences : 1,
      bytes_before: original.length,
      bytes_after: updated.length,
    };
  } catch (err) {
    return { error: err.message, success: false };
  }
}

async function writeRemoteFile(remotePath, content, confirmFullRewrite = false) {
  const ssh = new NodeSSH();
  try {
    await ssh.connect(getSSHConfig());

    const stat = await ssh.execCommand(`stat -c%s "${remotePath}" 2>/dev/null || echo MISSING`);
    const raw = (stat.stdout || '').trim();
    const exists = raw !== 'MISSING' && /^\d+$/.test(raw);
    const newSize = Buffer.byteLength(content, 'utf8');

    if (exists) {
      const beforeSize = parseInt(raw, 10);
      if (beforeSize > 1024 && newSize < beforeSize * 0.5 && !confirmFullRewrite) {
        ssh.dispose();
        const pct = Math.round((1 - newSize / beforeSize) * 100);
        return {
          success: false,
          error: `REFUSED: write_remote_file would shrink ${remotePath} from ${beforeSize} bytes to ${newSize} bytes (${pct}% reduction). This usually means you sent a partial file instead of the full content. Use edit_remote_file for targeted changes. If you genuinely intend to replace the entire file with much smaller content, retry with confirm_full_rewrite: true.`,
          existing_size: beforeSize,
          attempted_size: newSize,
        };
      }
      const backupPath = `${remotePath}.bak.${timestampSuffix()}`;
      await ssh.execCommand(`cp -p "${remotePath}" "${backupPath}"`);
    }

    const tmpFile = path.join(os.tmpdir(), `coworker_${Date.now()}`);
    fs.writeFileSync(tmpFile, content, 'utf8');
    await ssh.putFile(tmpFile, remotePath);
    fs.unlinkSync(tmpFile);
    ssh.dispose();
    return {
      success: true,
      path: remotePath,
      bytes_written: newSize,
      replaced_existing: exists,
    };
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
    description: 'Run a shell command on the Hostinger server. Use for reading files, listing directories, running git, etc. Returns stdout, stderr, and exit code.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute on the server' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_remote_file',
    description: 'Read the full contents of a remote file. ALWAYS use this before editing — your edit_remote_file old_string must match the file exactly.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full absolute path on the server' },
      },
      required: ['path'],
    },
  },
  {
    name: 'edit_remote_file',
    description: 'SAFE editing tool. Replaces old_string with new_string in a remote file via targeted string replacement, then writes the result back. Auto-creates a timestamped backup. Prefer this over write_remote_file for any change to an existing file. old_string must appear exactly once in the file (or pass replace_all: true).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full absolute path on the server' },
        old_string: { type: 'string', description: 'The exact text to replace. Include enough surrounding context (e.g. a few lines around the change) to make it unique within the file.' },
        new_string: { type: 'string', description: 'The replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match. Default false.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'write_remote_file',
    description: 'DANGEROUS: writes the FULL content provided to a remote file, replacing whatever was there. Use ONLY for creating brand-new files or when you genuinely intend to replace an entire file. For changing parts of an existing file, ALWAYS use edit_remote_file instead. The server refuses writes that would shrink an existing file by >50% unless confirm_full_rewrite is true. Auto-creates a timestamped backup of the existing file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full absolute path on the server' },
        content: { type: 'string', description: 'COMPLETE file content. Not a fragment. The entire file as it should exist after the write.' },
        confirm_full_rewrite: { type: 'boolean', description: 'Set to true to override the size-shrink safety guard. Only use when you really mean to replace the whole file with much smaller content.' },
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

🚨 CRITICAL EDITING RULES — read carefully before every edit:

1. To change ANY existing file, use edit_remote_file. It does targeted string replacement and auto-backs up. This is the safe default for 99% of tasks.

2. NEVER use write_remote_file to "change one thing" in an existing file. write_remote_file replaces the ENTIRE file. If you only send a snippet (e.g. just a <title> tag), the entire file becomes that snippet — every other element gets wiped. The server will refuse drastic shrinks, but the rule above is the actual safeguard.

3. ONLY use write_remote_file when:
   - Creating a brand-new file that doesn't exist yet, OR
   - Genuinely replacing an entire existing file, in which case the content parameter must be the COMPLETE new file (read it first, modify in your head/output, send the whole thing back). For shrinking rewrites pass confirm_full_rewrite: true.

4. Before any edit_remote_file call, read the relevant part of the file (read_remote_file or run_ssh_command "sed -n '...'") so your old_string matches exactly — including whitespace and indentation.

5. After every change, verify by reading back the changed region and confirm the change landed and surrounding content is intact.

6. The server auto-creates timestamped .bak files (file.html.bak.<timestamp>) on every edit and write. Never delete .bak files.

7. Match the existing code style and indentation when writing replacements.

8. Report what changed, which files, and the live URL path after each task.

9. If a request is ambiguous, ask before acting.

Tools: run_ssh_command, read_remote_file, edit_remote_file, write_remote_file, upload_image.`;

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
          } else if (toolUse.name === 'read_remote_file') {
            result = await readRemoteFile(toolUse.input.path);
          } else if (toolUse.name === 'edit_remote_file') {
            result = await editRemoteFile(
              toolUse.input.path,
              toolUse.input.old_string,
              toolUse.input.new_string,
              toolUse.input.replace_all === true,
            );
          } else if (toolUse.name === 'write_remote_file') {
            result = await writeRemoteFile(
              toolUse.input.path,
              toolUse.input.content,
              toolUse.input.confirm_full_rewrite === true,
            );
          } else if (toolUse.name === 'upload_image') {
            result = await uploadImage(toolUse.input.base64_data, toolUse.input.remote_path);
          } else {
            result = { success: false, error: `Unknown tool: ${toolUse.name}` };
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
