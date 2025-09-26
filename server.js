const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors()); // Autoriser requêtes cross-origin
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Stockage en mémoire
let storedConfig = {
  feedingTimes: [],
  securityTimes: [],
  thresholds: {
    minTemperature: 25.0,
    maxTemperature: 30.0,
    turbidityThreshold: 70.0
  },
  wifiConfig: {
    ssid: "i98",
    password: "12345678"
  }
};
let esp32Client = null;
let androidClients = [];

// Nettoyage périodique des clients Android inactifs
setInterval(() => {
  androidClients = androidClients.filter(client => client.readyState === WebSocket.OPEN);
  console.log('Clients Android actifs:', androidClients.length);
}, 30000);

// Route POST pour configurer les horaires d'alimentation
app.post('/set-feeding-times', (req, res) => {
  try {
    const { feedingTimes } = req.body;
    if (!Array.isArray(feedingTimes) || feedingTimes.length > 5) {
      return res.status(400).json({ message: 'feedingTimes doit être un tableau de maximum 5 éléments' });
    }
    for (let time of feedingTimes) {
      if (!Number.isInteger(time.hour) || !Number.isInteger(time.minute) || !time.foodName ||
          time.hour < 0 || time.hour > 23 || time.minute < 0 || time.minute > 59) {
        return res.status(400).json({ message: 'Format invalide pour feedingTimes' });
      }
    }
    const timesSet = new Set(feedingTimes.map(t => `${t.hour}:${t.minute}`));
    if (timesSet.size !== feedingTimes.length) {
      return res.status(400).json({ message: 'Horaires d\'alimentation en double' });
    }
    storedConfig.feedingTimes = feedingTimes;
    console.log(`Horaires d'alimentation reçus : ${JSON.stringify(feedingTimes, null, 2)} at ${new Date().toISOString()}`);
    res.status(200).json({ message: 'Horaires d\'alimentation configurés' });
    broadcastToAndroidClients({ type: 'feedingTimes', data: feedingTimes });
  } catch (error) {
    console.error('Erreur dans /set-feeding-times:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route POST pour configurer les intervalles de sécurité
app.post('/set-security-times', (req, res) => {
  try {
    const { securityTimes } = req.body;
    if (!Array.isArray(securityTimes) || securityTimes.length > 10) {
      return res.status(400).json({ message: 'securityTimes doit être un tableau de maximum 10 éléments' });
    }
    for (let time of securityTimes) {
      if (!time.startTime || !time.endTime || !/^\d{4}$/.test(time.startTime) || !/^\d{4}$/.test(time.endTime)) {
        return res.status(400).json({ message: 'Format invalide pour securityTimes (attendu : HHMM)' });
      }
    }
    storedConfig.securityTimes = securityTimes;
    console.log(`Intervalles de sécurité reçus : ${JSON.stringify(securityTimes, null, 2)} at ${new Date().toISOString()}`);
    res.status(200).json({ message: 'Intervalles de sécurité configurés' });
    broadcastToAndroidClients({ type: 'securityTimes', data: securityTimes });
  } catch (error) {
    console.error('Erreur dans /set-security-times:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route POST pour configurer les seuils
app.post('/set-thresholds', (req, res) => {
  try {
    const { thresholds } = req.body;
    if (typeof thresholds !== 'object' ||
        typeof thresholds.minTemperature !== 'number' ||
        typeof thresholds.maxTemperature !== 'number' ||
        typeof thresholds.turbidityThreshold !== 'number' ||
        thresholds.minTemperature >= thresholds.maxTemperature) {
      return res.status(400).json({ message: 'Format invalide pour thresholds' });
    }
    storedConfig.thresholds = thresholds;
    console.log(`Seuils reçus : ${JSON.stringify(thresholds, null, 2)} at ${new Date().toISOString()}`);
    res.status(200).json({ message: 'Seuils configurés' });
    broadcastToAndroidClients({ type: 'thresholds', data: thresholds });
  } catch (error) {
    console.error('Erreur dans /set-thresholds:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route POST pour configurer les identifiants WiFi
app.post('/set-wifi-config', (req, res) => {
  try {
    const { wifiConfig } = req.body;
    if (typeof wifiConfig !== 'object' ||
        typeof wifiConfig.ssid !== 'string' ||
        typeof wifiConfig.password !== 'string') {
      return res.status(400).json({ message: 'Format invalide pour wifiConfig' });
    }
    storedConfig.wifiConfig = wifiConfig;
    console.log(`Identifiants WiFi reçus : ${JSON.stringify(wifiConfig, null, 2)} at ${new Date().toISOString()}`);
    res.status(200).json({ message: 'Identifiants WiFi configurés' });
    broadcastToAndroidClients({ type: 'wifiConfig', data: wifiConfig });
  } catch (error) {
    console.error('Erreur dans /set-wifi-config:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route GET pour l'ESP32 - Horaires d'alimentation
app.get('/feeding-times', (req, res) => {
  try {
    console.log(`Envoi des horaires d'alimentation : ${JSON.stringify(storedConfig.feedingTimes, null, 2)} at ${new Date().toISOString()}`);
    res.status(200).json({ feedingTimes: storedConfig.feedingTimes });
  } catch (error) {
    console.error('Erreur dans /feeding-times:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route GET pour l'ESP32 - Intervalles de sécurité
app.get('/security-times', (req, res) => {
  try {
    console.log(`Envoi des intervalles de sécurité : ${JSON.stringify(storedConfig.securityTimes, null, 2)} at ${new Date().toISOString()}`);
    res.status(200).json({ securityTimes: storedConfig.securityTimes });
  } catch (error) {
    console.error('Erreur dans /security-times:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route GET pour l'ESP32 - Seuils
app.get('/thresholds', (req, res) => {
  try {
    console.log(`Envoi des seuils : ${JSON.stringify(storedConfig.thresholds, null, 2)} at ${new Date().toISOString()}`);
    res.status(200).json({ thresholds: storedConfig.thresholds });
  } catch (error) {
    console.error('Erreur dans /thresholds:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route GET pour l'ESP32 - Identifiants WiFi
app.get('/wifi-config', (req, res) => {
  try {
    console.log(`Envoi des identifiants WiFi : ${JSON.stringify(storedConfig.wifiConfig, null, 2)} at ${new Date().toISOString()}`);
    res.status(200).json({ wifiConfig: storedConfig.wifiConfig });
  } catch (error) {
    console.error('Erreur dans /wifi-config:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route GET pour vérifier l'état du serveur
app.get('/health', (req, res) => {
  try {
    res.status(200).json({
      status: 'Serveur OK',
      esp32Connected: !!esp32Client,
      androidClients: androidClients.length
    });
  } catch (error) {
    console.error('Erreur dans /health:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Gestion WebSocket pour les clients Android
wss.on('connection', (ws) => {
  console.log('Nouveau client WebSocket connecté');

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
      console.log('Message reçu: ' + JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Erreur de parsing JSON:', err.message);
      ws.send(JSON.stringify({ type: 'error', message: `Erreur de parsing JSON: ${err.message}` }));
      return;
    }

    if (!data.type) {
      ws.send(JSON.stringify({ type: 'error', message: 'Type de message manquant' }));
      return;
    }

    if (data.type === 'android') {
      if (!androidClients.includes(ws)) {
        androidClients.push(ws);
        console.log('Client Android connecté, total:', androidClients.length);
        ws.send(JSON.stringify({ type: 'status', statusType: 'connection', message: `Client Android connecté (${androidClients.length})` }));
      }
    }

    if (data.type === 'android' && data.command) {
      const validCommands = [
        'INLET_PUMP_ON', 'INLET_PUMP_OFF', 'OUTLET_PUMP_ON', 'OUTLET_PUMP_OFF',
        'SECURITY_MODE_ON', 'SECURITY_MODE_OFF', 'REPLACE_WATER'
      ];
      if (!validCommands.includes(data.command)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Commande invalide' }));
        return;
      }
      if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
        esp32Client.send(JSON.stringify({ command: data.command }));
        ws.send(JSON.stringify({ type: 'status', statusType: 'command', message: 'Commande envoyée à l\'ESP32' }));
      } else {
        ws.send(JSON.stringify({ type: 'status', statusType: 'error', message: 'ESP32 non connecté' }));
      }
    } else if (data.type === 'request_data') {
      ws.send(JSON.stringify({ type: 'sensorData', data: storedConfig }));
    }
  });

  ws.on('close', () => {
    androidClients = androidClients.filter(client => client !== ws);
    console.log('Client Android déconnecté, total:', androidClients.length);
  });

  ws.on('error', (error) => {
    console.error('Erreur WebSocket:', error.message);
  });
});

function broadcastToAndroidClients(data) {
  androidClients = androidClients.filter(client => client.readyState === WebSocket.OPEN);
  androidClients.forEach(client => {
    try {
      client.send(JSON.stringify(data));
    } catch (err) {
      console.error('Erreur lors de l\'envoi à un client Android:', err.message);
    }
  });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
