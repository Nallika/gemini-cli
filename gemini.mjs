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
  console.warn(chalk.orange("\n[Warning]: config.json not found. Using default flash model.\n"));
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
    console.warn(chalk.orange(`\n[Warning]: Context file 'contexts/${contextName}.md' not found. Falling back to default.md.\n`));
  }
  try {
    rawInstructions = fs.readFileSync(defaultPath, 'utf8');
  } catch (fallbackError) {
    console.warn(chalk.orange(`\n[Warning]: 'contexts/default.md' not found either. Using hardcoded fallback.\n`));
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

// --- Implementation Logic ---
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({
  model: actualModelString,
  systemInstruction: systemInstructions,
  tools: tools,
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askPermission = (query) => new Promise((resolve) => rl.question(query, resolve));

async function run() {
  // Extract user prompt, safely stripping out flags and their parameters
  let argsToProcess = process.argv.slice(2);

  // Strip -m and its value
  const mFlagIdx = argsToProcess.indexOf('-m');
  if (mFlagIdx > -1) {
    argsToProcess.splice(mFlagIdx, 2);
  }

  // Strip -c and its value
  const cFlagIdx = argsToProcess.indexOf('-c');
  if (cFlagIdx > -1) {
    argsToProcess.splice(cFlagIdx, 2);
  }

  const userPrompt = argsToProcess.filter(arg => !arg.startsWith('-')).join(" ");
  if (!userPrompt) { 
    console.log(chalk.green("Usage: gemini [-m model_alias] [-c context_name] <prompt>")); 
    process.exit(0); 
  }

  let chat = model.startChat();

  try {
    let result = await chat.sendMessage(userPrompt);

    // --- The Agentic Loop ---
    while (result.response.candidates[0].content.parts.some(p => p.functionCall)) {
      const parts = result.response.candidates[0].content.parts;
      const functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
      
      const functionResponses = [];

      // Process all function calls sequentially to handle parallel execution requests
      for (const call of functionCalls) {
        // Truncate the logged args so massive file writes don't flood your terminal
        const safeArgsLog = JSON.stringify(call.args).length > 150 
            ? JSON.stringify(call.args).substring(0, 150) + '...}' 
            : JSON.stringify(call.args);
        
        console.log(chalk.yellow(`\n[AI Action Request]: ${call.name} -> ${safeArgsLog}`));

        const answer = await askPermission("Allow this action? (y/n/skip): ");
        
        let output = "";
        let errorMsg = null;

        if (answer.toLowerCase() === 'y') {
          try {
            if (call.name === "run_shell_command") {
              output = execSync(call.args.command, { stdio: 'pipe' }).toString();
              // Prevent token window explosion from massive shell outputs
              if (output.length > 2000) {
                  output = output.substring(0, 2000) + "\n...[OUTPUT TRUNCATED]...";
              }
            } else if (call.name === "write_file") {
              const fullPath = path.resolve(cwd, call.args.path);
              // Ensure the target directory exists before writing
              fs.mkdirSync(path.dirname(fullPath), { recursive: true });
              fs.writeFileSync(fullPath, call.args.content);
              output = `Successfully wrote file: ${call.args.path}`;
            } else if (call.name === "read_file") {
              output = fs.readFileSync(path.resolve(cwd, call.args.path), 'utf8');
            }
          } catch (err) {
            errorMsg = err.message;
          }
        } else if (answer.toLowerCase() === 'skip') {
           errorMsg = "User explicitly skipped this action.";
        } else {
           errorMsg = "User denied permission.";
        }

        // Push the result or error into the responses array
        if (errorMsg) {
            functionResponses.push({
                functionResponse: { name: call.name, response: { error: errorMsg } }
            });
        } else {
            functionResponses.push({
                functionResponse: { name: call.name, response: { content: output } }
            });
        }
      }

      // Send all parallel function execution results back to the model at once
      result = await chat.sendMessage(functionResponses);
    }

    console.log(chalk.blue(`\n[Gemini]:\n` + result.response.text()));

  } catch (error) {
      console.error(chalk.red("\n[Fatal Error]:", error.message));
  } finally {
      rl.close();
  }
}

run();
