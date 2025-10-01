const express = require('express');
const https = require('https'); // Changé de http à https
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const server = https.createServer(app); // Utiliser HTTPS
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

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/getfeeding', (req, res) => {
  res.json({ feedingTimes });
});

app.get('/getsecurity', (req, res) => {
  // Retourner securityTimes au format attendu (startTime: "HHMM", endTime: "HHMM")
  const formattedSecurityTimes = securityTimes.map(time => ({
    startTime: `${String(time.startHour).padStart(2, '0')}${String(time.startMinute).padStart(2, '0')}`,
    endTime: `${String(time.endHour).padStart(2, '0')}${String(time.endMinute).padStart(2, '0')}`
  }));
  res.json({ securityTimes: formattedSecurityTimes });
});

app.get('/getthresholds', (req, res) => {
  res.json({ thresholds });
});

app.get('/getcurrenttime', (req, res) => {
  const now = new Date();
  const formatted = now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0') + ' ' +
    String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0') + ':' +
    String(now.getSeconds()).padStart(2, '0');
  res.json({ time: formatted });
});

app.post('/set-feeding-times', (req, res) => {
  if (req.body.feedingTimes) {
    feedingTimes = req.body.feedingTimes;
    console.log('Horaires d\'alimentation mis à jour:', feedingTimes);
    broadcastToAndroidClients({ type: 'status', message: 'Horaires d\'alimentation mis à jour' });
    res.json({ status: 'success', message: 'Horaires d\'alimentation mis à jour' });
  } else {
    res.status(400).json({ status: 'error', message: 'feedingTimes manquant ou invalide' });
  }
});

app.post('/set-security-times', (req, res) => {
  if (req.body.securityTimes) {
    securityTimes = req.body.securityTimes.map(time => ({
      startHour: parseInt(time.startTime.slice(0, 2)),
      startMinute: parseInt(time.startTime.slice(2, 4)),
      endHour: parseInt(time.endTime.slice(0, 2)),
      endMinute: parseInt(time.endTime.slice(2, 4))
    }));
    console.log('Intervalles de sécurité mis à jour:', securityTimes);
    broadcastToAndroidClients({ type: 'status', message: 'Intervalles de sécurité mis à jour' });
    // Envoyer les securityTimes mis à jour à l'ESP32
    if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
      const formattedSecurityTimes = securityTimes.map(time => ({
        startTime: `${String(time.startHour).padStart(2, '0')}${String(time.startMinute).padStart(2, '0')}`,
        endTime: `${String(time.endHour).padStart(2, '0')}${String(time.endMinute).padStart(2, '0')}`
      }));
      esp32Client.send(JSON.stringify({ type: 'security_update', securityTimes: formattedSecurityTimes }));
    }
    res.json({ status: 'success', message: 'Intervalles de sécurité mis à jour' });
  } else {
    res.status(400).json({ status: 'error', message: 'securityTimes manquant ou invalide' });
  }
});

app.post('/set-thresholds', (req, res) => {
  if (req.body.thresholds) {
    thresholds = {
      minTemperature: req.body.thresholds.minTemperature || thresholds.minTemperature,
      maxTemperature: req.body.thresholds.maxTemperature || thresholds.maxTemperature,
      turbidityThreshold: req.body.thresholds.turbidityThreshold || thresholds.turbidityThreshold
    };
    console.log('Seuils mis à jour:', thresholds);
    broadcastToAndroidClients({ type: 'status', message: 'Seuils mis à jour' });
    if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
      esp32Client.send(JSON.stringify({ type: 'thresholds_update', thresholds }));
    }
    res.json({ status: 'success', message: 'Seuils mis à jour' });
  } else {
    res.status(400).json({ status: 'error', message: 'thresholds manquant ou invalide' });
  }
});

app.post('/set-wifi-config', (req, res) => {
  if (req.body.ssid && req.body.password) {
    if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
      esp32Client.send(JSON.stringify({ type: 'wifi_config', ssid: req.body.ssid, password: req.body.password }));
      console.log('Identifiants WiFi envoyés à l\'ESP32');
      res.json({ status: 'success', message: 'Identifiants WiFi envoyés à l\'ESP32' });
    } else {
      res.status(400).json({ status: 'error', message: 'ESP32 non connecté' });
    }
  } else {
    res.status(400).json({ status: 'error', message: 'ssid ou password manquant' });
  }
});

app.post('/restart-esp32', (req, res) => {
  if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
    esp32Client.send(JSON.stringify({ type: 'command', command: 'RESTART_ESP32' }));
    console.log('Commande de redémarrage envoyée à l\'ESP32');
    res.json({ status: 'success', message: 'Commande de redémarrage envoyée à l\'ESP32' });
  } else {
    res.status(400).json({ status: 'error', message: 'ESP32 non connecté' });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'Serveur WebSocket OK',
    esp32Connected: !!esp32Client,
    androidClients: androidClients.length
  });
});

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

      if (data.waterLevelStatus || data.temperature || data.turbidity || data.message || data.motion) {
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
          'SECURITY_MODE_ON', 'SECURITY_MODE_OFF', 'REPLACE_WATER', 'RESET_DATE'
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
          esp32Client.send(JSON.stringify({ type: 'request_data' }));
          console.log('Demande de données envoyée à l\'ESP32');
        } else {
          ws.send(JSON.stringify({ type: 'status', message: 'ESP32 non connecté' }));
        }
      }
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
    ws.send(JSON.stringify({ type: 'error', message: `Erreur WebSocket: ${error.message}` }));
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

app.use((err, req, res, next) => {
  console.error('Erreur serveur:', err.stack);
  res.status(500).json({ message: 'Erreur interne du serveur' });
});

const PORT = process.env.PORT || 443; // Port 443 pour HTTPS/WSS
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
