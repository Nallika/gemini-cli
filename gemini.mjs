#!/usr/bin/env node

import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';
import chalk from 'chalk';

const API_KEY = process.env.GEMINI_API_KEY;
const BASE_PATH = '/mnt/data/projects/ai_tools/gemini-cli';

// --- Context & Env Gathering ---
const cwd = process.cwd();
let fileList = "";
try {
  // Smart find to get deeper context without overloading the token window with node_modules or .git
  fileList = execSync('find . -maxdepth 3 -not -path "*/node_modules/*" -not -path "*/.git/*"').toString().trim();
} catch (e) {
  fileList = "Could not retrieve file list.";
}

// --- Config & Model Selection ---
let config = { defaultModel: "flash", models: { "flash": "gemini-3-flash" } };
try {
  const configData = fs.readFileSync(path.join(BASE_PATH, 'config.json'), 'utf8');
  config = JSON.parse(configData);
} catch (e) {
  console.warn(chalk.yellow("\n[Warning]: config.json not found. Using default flash model.\n"));
}

// Check for the -m flag (e.g., -m pro)
let selectedModelAlias = config.defaultModel;
const mIndex = process.argv.indexOf('-m');
if (mIndex > -1 && process.argv.length > mIndex + 1) {
  selectedModelAlias = process.argv[mIndex + 1];
}

// Resolve the alias to the actual model string, fallback to default if typo
const actualModelString = config.models[selectedModelAlias] || config.models[config.defaultModel];

// Determine Context / Bot Persona
let contextName = "default";
const cIndex = process.argv.indexOf('-c');
if (cIndex > -1 && process.argv.length > cIndex + 1) {
  contextName = process.argv[cIndex + 1];
}

const contextPath = path.join(BASE_PATH, 'contexts', `${contextName}.md`);
const defaultPath = path.join(BASE_PATH, 'contexts', 'default.md');
let rawInstructions = "";

try {
  rawInstructions = fs.readFileSync(contextPath, 'utf8');
} catch (e) {
  if (contextName !== "default") {
    console.warn(chalk.yellow(`\n[Warning]: Context file 'contexts/${contextName}.md' not found. Falling back to default.md.\n`));
  }
  try {
    rawInstructions = fs.readFileSync(defaultPath, 'utf8');
  } catch (fallbackError) {
    console.warn(chalk.yellow(`\n[Warning]: 'contexts/default.md' not found either. Using hardcoded fallback.\n`));
    rawInstructions = "You are an expert AI CLI assistant.";
  }
}

// Combine system instructions with live environment data
const systemInstructions = `${rawInstructions}
[ENVIRONMENT_CONTEXT]
CURRENT_WORKING_DIRECTORY: ${cwd}
FILES_IN_CURRENT_DIRECTORY:
${fileList}
PLATFORM: Raspberry Pi 5 (Ubuntu 24.04 ARM64)
DATE: ${new Date().toISOString().split('T')[0]}
`;

// --- Tool Definitions ---
const tools = [
  {
    functionDeclarations: [
      {
        name: "run_shell_command",
        description: "Execute a shell command on the Pi 5. Use for navigation, package management, docker deployment, or system checks.",
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

// --- Initialization & State ---
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({
  model: actualModelString,
  systemInstruction: systemInstructions,
  tools: tools,
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askPermission = (query) => new Promise((resolve) => rl.question(query, resolve));

// Global session state for permissions
let sessionReadWriteApproved = false;

// --- Loading Animation ---
let spinnerInterval;

function startSpinner(text = "Thinking...") {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  spinnerInterval = setInterval(() => {
    // \r moves the cursor to the start of the line, keeping the animation in place
    process.stdout.write(`\r${chalk.cyan(frames[i])} ${chalk.dim(text)}`);
    i = (i + 1) % frames.length;
  }, 80);
}

function stopSpinner() {
  clearInterval(spinnerInterval);
  process.stdout.write('\r\x1b[K'); // \x1b[K clears the current line completely
}

// --- Core Logic: Processing a Single Turn ---
async function processTurn(prompt, chat) {
  startSpinner("Gemini is thinking...");

  let result = await chat.sendMessage(prompt);

  stopSpinner();

  while (result.response.candidates[0].content.parts.some(p => p.functionCall)) {
    const parts = result.response.candidates[0].content.parts;
    const functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
    const functionResponses = [];

    for (const call of functionCalls) {
      const safeArgsLog = JSON.stringify(call.args).length > 150 
          ? JSON.stringify(call.args).substring(0, 150) + '...}' 
          : JSON.stringify(call.args);
      
      console.log(chalk.yellow(`\n[AI Action Request]: ${call.name} -> ${safeArgsLog}`));

      let isApproved = false;
      let isSkipped = false;

      // Permission Logic Routing
      if (call.name === "run_shell_command") {
        const answer = await askPermission(chalk.magentaBright(`Allow this shell command? (y/n/skip): `));
        isApproved = answer.toLowerCase() === 'y';
        isSkipped = answer.toLowerCase() === 'skip';
      } else if (call.name === "read_file" || call.name === "write_file") {
        if (sessionReadWriteApproved) {
          console.log(chalk.dim(`(Auto-approved based on session permission)`));
          isApproved = true;
        } else {
          const answer = await askPermission(chalk.magentaBright(`Allow ALL file read/write operations for this session? (y/n/skip): `));
          if (answer.toLowerCase() === 'y') {
            sessionReadWriteApproved = true;
            isApproved = true;
          } else if (answer.toLowerCase() === 'skip') {
            isSkipped = true;
          }
        }
      }

      let output = "";
      let errorMsg = null;

      if (isApproved) {
        try {
          if (call.name === "run_shell_command") {
            output = execSync(call.args.command, { stdio: 'pipe' }).toString();
            if (output.length > 2000) {
                output = output.substring(0, 2000) + "\n...[OUTPUT TRUNCATED]...";
            }
          } else if (call.name === "write_file") {
            const fullPath = path.resolve(cwd, call.args.path);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, call.args.content);
            output = `Successfully wrote file: ${call.args.path}`;
          } else if (call.name === "read_file") {
            output = fs.readFileSync(path.resolve(cwd, call.args.path), 'utf8');
          }
        } catch (err) {
          errorMsg = err.message;
        }
      } else if (isSkipped) {
         errorMsg = "User explicitly skipped this action.";
      } else {
         errorMsg = "User denied permission.";
      }

      if (errorMsg) {
          functionResponses.push({ functionResponse: { name: call.name, response: { error: errorMsg } } });
      } else {
          functionResponses.push({ functionResponse: { name: call.name, response: { content: output } } });
      }
    }

    startSpinner("Processing tool results...");

    result = await chat.sendMessage(functionResponses);

    stopSpinner();
  }
  return result.response.text();
}

// --- Interactive REPL Loop ---
async function startInteractiveSession(chat) {
  console.log(chalk.green(`\n=== Interactive Session Started ===`));
  console.log(chalk.dim(`Type 'exit' or 'quit' to end. Context and permissions are retained.`));
  
  while (true) {
    const input = await askPermission(chalk.cyan(`\nYou: `));
    
    if (input.toLowerCase().trim() === 'exit' || input.toLowerCase().trim() === 'quit') {
      console.log(chalk.green("Exiting interactive session. Goodbye!"));
      break;
    }
    if (!input.trim()) continue;

    try {
      const response = await processTurn(input, chat);
      console.log(chalk.blue(`\n[Gemini]:\n${response}`));
    } catch (error) {
      console.error(chalk.red("\n[Error during turn]:", error.message));
    }
  }
}

// --- Main Execution & Routing ---
async function run() {
  let argsToProcess = process.argv.slice(2);

  // Parse and strip flags
  const flagsToRemove = ['-m', '-c'];
  flagsToRemove.forEach(flag => {
    const idx = argsToProcess.indexOf(flag);
    if (idx > -1) argsToProcess.splice(idx, 2);
  });

  // Check for interactive flag
  const interactiveIdx = argsToProcess.findIndex(arg => arg === '-i' || arg === '--interactive');
  const isInteractive = interactiveIdx > -1;
  if (isInteractive) {
    argsToProcess.splice(interactiveIdx, 1);
  }

  const userPrompt = argsToProcess.filter(arg => !arg.startsWith('-')).join(" ");
  
  if (!userPrompt && !isInteractive) { 
    console.log(chalk.green("Usage: gemini [-i] [-m model_alias] [-c context_name] <prompt>"));
    console.log(chalk.green("       gemini -i")); 
    process.exit(0); 
  }

  let chat = model.startChat();

  try {
    // 1. One-shot command or starting prompt for REPL
    if (userPrompt) {
      const response = await processTurn(userPrompt, chat);
      console.log(chalk.blue(`\n[Gemini]:\n${response}`));
    }

    // 2. Drop into REPL if requested
    if (isInteractive) {
      await startInteractiveSession(chat);
    }
  } catch (error) {
      console.error(chalk.red("\n[Fatal Error]:", error.message));
  } finally {
      rl.close();
  }
}

// Handle unexpected exits gracefully
process.on('SIGINT', () => {
  console.log(chalk.green("\nSession terminated by user."));
  process.exit(0);
});

run();