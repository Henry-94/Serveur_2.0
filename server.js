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
    broadcastToAndroidClients({ type: 'feedingTimes', feedingTimes });
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
    broadcastToAndroidClients({ type: 'securityTimes', securityTimes });
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
    broadcastToAndroidClients({ type: 'thresholds', thresholds });
  } catch (error) {
    console.error('Erreur dans /set-thresholds:', error);
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

// Route POST pour recevoir les statuts de l'ESP32
app.post('/status', (req, res) => {
  try {
    const data = req.body;
    if (data.type === 'status' && data.message) {
      console.log('Status reçu de l\'ESP32:', JSON.stringify(data, null, 2));
      broadcastToAndroidClients(data);
      res.status(200).json({ message: 'Status reçu' });
    } else {
      res.status(400).json({ message: 'Message status invalide' });
    }
  } catch (error) {
    console.error('Erreur dans /status:', error);
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
      console.log('Message reçu:', JSON.stringify(data, null, 2));
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
      ws.send(JSON.stringify({ type: 'status', message: 'ESP32 connecté' }));
    } else if (data.type === 'android') {
      if (!androidClients.includes(ws)) {
        androidClients.push(ws);
        console.log('Client Android connecté, total:', androidClients.length);
        ws.send(JSON.stringify({ type: 'status', message: `Client Android connecté (${androidClients.length})` }));
      }
    }

    if (data.type === 'android') {
      if (data.command) {
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
          ws.send(JSON.stringify({ type: 'status', message: 'Commande envoyée à l\'ESP32' }));
        } else {
          ws.send(JSON.stringify({ type: 'status', message: 'ESP32 non connecté' }));
        }
      }

      if (data.type === 'request_data') {
        ws.send(JSON.stringify({ type: 'status', message: 'Utilisez /sensors pour les données de capteurs' }));
      }
    }
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

// Gestion des erreurs globales
app.use((err, req, res, next) => {
  console.error('Erreur serveur:', err.stack);
  res.status(500).json({ message: 'Erreur interne du serveur' });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
