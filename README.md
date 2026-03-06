# Morphi Intelligence

> **v1.0.3 preview beta** | Roblox Studio AI Orchestrator

Morphi is a powerful, AI-driven assistant designed specifically for Roblox development. It integrates directly with Roblox Studio using the Model Context Protocol (MCP), providing real-time coding assistance, system design, and debugging through a sleek, ChatGPT-inspired interface.

![Morphi Banner](https://i.ibb.co/6RMCF4zh/Black-and-Dark-Space-Photo-You-Tube-Thumbnail.png)

---

## 🚀 Key Features

- **Roblox Studio Integration (MCP)**: Talk directly to your Studio environment. Perform file operations, execute commands, and query system states via a secure connection.
- **ChatGPT-Inspired UI**: A modern, minimal, and premium interface built with React, Framer Motion, and Tailwind CSS.
- **Dynamic Model Selection**: Integration with top-tier AI models from OpenAI (GPT-4o), Google (Gemini 2.0 Flash/Pro), and more.
- **Project & Session Management**: Organize your work into distinct projects and searchable chat sessions with a flat, intuitive sidebar.
- **Code Intelligence**: Built-in syntax highlighting, one-click copy, and specialized "Suggestion Chips" for common Roblox scripting tasks.
- **Robust Error Handling**: Real-time toast notifications and inline error reporting to keep your workflow smooth.
- **Customizable Appearance**: Native support for Light and Dark modes with smooth transitions.

## 🛠️ Tech Stack

- **Frontend**: [React](https://reactjs.org/), [Vite](https://vitejs.dev/), [Tailwind CSS](https://tailwindcss.com/)
- **Backend**: [Node.js](https://nodejs.org/), [Express](https://expressjs.com/), [Better-SQLite3](https://github.com/WiseLibs/better-sqlite3)
- **Desktop**: [Electron](https://www.electronjs.org/)
- **Protocol**: [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
- **Animations**: [Framer Motion](https://www.framer.com/motion/)
- **Icons**: [Lucide React](https://lucide.dev/)

## 📦 Installation & Setup

### Prerequisites
- [Node.js](https://nodejs.org/) (v20+ recommended)
- [Roblox Studio](https://www.roblox.com/create)

### Steps

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Nildadev/Morphi-Intelligence.git
   cd Morphi-Intelligence
   ```

2. **Install dependencies**:
   ```bash
   npm install
   cd client && npm install
   cd ../server && npm install
   ```

3. **Configure Environment Variables**:
   Create a `.env` file in the `server` directory and add your API keys:
   ```env
   OPENAI_API_KEY=your_key_here
   GOOGLE_API_KEY=your_key_here
   PROXYPAL_API_KEY=your_key_here
   ```

4. **Build & Start**:
   ```bash
   # Build both client and server
   npm run build
   
   # Run the Electron app
   npm start
   ```

## 🎮 Roblox Studio Setup

To enable AI orchestration, you must install and activate the **Morphi MCP Plugin** in Roblox Studio.

1. Open Roblox Studio.
2. Ensure the plugin is set to **ON** in the Plugins tab.
3. The Morphi desktop app will automatically detect and connect to the Studio session.

## 🛡️ License

This project is licensed under the [ISC License](LICENSE).

---
*Created by **Nildadev** | Morphi Intelligence v1.0.3 preview beta*
