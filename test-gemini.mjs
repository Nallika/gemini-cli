import { GoogleGenerativeAI } from "@google/generative-ai";

// Debug: Ensure the key is actually being read
if (!process.env.GEMINI_API_KEY) {
    console.error("Missing GEMINI_API_KEY environment variable!");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Use the explicit 'models/' prefix which helps resolve the 404
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

async function run() {
  try {
    const prompt = "Explain why the Raspberry Pi 5 is a beast for developers.";
    const result = await model.generateContent(prompt);
    const response = await result.response;
    console.log(response.text());
  } catch (err) {
    console.error("API Error:", err.message);
  }
}

run();
