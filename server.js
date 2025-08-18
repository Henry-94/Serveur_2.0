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

      // Relayer les données de capteurs et status aux clients Android
      if (data.waterLevel !== undefined || data.temperature !== undefined || data.turbidity !== undefined || 
          data.message || data.status || data.motion) {
        broadcastToAndroidClients(data);
      }

    // Gestion des connexions Android
    } else if (data.type === 'android') {
      if (!androidClients.includes(ws)) {
        androidClients.push(ws);
        console.log('Client Android connecté, total:', androidClients.length);
      }

      // Relayer commandes, horaires, seuils vers l'ESP32
      if (data.feedingTimes || data.securityTimes || data.thresholds || data.command || data.feedingCount) {
        // Validation des formats
        if (data.feedingTimes && !Array.isArray(data.feedingTimes)) {
          ws.send(JSON.stringify({ type: 'error', message: 'feedingTimes doit être un tableau' }));
          return;
        }
        if (data.securityTimes && !Array.isArray(data.securityTimes)) {
          ws.send(JSON.stringify({ type: 'error', message: 'securityTimes doit être un tableau' }));
          return;
        }
        if (data.thresholds && typeof data.thresholds !== 'object') {
          ws.send(JSON.stringify({ type: 'error', message: 'thresholds doit être un objet' }));
          return;
        }
        if (data.feedingCount !== undefined && (!Number.isInteger(data.feedingCount) || data.feedingCount < 0 || data.feedingCount > 5)) {
          ws.send(JSON.stringify({ type: 'error', message: 'feedingCount doit être un entier entre 0 et 5' }));
          return;
        }

        // Envoyer les données à l'ESP32
        if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
          esp32Client.send(JSON.stringify(data));
          console.log('Message envoyé à ESP32:', JSON.stringify(data, null, 2));
          ws.send(JSON.stringify({ type: 'status', message: 'Données envoyées à l\'ESP32' }));
        } else {
          ws.send(JSON.stringify({ type: 'status', message: 'ESP32 non connecté' }));
          console.log('ESP32 non connecté, message non envoyé');
        }
      }

      // Répondre à une demande de données
      if (data.type === 'request_data') {
        if (esp32Client && esp32Client.readyState === WebSocket.OPEN) {
          esp32Client.send(JSON.stringify({ type: 'request_data' }));
          ws.send(JSON.stringify({ type: 'status', message: 'Demande de données envoyée à l\'ESP32' }));
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