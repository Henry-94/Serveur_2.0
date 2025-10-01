const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
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

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/getfeeding', (req, res) => {
  res.json({ feedingTimes });
});

app.get('/getsecurity', (req, res) => {
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
    if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
      esp32Client.send(JSON.stringify({ type: 'feeding_update', feedingTimes }));
    }
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
    if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
      const formattedSecurityTimes = req.body.securityTimes.map(time => ({
        startTime: time.startTime,
        endTime: time.endTime
      }));
      esp32Client.send(JSON.stringify({ type: 'security_update', securityTimes: formattedSecurityTimes }));
    }
    broadcastToAndroidClients({ type: 'status', message: 'Intervalles de sécurité mis à jour' });
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
    if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
      esp32Client.send(JSON.stringify({ type: 'thresholds_update', thresholds }));
    }
    broadcastToAndroidClients({ type: 'status', message: 'Seuils mis à jour' });
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

// Envoyer l'heure actuelle toutes les 5 minutes aux clients ESP32
setInterval(() => {
  if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
    const now = new Date();
    const formatted = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0') + ' ' +
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0') + ':' +
      String(now.getSeconds()).padStart(2, '0');
    esp32Client.send(JSON.stringify({ type: 'time_update', time: formatted }));
    console.log('Heure envoyée à l\'ESP32:', formatted);
  }
}, 300000); // 5 minutes

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
