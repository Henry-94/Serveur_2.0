const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let esp32Client = null;
let androidClients = [];

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

    // Validation du type de message
    if (!data.type) {
      ws.send(JSON.stringify({ type: 'error', message: 'Type de message manquant' }));
      return;
    }

    // Gestion des connexions ESP32
    if (data.type === 'esp32') {
      esp32Client = ws;
      console.log('ESP32 connecté');
      ws.send(JSON.stringify({ type: 'status', message: 'ESP32 connecté au serveur' }));

      // Relayer les données de capteurs et status aux clients Android
      if (data.waterLevel !== undefined || data.temperature !== undefined || data.turbidity !== undefined || 
          data.message || data.motion) {
        broadcastToAndroidClients(data);
      }

    // Gestion des connexions Android
    } else if (data.type === 'android') {
      if (!androidClients.includes(ws)) {
        androidClients.push(ws);
        console.log('Client Android connecté, total:', androidClients.length);
        ws.send(JSON.stringify({ type: 'status', message: `Client Android connecté (${androidClients.length})` }));
      }

      // Gestion des messages envoyés par Android
      if (data.feedingTimes || data.securityTimes || data.thresholds || data.command || data.wifi_config || data.reset_date || data.type === 'request_data') {
        // Validation des formats
        if (data.feedingTimes) {
          if (!Array.isArray(data.feedingTimes) || data.feedingTimes.length > 5) {
            ws.send(JSON.stringify({ type: 'error', message: 'feedingTimes doit être un tableau de maximum 5 éléments' }));
            return;
          }
          for (let time of data.feedingTimes) {
            if (!time.hour || !time.minute || !time.foodName || 
                !Number.isInteger(time.hour) || !Number.isInteger(time.minute) ||
                time.hour < 0 || time.hour > 23 || time.minute < 0 || time.minute > 59) {
              ws.send(JSON.stringify({ type: 'error', message: 'Format invalide pour feedingTimes' }));
              return;
            }
          }
        }

        if (data.securityTimes) {
          if (!Array.isArray(data.securityTimes) || data.securityTimes.length > 10) {
            ws.send(JSON.stringify({ type: 'error', message: 'securityTimes doit être un tableau de maximum 10 éléments' }));
            return;
          }
          for (let time of data.securityTimes) {
            if (!time.startHour || !time.startMinute || !time.endHour || !time.endMinute ||
                !Number.isInteger(time.startHour) || !Number.isInteger(time.startMinute) ||
                !Number.isInteger(time.endHour) || !Number.isInteger(time.endMinute) ||
                time.startHour < 0 || time.startHour > 23 || time.startMinute < 0 || time.startMinute > 59 ||
                time.endHour < 0 || time.endHour > 23 || time.endMinute < 0 || time.endMinute > 59) {
              ws.send(JSON.stringify({ type: 'error', message: 'Format invalide pour securityTimes' }));
              return;
            }
          }
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
        }

        if (data.wifi_config) {
          if (!data.wifi_config.ssid || typeof data.wifi_config.ssid !== 'string' ||
              !data.wifi_config.password || typeof data.wifi_config.password !== 'string') {
            ws.send(JSON.stringify({ type: 'error', message: 'Format invalide pour wifi_config' }));
            return;
          }
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

        if (data.reset_date) {
          if (typeof data.reset_date.timestamp !== 'number') {
            ws.send(JSON.stringify({ type: 'error', message: 'Format invalide pour reset_date' }));
            return;
          }
        }

        // Envoyer les données à l'ESP32
        if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
          // Si c'est une initialisation, envoyer un message de type 'init'
          if (data.feedingTimes || data.securityTimes || data.thresholds) {
            const initMessage = {
              type: 'init',
              feedingTimes: data.feedingTimes || [],
              securityTimes: data.securityTimes || [],
              thresholds: data.thresholds || {}
            };
            esp32Client.send(JSON.stringify(initMessage));
            console.log('Message d\'initialisation envoyé à ESP32:', JSON.stringify(initMessage, null, 2));
            ws.send(JSON.stringify({ type: 'status', message: 'Données d\'initialisation envoyées à l\'ESP32' }));
          } else {
            // Envoyer les autres messages directement
            esp32Client.send(JSON.stringify(data));
            console.log('Message envoyé à ESP32:', JSON.stringify(data, null, 2));
            ws.send(JSON.stringify({ type: 'status', message: 'Données envoyées à l\'ESP32' }));
          }
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

// Fonction pour diffuser aux clients Android
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

// Middleware pour fichiers statiques (optionnel)
app.use(express.static('public'));

// Route de santé
app.get('/health', (req, res) => {
  res.json({
    status: 'Serveur WebSocket OK',
    esp32Connected: !!esp32Client,
    androidClients: androidClients.length
  });
});

// Lancement du serveur
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Serveur WebSocket démarré sur le port ${PORT}`);
});
