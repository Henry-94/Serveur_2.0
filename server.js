const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.json()); // Pour parser les requêtes POST JSON
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let esp32Client = null;
let androidClients = [];
let storedConfig = {
  feedingTimes: [],
  securityTimes: [],
  thresholds: {}
};

// Nettoyage périodique des clients Android inactifs
setInterval(() => {
  androidClients = androidClients.filter(client => client.readyState === WebSocket.OPEN);
  console.log('Clients Android actifs:', androidClients.length);
}, 30000);

// Endpoints HTTP pour l'ESP32
app.get('/feeding-times', (req, res) => {
  res.json({ feedingTimes: storedConfig.feedingTimes });
  console.log('GET /feeding-times:', JSON.stringify(storedConfig.feedingTimes, null, 2));
});

app.get('/security-times', (req, res) => {
  res.json({ securityTimes: storedConfig.securityTimes });
  console.log('GET /security-times:', JSON.stringify(storedConfig.securityTimes, null, 2));
});

app.get('/thresholds', (req, res) => {
  res.json({ thresholds: storedConfig.thresholds });
  console.log('GET /thresholds:', JSON.stringify(storedConfig.thresholds, null, 2));
});

app.post('/status', (req, res) => {
  const data = req.body;
  if (data.type === 'status' && data.message) {
    console.log('Status reçu de l\'ESP32:', JSON.stringify(data, null, 2));
    broadcastToAndroidClients(data); // Relayer aux clients Android
    res.json({ status: 'Status reçu' });
  } else {
    res.status(400).json({ error: 'Message status invalide' });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'Serveur OK',
    esp32Connected: !!esp32Client,
    androidClients: androidClients.length
  });
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

    if (data.type === 'android') {
      if (!androidClients.includes(ws)) {
        androidClients.push(ws);
        console.log('Client Android connecté, total:', androidClients.length);
        ws.send(JSON.stringify({ type: 'status', message: `Client Android connecté (${androidClients.length})` }));
      }

      // Gestion des messages envoyés par Android
      if (data.feedingTimes) {
        if (!Array.isArray(data.feedingTimes) || data.feedingTimes.length > 5) {
          ws.send(JSON.stringify({ type: 'error', message: 'feedingTimes doit être un tableau de maximum 5 éléments' }));
          return;
        }
        for (let time of data.feedingTimes) {
          if (!Number.isInteger(time.hour) || !Number.isInteger(time.minute) || !time.foodName ||
              time.hour < 0 || time.hour > 23 || time.minute < 0 || time.minute > 59) {
            ws.send(JSON.stringify({ type: 'error', message: 'Format invalide pour feedingTimes' }));
            return;
          }
        }
        const timesSet = new Set(data.feedingTimes.map(t => `${t.hour}:${t.minute}`));
        if (timesSet.size !== data.feedingTimes.length) {
          ws.send(JSON.stringify({ type: 'error', message: 'Horaires d\'alimentation en double' }));
          return;
        }
        storedConfig.feedingTimes = data.feedingTimes;
        console.log('feedingTimes mis à jour:', JSON.stringify(storedConfig.feedingTimes, null, 2));
      }

      if (data.securityTimes) {
        if (!Array.isArray(data.securityTimes) || data.securityTimes.length > 10) {
          ws.send(JSON.stringify({ type: 'error', message: 'securityTimes doit être un tableau de maximum 10 éléments' }));
          return;
        }
        for (let time of data.securityTimes) {
          if (!Number.isInteger(time.startHour) || !Number.isInteger(time.startMinute) ||
              !Number.isInteger(time.endHour) || !Number.isInteger(time.endMinute) ||
              time.startHour < 0 || time.startHour > 23 || time.startMinute < 0 || time.startMinute > 59 ||
              time.endHour < 0 || time.endHour > 23 || time.endMinute < 0 || time.endMinute > 59) {
            ws.send(JSON.stringify({ type: 'error', message: 'Format invalide pour securityTimes' }));
            return;
          }
        }
        storedConfig.securityTimes = data.securityTimes;
        console.log('securityTimes mis à jour:', JSON.stringify(storedConfig.securityTimes, null, 2));
      }

      if (data.thresholds) {
        if (typeof data.thresholds !== 'object' ||
            typeof data.thresholds.minTemperature !== 'number' ||
            typeof data.thresholds.maxTemperature !== 'number' ||
            typeof data.thresholds.turbidityThreshold !== 'number' ||
            data.thresholds.minTemperature >= data.thresholds.maxTemperature) {
          ws.send(JSON.stringify({ type: 'error', message: 'Format invalide pour thresholds' }));
          return;
        }
        storedConfig.thresholds = data.thresholds;
        console.log('thresholds mis à jour:', JSON.stringify(storedConfig.thresholds, null, 2));
      }

      if (data.command) {
        const validCommands = [
          'INLET_PUMP_ON', 'INLET_PUMP_OFF', 'OUTLET_PUMP_ON', 'OUTLET_PUMP_OFF',
          'SECURITY_MODE_ON', 'SECURITY_MODE_OFF', 'REPLACE_WATER'
        ];
        if (!validCommands.includes(data.command)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Commande invalide' }));
          return;
        }
        // Les commandes seront envoyées via HTTP POST à l'ESP32
        if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
          esp32Client.send(JSON.stringify({ command: data.command }));
          ws.send(JSON.stringify({ type: 'status', message: 'Commande envoyée à l\'ESP32' }));
        } else {
          ws.send(JSON.stringify({ type: 'status', message: 'ESP32 non connecté' }));
        }
      }

      if (data.type === 'request_data') {
        // Les données de capteurs seront envoyées via HTTP
        ws.send(JSON.stringify({ type: 'status', message: 'Utilisez /sensors pour les données de capteurs' }));
      }
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
