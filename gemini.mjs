#!/usr/bin/env node

import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';

const API_KEY = process.env.GEMINI_API_KEY;
const BASE_PATH = '/mnt/data/projects/ai_tools/gemini-cli';

// --- Context & Env Gathering ---
const cwd = process.cwd();
let fileList = "";
try {
    // Get a clean list of files in the current directory (non-recursive for speed)
    fileList = execSync('ls -p').toString().trim();
} catch (e) {
    fileList = "Could not retrieve file list.";
}

// 1. Determine which "Bot" to use
const isNetMode = process.argv.includes('-net');
const contextFile = isNetMode ? 'network_context.md' : 'coder_context.md';
const rawInstructions = fs.readFileSync(path.join(BASE_PATH, contextFile), 'utf8');

// Combine system instructions with live environment data
const systemInstructions = `${rawInstructions}
[ENVIRONMENT_CONTEXT]
CURRENT_WORKING_DIRECTORY: ${cwd}
FILES_IN_CURRENT_DIRECTORY:
${fileList}
PLATFORM: Raspberry Pi 5 (Ubuntu 24.04 ARM64)
DATE: ${new Date().toISOString().split('T')[0]} (2026)
`;

// --- Tool Definitions ---
const tools = [
  {
    functionDeclarations: [
      {
        name: "run_shell_command",
        description: "Execute a shell command on the Pi 5. Use for navigation, package management, or system checks.",
        parameters: {
          type: "OBJECT",
          properties: { command: { type: "STRING", description: "The full shell command" } },
          required: ["command"]
        }
      },
      {
        name: "write_file",
        description: "Create or overwrite a file at a specific path with content.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Relative or absolute path" },
            content: { type: "STRING", description: "Full content of the file" }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "read_file",
        description: "Read the contents of a file to understand code or configuration.",
        parameters: {
          type: "OBJECT",
          properties: { path: { type: "STRING", description: "Path to the file" } },
          required: ["path"]
        }
      }
    ]
  }
];

// --- Implementation Logic ---
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-3-flash-preview",
  systemInstruction: systemInstructions,
  tools: tools,
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askPermission = (query) => new Promise((resolve) => rl.question(query, resolve));

async function run() {
  const userPrompt = process.argv.slice(2).filter(arg => arg !== '-net').join(" ");
  if (!userPrompt) { console.log("Usage: gemini [-net] <prompt>"); process.exit(0); }

  let chat = model.startChat();
  let result = await chat.sendMessage(userPrompt);

  // --- The Agentic Loop ---
  while (result.response.candidates[0].content.parts.some(p => p.functionCall)) {
    const call = result.response.candidates[0].content.parts.find(p => p.functionCall).functionCall;
    console.log(`\n[AI Action Request]: ${call.name} -> ${JSON.stringify(call.args)}`);

    const answer = await askPermission("Allow this action? (y/n/skip): ");
    
    let functionResponse;
    if (answer.toLowerCase() === 'y') {
      try {
        let output = "";
        if (call.name === "run_shell_command") {
          output = execSync(call.args.command, { stdio: 'pipe' }).toString();
        } else if (call.name === "write_file") {
          fs.writeFileSync(path.resolve(cwd, call.args.path), call.args.content);
          output = `Successfully wrote file: ${call.args.path}`;
        } else if (call.name === "read_file") {
          output = fs.readFileSync(path.resolve(cwd, call.args.path), 'utf8');
        }
        functionResponse = { name: call.name, response: { content: output } };
      } catch (err) {
        functionResponse = { name: call.name, response: { error: err.message } };
      }
    } else {
      functionResponse = { name: call.name, response: { error: "User denied permission." } };
    }

    result = await chat.sendMessage([{ functionResponse }]);
  }

  console.log(`\n[Bot]:\n` + result.response.text());
  rl.close();
}

run();
