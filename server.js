const express = require('express');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');

const app = express();

// SSL configuration (replace with your certificate paths)
const serverOptions = {
  cert: fs.readFileSync('/path/to/fullchain.pem'), // Update with your certificate path
  key: fs.readFileSync('/path/to/privkey.pem')     // Update with your private key path
};

const server = https.createServer(serverOptions, app);
const wss = new WebSocket.Server({ 
  server,
  verifyClient: (info) => {
    return info.req.headers['sec-websocket-protocol'] === 'websocket';
  }
});

let esp32Client = null;
let androidClients = [];
let storedConfig = {
  feedingTimes: [],
  securityTimes: [],
  thresholds: {}
};

// Periodic cleanup for stale clients
setInterval(() => {
  if (esp32Client && esp32Client.readyState !== WebSocket.OPEN) {
    console.log('ESP32 client stale, cleaning up');
    esp32Client = null;
    broadcastToAndroidClients({ type: 'status', message: 'ESP32 déconnecté' });
  }
  androidClients = androidClients.filter(client => {
    if (client.readyState !== WebSocket.OPEN) {
      console.log('Android client stale, removing');
      return false;
    }
    try {
      client.ping();
      return true;
    } catch (err) {
      return false;
    }
  });
}, 30000); // Check every 30 seconds

wss.on('connection', (ws) => {
  console.log('Nouveau client WebSocket connecté');

  ws.on('pong', () => {
    // Handle pong to keep connection alive
  });

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
      console.log('ESP32 connecté');
      ws.send(JSON.stringify({ type: 'status', message: 'ESP32 connecté au serveur' }));

      // Send stored configurations to ESP32
      if (storedConfig.feedingTimes.length > 0 || storedConfig.securityTimes.length > 0 || Object.keys(storedConfig.thresholds).length > 0) {
        esp32Client.send(JSON.stringify({
          feedingTimes: storedConfig.feedingTimes,
          securityTimes: storedConfig.securityTimes,
          thresholds: storedConfig.thresholds
        }));
        console.log('Configurations envoyées à ESP32:', JSON.stringify(storedConfig, null, 2));
      }

      if (data.waterLevel !== undefined || data.temperature !== undefined || data.turbidity !== undefined || 
          data.message || data.motion) {
        broadcastToAndroidClients(data);
      }

    } else if (data.type === 'android') {
      if (!androidClients.includes(ws)) {
        androidClients.push(ws);
        console.log('Client Android connecté, total:', androidClients.length);
        ws.send(JSON.stringify({ type: 'status', message: `Client Android connecté (${androidClients.length})` }));
      }

      if (data.feedingTimes || data.securityTimes || data.thresholds || data.command || data.type === 'request_data') {
        if (data.feedingTimes) {
          if (!Array.isArray(data.feedingTimes) || data.feedingTimes.length > 5) {
            ws.send(JSON.stringify({ type: 'error', message: 'feedingTimes doit être un tableau de maximum 5 éléments' }));
            return;
          }
          for (let time of data.feedingTimes) {
            if (!Number.isInteger(time.hour) || !Number.isInteger(time.minute) ||
                time.hour < 0 || time.hour > 23 || time.minute < 0 || time.minute > 59 ||
                typeof time.foodName !== 'string' || time.foodName.trim() === '') {
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
        }

        if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
          esp32Client.send(JSON.stringify(data));
          console.log('Message envoyé à ESP32:', JSON.stringify(data, null, 2));
          ws.send(JSON.stringify({ type: 'status', message: 'Données envoyées à l\'ESP32' }));
        } else {
          ws.send(JSON.stringify({ type: 'status', message: 'ESP32 non connecté' }));
          console.log('ESP32 non connecté, message non envoyé');
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

app.use(express.static('public'));

app.get('/health', (req, res) => {
  res.json({
    status: 'Serveur WebSocket OK',
    esp32Connected: !!esp32Client,
    androidClients: androidClients.length
  });
});

const PORT = process.env.PORT || 443;
server.listen(PORT, () => {
  console.log(`Serveur WebSocket démarré sur le port ${PORT}`);
});
