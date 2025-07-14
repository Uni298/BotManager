// Discord BOT Manager Web App (Node.js + Express + EJS + Tailwind)
// npm install express express-session multer fs-extra adm-zip dotenv ejs
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const AdmZip = require('adm-zip');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 8080;
const BOT_DIR = path.join(__dirname, 'bots');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const upload = multer({ dest: UPLOAD_DIR });
let botProcesses = {};
let botLogs = {};

app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'secret-key', resave: false, saveUninitialized: true }));
app.use('/public', express.static('public'));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

function auth(req, res, next) {
  if (req.session.loggedIn) return next();
  return res.redirect('/login');
}

app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    return res.redirect('/dashboard');
  }
  res.send('Wrong password');
});

app.get('/dashboard', auth, async (req, res) => {
  const botNames = await fs.readdir(BOT_DIR).catch(() => []);
  const bots = botNames.map(name => ({
    name,
    running: !!botProcesses[name]
  }));
  res.render('dashboard', { bots });
});

app.get('/newbot', auth, (req, res) => {
  res.render('newbot');
});

function startBot(botName, command = 'node index.js') {
  const botPath = path.join(BOT_DIR, botName);
  const [cmd, ...args] = command.split(' ');
  const bot = spawn(cmd, args, { cwd: botPath });
  
  if (!botLogs[botName]) {
    botLogs[botName] = [];
  }
  
  bot.stdout.on('data', d => {
    const message = d.toString();
    console.log(`[${botName}] ${message}`);
    botLogs[botName].push({ type: 'stdout', message, timestamp: new Date() });
    io.emit('bot-log', { botName, type: 'stdout', message, timestamp: new Date() });
  });
  
  bot.stderr.on('data', d => {
    const message = d.toString();
    console.error(`[${botName} ERROR] ${message}`);
    botLogs[botName].push({ type: 'stderr', message, timestamp: new Date() });
    io.emit('bot-log', { botName, type: 'stderr', message, timestamp: new Date() });
  });
  
  bot.on('exit', code => {
    const message = `exited with code ${code}`;
    console.log(`[${botName}] ${message}`);
    botLogs[botName].push({ type: 'exit', message, timestamp: new Date() });
    io.emit('bot-log', { botName, type: 'exit', message, timestamp: new Date() });
  });
  
  botProcesses[botName] = bot;
}

app.post('/newbot', auth, upload.single('zip'), async (req, res) => {
  const botName = req.body.name;
  const zipPath = req.file.path;
  const botPath = path.join(BOT_DIR, botName);
  const zipCopyPath = path.join(botPath, `${botName}.zip`);

  await fs.mkdirp(botPath);
  await fs.copy(zipPath, zipCopyPath);

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(botPath, true);
  await fs.remove(zipPath);

  const packageJsonPath = path.join(botPath, 'package.json');
  const packageTxtPath = path.join(botPath, 'package.txt');

  if (await fs.exists(packageJsonPath)) {
    await new Promise((resolve, reject) => {
      const npmInstall = spawn('npm', ['install'], { cwd: botPath });
      npmInstall.on('exit', code => code === 0 ? resolve() : reject());
    });
  } else if (await fs.exists(packageTxtPath)) {
    const content = await fs.readFile(packageTxtPath, 'utf-8');
    const packages = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (packages.length > 0) {
      await new Promise((resolve, reject) => {
        const npmInstall = spawn('npm', ['install', ...packages], { cwd: botPath });
        npmInstall.on('exit', code => code === 0 ? resolve() : reject());
      });
    }
  }

  // デフォルトの起動コマンドを保存
  const configPath = path.join(botPath, 'bot-config.json');
  const defaultConfig = { startCommand: 'node index.js' };
  await fs.writeJSON(configPath, defaultConfig);

  startBot(botName);
  res.redirect('/dashboard');
});

app.post('/stop/:name', auth, (req, res) => {
  const name = req.params.name;
  if (botProcesses[name]) {
    botProcesses[name].kill();
    delete botProcesses[name];
  }
  res.redirect('/dashboard');
});

app.post('/start/:name', auth, async (req, res) => {
  const name = req.params.name;
  if (!botProcesses[name]) {
    const botPath = path.join(BOT_DIR, name);
    const configPath = path.join(botPath, 'bot-config.json');
    let config = { startCommand: 'node index.js' };
    
    try {
      config = await fs.readJSON(configPath);
    } catch (e) {
      await fs.writeJSON(configPath, config);
    }
    
    startBot(name, config.startCommand);
  }
  res.redirect('/dashboard');
});

app.post('/delete/:name', auth, async (req, res) => {
  const name = req.params.name;
  if (botProcesses[name]) {
    botProcesses[name].kill();
    delete botProcesses[name];
  }
  await fs.remove(path.join(BOT_DIR, name));
  res.redirect('/dashboard');
});

async function getAllFiles(dir, relativePath = '') {
  const files = [];
  const items = await fs.readdir(dir);
  
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const relativeItemPath = relativePath ? path.join(relativePath, item) : item;
    const stat = await fs.stat(fullPath);
    
    if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
      files.push(...await getAllFiles(fullPath, relativeItemPath));
    } else if (stat.isFile() && (item.endsWith('.js') || item.endsWith('.json') || item.endsWith('.txt') || item.endsWith('.md'))) {
      files.push(relativeItemPath);
    }
  }
  
  return files;
}

app.get('/manager/:name', auth, async (req, res) => {
  const botPath = path.join(BOT_DIR, req.params.name);
  const files = await getAllFiles(botPath);
  const fileToEdit = req.query.file || 'index.js';
  const filePath = path.join(botPath, fileToEdit);
  const code = await fs.readFile(filePath, 'utf-8').catch(() => '// 読み込めません');
  
  // 起動コマンド設定を読み込み
  const configPath = path.join(botPath, 'bot-config.json');
  let config = { startCommand: 'node index.js' };
  try {
    config = await fs.readJSON(configPath);
  } catch (e) {
    await fs.writeJSON(configPath, config);
  }
  
  res.render('manager', {
    botName: req.params.name,
    files,
    file: fileToEdit,
    code,
    startCommand: config.startCommand
  });
});

app.post('/manager/:name', auth, async (req, res) => {
  const botPath = path.join(BOT_DIR, req.params.name);
  const filePath = path.join(botPath, req.body.file);
  
  // ディレクトリが存在しない場合は作成
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, req.body.code);
  res.redirect(`/manager/${req.params.name}?file=${encodeURIComponent(req.body.file)}`);
});

app.get('/api/logs/:name', auth, (req, res) => {
  const botName = req.params.name;
  const logs = botLogs[botName] || [];
  res.json(logs);
});

app.post('/api/input/:name', auth, (req, res) => {
  const botName = req.params.name;
  const input = req.body.input;
  
  if (botProcesses[botName]) {
    botProcesses[botName].stdin.write(input + '\n');
    botLogs[botName].push({ type: 'stdin', message: input, timestamp: new Date() });
    io.emit('bot-log', { botName, type: 'stdin', message: input, timestamp: new Date() });
  }
  
  res.json({ success: true });
});

app.post('/api/config/:name', auth, async (req, res) => {
  const botName = req.params.name;
  const { startCommand } = req.body;
  const botPath = path.join(BOT_DIR, botName);
  const configPath = path.join(botPath, 'bot-config.json');
  
  const config = { startCommand };
  await fs.writeJSON(configPath, config);
  
  res.json({ success: true });
});

io.on('connection', (socket) => {
  console.log('Client connected');
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

fs.mkdirpSync(BOT_DIR);
fs.mkdirpSync(UPLOAD_DIR);

server.listen(PORT, () => {
  console.log(`Bot Manager running on http://localhost:${PORT}`);
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (input) => {
  if (input.trim() === 'exit') {
    console.log('Shutting down...');
    Object.values(botProcesses).forEach(proc => proc.kill());
    process.exit(0);
  }
});
