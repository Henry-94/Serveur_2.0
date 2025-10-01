const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let esp32Client = null;
let androidClients = [];

let feedingTimes = [];
let securityTimes = [];
let thresholds = {
  minTemperature: 25.0,
  maxTemperature: 30.0,
  turbidityThreshold: 70.0
};
let wifiConfig = { ssid: '', password: '' };

wss.on('connection', (ws) => {
  console.log('Nouveau client WebSocket connecté');

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
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
      console.log('ESP32 connecté');
      ws.send(JSON.stringify({ type: 'status', message: 'ESP32 connecté au serveur' }));

      if (data.waterLevelStatus !== undefined || data.temperature !== undefined || data.turbidity !== undefined ||
          data.inletPumpState !== undefined || data.outletPumpState !== undefined || data.airPumpState !== undefined ||
          data.securityMode !== undefined || data.motion !== undefined) {
        broadcastToAndroidClients(data);
      }

    } else if (data.type === 'android') {
      if (!androidClients.includes(ws)) {
        androidClients.push(ws);
        console.log('Client Android connecté, total:', androidClients.length);
        ws.send(JSON.stringify({ type: 'status', message: `Client Android connecté (${androidClients.length})` }));
      }

      if (data.command) {
        const validCommands = [
          'INLET_PUMP_ON', 'INLET_PUMP_OFF', 'OUTLET_PUMP_ON', 'OUTLET_PUMP_OFF',
          'SECURITY_MODE_ON', 'SECURITY_MODE_OFF', 'REPLACE_WATER', 'RESET_DATE', 'RESTART_ESP32'
        ];
        if (!validCommands.includes(data.command)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Commande invalide' }));
          return;
        }

        if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
          esp32Client.send(JSON.stringify(data));
          console.log('Commande envoyée à ESP32:', JSON.stringify(data, null, 2));
          ws.send(JSON.stringify({ type: 'status', message: 'Commande envoyée à l\'ESP32' }));
        } else {
          ws.send(JSON.stringify({ type: 'status', message: 'ESP32 non connecté' }));
          console.log('ESP32 non connecté, commande non envoyée');
        }
      } else if (data.type === 'request_data') {
        if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
          esp32Client.send(JSON.stringify(data));
          console.log('Requête de données envoyée à ESP32');
        } else {
          ws.send(JSON.stringify({ type: 'status', message: 'ESP32 non connecté' }));
        }
      }
    } else if (data.type === 'status') {
      broadcastToAndroidClients(data);
    } else {
      ws.send(JSON.stringify({ type: 'error', message: 'Type de client inconnu' }));
    }
  });

  ws.on('close', () => {
    if (ws === esp32Client) {
      esp32Client = null;
      console.log('ESP32 déconnecté');
      broadcastToAndroidClients({ type: 'status', message: 'ESP32 déconnecté' });
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

// Routes HTTP
app.get('/getfeeding', (req, res) => {
  res.json({ feedingTimes });
});

app.post('/set-feeding-times', (req, res) => {
  const { feedingTimes: newFeedingTimes } = req.body;
  if (!Array.isArray(newFeedingTimes) || newFeedingTimes.length > 5) {
    return res.status(400).json({ message: 'feedingTimes doit être un tableau de maximum 5 éléments' });
  }
  for (let time of newFeedingTimes) {
    if (typeof time.hour !== 'number' || typeof time.minute !== 'number' || typeof time.foodName !== 'string' ||
        time.hour < 0 || time.hour > 23 || time.minute < 0 || time.minute > 59) {
      return res.status(400).json({ message: 'Format invalide pour feedingTimes' });
    }
  }
  feedingTimes = newFeedingTimes;
  console.log('Horaires d\'alimentation mis à jour');
  if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
    esp32Client.send(JSON.stringify({ type: 'feedingTimes', feedingTimes }));
    console.log('Horaires d\'alimentation envoyés à ESP32 via WebSocket');
  }
  res.json({ message: 'Horaires d\'alimentation configurés' });
});

app.get('/getsecurity', (req, res) => {
  res.json({ securityTimes });
});

app.post('/set-security-times', (req, res) => {
  const { securityTimes: newSecurityTimes } = req.body;
  if (!Array.isArray(newSecurityTimes) || newSecurityTimes.length > 10) {
    return res.status(400).json({ message: 'securityTimes doit être un tableau de maximum 10 éléments' });
  }
  for (let time of newSecurityTimes) {
    if (typeof time.startTime !== 'string' || typeof time.endTime !== 'string' ||
        time.startTime.length !== 4 || time.endTime.length !== 4) {
      return res.status(400).json({ message: 'Format invalide pour securityTimes' });
    }
  }
  securityTimes = newSecurityTimes;
  console.log('Horaires de sécurité mis à jour');
  if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
    esp32Client.send(JSON.stringify({ type: 'securityTimes', securityTimes }));
    console.log('Horaires de sécurité envoyés à ESP32 via WebSocket');
  }
  res.json({ message: 'Horaires de sécurité configurés' });
});

app.post('/set-thresholds', (req, res) => {
  const { minTemperature, maxTemperature, turbidityThreshold } = req.body;
  if (typeof minTemperature !== 'number' || typeof maxTemperature !== 'number' || typeof turbidityThreshold !== 'number' ||
      minTemperature >= maxTemperature) {
    return res.status(400).json({ message: 'Format invalide pour thresholds' });
  }
  thresholds = { minTemperature, maxTemperature, turbidityThreshold };
  console.log('Seuils mis à jour');
  if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
    esp32Client.send(JSON.stringify({ type: 'thresholds', ...thresholds }));
    console.log('Seuils envoyés à ESP32 via WebSocket');
  }
  res.json({ message: 'Seuils configurés' });
});

app.post('/set-wifi-config', (req, res) => {
  const { ssid, password } = req.body;
  if (typeof ssid !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ message: 'Format invalide pour wifi_config' });
  }
  wifiConfig = { ssid, password };
  console.log('Configuration WiFi mise à jour');
  if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
    esp32Client.send(JSON.stringify({ type: 'wifi_config', ssid, password }));
    console.log('Configuration WiFi envoyée à ESP32 via WebSocket');
  }
  res.json({ message: 'Configuration WiFi configurée' });
});

app.get('/getcurrenttime', (req, res) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  const timeStr = `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  res.json({ time: timeStr });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'Serveur OK',
    esp32Connected: !!esp32Client,
    androidClients: androidClients.length
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
