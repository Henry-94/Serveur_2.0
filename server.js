const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
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
    ssid: "Ra lala",
    password: "123456789"
  }
};
let esp32Client = null;
let androidClients = [];

// Nettoyage des clients inactifs
setInterval(() => {
  androidClients = androidClients.filter(client => client.readyState === WebSocket.OPEN);
  console.log('Clients Android actifs:', androidClients.length);
}, 30000);

// Route POST pour les horaires d'alimentation
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
    broadcastToESP32({ type: 'feedingTimes', feedingTimes });
    broadcastToAndroidClients({ type: 'feedingTimes', data: feedingTimes });
  } catch (error) {
    console.error('Erreur dans /set-feeding-times:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route POST pour les intervalles de sécurité
app.post('/set-security-times', (req, res) => {
  try {
    const { securityTimes } = req.body;
    if (!Array.isArray(securityTimes) || securityTimes.length > 10) {
      return res.status(400).json({ message: 'securityTimes doit être un tableau de maximum 10 éléments' });
    }
    for (let time of securityTimes) {
      if (!Number.isInteger(time.startHour) || !Number.isInteger(time.startMinute) ||
          !Number.isInteger(time.endHour) || !Number.isInteger(time.endMinute) ||
          time.startHour < 0 || time.startHour > 23 || time.startMinute < 0 || time.startMinute > 59 ||
          time.endHour < 0 || time.endHour > 23 || time.endMinute < 0 || time.endMinute > 59) {
        return res.status(400).json({ message: 'Format invalide pour securityTimes' });
      }
    }
    storedConfig.securityTimes = securityTimes;
    console.log(`Intervalles de sécurité reçus : ${JSON.stringify(securityTimes, null, 2)} at ${new Date().toISOString()}`);
    res.status(200).json({ message: 'Intervalles de sécurité configurés' });
    broadcastToESP32({ type: 'securityTimes', securityTimes });
    broadcastToAndroidClients({ type: 'securityTimes', data: securityTimes });
  } catch (error) {
    console.error('Erreur dans /set-security-times:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route POST pour les seuils
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
    broadcastToESP32({ type: 'thresholds', thresholds });
    broadcastToAndroidClients({ type: 'thresholds', data: thresholds });
  } catch (error) {
    console.error('Erreur dans /set-thresholds:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route POST pour les identifiants WiFi
app.post('/set-wifi-config', (req, res) => {
  try {
    const { ssid, password } = req.body;
    if (typeof ssid !== 'string' || typeof password !== 'string' || ssid.length === 0 || password.length < 8) {
      return res.status(400).json({ message: 'Format invalide pour wifiConfig' });
    }
    storedConfig.wifiConfig = { ssid, password };
    console.log(`Identifiants WiFi reçus : ${JSON.stringify(storedConfig.wifiConfig, null, 2)} at ${new Date().toISOString()}`);
    res.status(200).json({ message: 'Identifiants WiFi configurés' });
    broadcastToESP32({ type: 'wifiConfig', wifiConfig: storedConfig.wifiConfig });
    broadcastToAndroidClients({ type: 'wifiConfig', data: storedConfig.wifiConfig });
  } catch (error) {
    console.error('Erreur dans /set-wifi-config:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route POST pour redémarrer l'ESP32
app.post('/restart-esp32', (req, res) => {
  try {
    const { command } = req.body;
    if (command !== 'RESTART_ESP32') {
      return res.status(400).json({ message: 'Commande invalide' });
    }
    console.log(`Commande de redémarrage reçue at ${new Date().toISOString()}`);
    res.status(200).json({ message: 'Commande de redémarrage envoyée' });
    broadcastToESP32({ type: 'command', command });
  } catch (error) {
    console.error('Erreur dans /restart-esp32:', error);
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

// Gestion WebSocket
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

    if (data.type === 'esp32') {
      esp32Client = ws;
      console.log('Client ESP32 connecté');
      // Envoyer les configurations initiales
      ws.send(JSON.stringify({
        type: 'init',
        feedingTimes: storedConfig.feedingTimes,
        securityTimes: storedConfig.securityTimes,
        thresholds: storedConfig.thresholds,
        wifiConfig: storedConfig.wifiConfig
      }));
    } else if (data.type === 'android') {
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
    } else if (data.type === 'sensorData') {
      broadcastToAndroidClients({ type: 'sensorData', data });
    } else if (data.type === 'status') {
      broadcastToAndroidClients({ type: 'status', statusType: data.statusType, message: data.message });
    } else if (data.type === 'request_data') {
      ws.send(JSON.stringify({ type: 'sensorData', data: storedConfig }));
    }
  });

  ws.on('pong', () => {
    console.log('Pong reçu du client');
  });

  ws.on('close', () => {
    if (ws === esp32Client) {
      esp32Client = null;
      console.log('Client ESP32 déconnecté');
    } else {
      androidClients = androidClients.filter(client => client !== ws);
      console.log('Client Android déconnecté, total:', androidClients.length);
    }
  });

  ws.on('error', (error) => {
    console.error('Erreur WebSocket:', error.message);
  });
});

function broadcastToESP32(data) {
  if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
    try {
      esp32Client.send(JSON.stringify(data));
      console.log('Données envoyées à l\'ESP32:', JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Erreur lors de l\'envoi à l\'ESP32:', err.message);
    }
  }
}

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
