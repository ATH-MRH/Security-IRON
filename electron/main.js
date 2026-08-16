/**
 * SécuriSite — Process principal Electron
 * ----------------------------------------
 * Démarre le serveur local (Express + SQLite) puis ouvre la fenêtre native.
 * Le serveur écoute sur toutes les interfaces (0.0.0.0) pour que d'autres
 * postes du réseau local (chef, agents) puissent s'y connecter — Modèle B.
 */
const { app, BrowserWindow, Menu, shell, session, dialog } = require('electron');
const path = require('path');
const os   = require('os');

// La base doit vivre dans un dossier INSCRIPTIBLE (pas dans l'app en lecture seule).
process.env.SECURISITE_DATA_DIR = path.join(app.getPath('userData'), 'data');

// Port fixe par défaut pour que les postes du réseau gardent la même adresse.
const DEFAULT_PORT = Number(process.env.SECURISITE_PORT) || 4600;

let mainWindow = null;
let serverPort = DEFAULT_PORT;

/* Adresses IP locales (pour indiquer aux agents l'URL du serveur) */
function lanAddresses() {
  const list = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of (nets[name] || [])) {
      if (ni.family === 'IPv4' && !ni.internal) list.push(ni.address);
    }
  }
  return list;
}

/* Démarre le serveur local (port fixe, sinon port libre de secours) */
async function bootServer() {
  const { start } = require('../server.js');
  try {
    const { port } = await start({ port: DEFAULT_PORT, host: '0.0.0.0' });
    serverPort = port;
  } catch (err) {
    console.warn(`[Electron] Port ${DEFAULT_PORT} indisponible (${err.code || err.message}), choix d'un port libre…`);
    const { port } = await start({ port: 0, host: '0.0.0.0' });
    serverPort = port;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320, height: 860,
    minWidth: 900, minHeight: 600,
    backgroundColor: '#0b1220',
    title: 'SécuriSite',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Ouvrir les liens externes dans le navigateur système, pas dans l'app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* Autorise caméra/micro (scan QR, LAPI) + presse-papier pour l'app locale */
function setupPermissions() {
  const allowed = new Set(['media', 'camera', 'microphone', 'clipboard-read', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed.has(permission));
}

function showNetworkInfo() {
  const ips = lanAddresses();
  const lignes = ips.length
    ? ips.map(ip => `   http://${ip}:${serverPort}`).join('\n')
    : '   (aucune adresse réseau détectée)';
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Accès réseau local',
    message: 'Adresses pour connecter les autres postes (chef, agents)',
    detail:
      `Sur ce poste (serveur) :\n   http://localhost:${serverPort}\n\n` +
      `Depuis un autre poste du même réseau :\n${lignes}\n\n` +
      `Les agents ouvrent une de ces adresses (ou l'app SécuriSite) et se connectent avec leur compte.`,
    buttons: ['Fermer'],
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Fichier',
      submenu: [
        { label: 'Accès réseau local…', click: showNetworkInfo },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Quitter' },
      ],
    },
    {
      label: 'Affichage',
      submenu: [
        { role: 'reload', label: 'Recharger' },
        { role: 'forceReload', label: 'Recharger (forcé)' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom normal' },
        { role: 'zoomIn', label: 'Zoom +' },
        { role: 'zoomOut', label: 'Zoom −' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' },
        { role: 'toggleDevTools', label: 'Outils développeur' },
      ],
    },
    {
      label: 'Aide',
      submenu: [
        {
          label: 'À propos de SécuriSite',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info', title: 'À propos',
            message: 'SécuriSite — Centre de Sûreté',
            detail: `Version ${app.getVersion()}\nLogiciel autonome (données locales, hors-ligne).`,
            buttons: ['Fermer'],
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  setupPermissions();
  await bootServer();
  createWindow();
  buildMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
