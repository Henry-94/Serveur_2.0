const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const WebSocket = require('ws');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Stockage en mémoire
let feedingTimes = [];
let securityTimes = [];
let thresholds = {
  minTemperature: 25.0,
  maxTemperature: 30.0,
  turbidityThreshold: 70.0
};

// WebSocket Server
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws) => {
  console.log('Client WebSocket connecte');
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      // Relayer les messages à tous les clients connectés
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(data));
        }
      });
      // Log des messages reçus
      if (data.type === 'esp32') {
        console.log('Donnees capteurs recues de l\'ESP32:', data);
      } else if (data.type === 'android') {
        console.log('Commande recue de l\'application Android:', data);
      } else if (data.type === 'thresholds') {
        console.log('Seuils recus:', data);
      }
    } catch (error) {
      console.error('Erreur WebSocket:', error);
    }
  });

  ws.on('close', () => {
    console.log('Client WebSocket deconnecte');
  });

  // Envoyer les seuils initiaux au client qui se connecte
  ws.send(JSON.stringify({
    type: 'thresholds',
    minTemperature: thresholds.minTemperature,
    maxTemperature: thresholds.maxTemperature,
    turbidityThreshold: thresholds.turbidityThreshold
  }));
});

// Route POST pour définir les horaires d'alimentation
app.post('/set-feeding-times', (req, res) => {
  try {
    const { feedingTimes: newTimes } = req.body;
    if (!Array.isArray(newTimes)) {
      return res.status(400).json({ message: 'feedingTimes doit etre un tableau' });
    }
    feedingTimes = newTimes.map(time => ({
      hour: parseInt(time.hour),
      minute: parseInt(time.minute),
      foodName: time.foodName
    })).filter(time => !isNaN(time.hour) && !isNaN(time.minute) && time.foodName);
    console.log(`Horaires d'alimentation recus: ${JSON.stringify(feedingTimes)} at ${new Date().toISOString()}`);
    res.status(200).json({ message: 'Horaires d\'alimentation configures' });
  } catch (error) {
    console.error('Erreur dans /set-feeding-times:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route GET pour récupérer les horaires d'alimentation
app.get('/getfeeding', (req, res) => {
  try {
    console.log(`Envoi des horaires d'alimentation: ${JSON.stringify(feedingTimes)} at ${new Date().toISOString()}`);
    res.status(200).json({ feedingTimes });
  } catch (error) {
    console.error('Erreur dans /getfeeding:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route POST pour définir les intervalles de sécurité
app.post('/set-security-times', (req, res) => {
  try {
    const { securityTimes: newTimes } = req.body;
    if (!Array.isArray(newTimes)) {
      return res.status(400).json({ message: 'securityTimes doit etre un tableau' });
    }
    securityTimes = newTimes.map(time => ({
      startTime: time.startTime,
      endTime: time.endTime
    })).filter(time => time.startTime && time.endTime && time.startTime.length === 4 && time.endTime.length === 4 && !isNaN(time.startTime) && !isNaN(time.endTime));
    console.log(`Intervalles de securite recus: ${JSON.stringify(securityTimes)} at ${new Date().toISOString()}`);
    res.status(200).json({ message: 'Intervalles de securite configures' });
  } catch (error) {
    console.error('Erreur dans /set-security-times:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route GET pour récupérer les intervalles de sécurité
app.get('/getsecurity', (req, res) => {
  try {
    console.log(`Envoi des intervalles de securite: ${JSON.stringify(securityTimes)} at ${new Date().toISOString()}`);
    res.status(200).json({ securityTimes });
  } catch (error) {
    console.error('Erreur dans /getsecurity:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route POST pour définir les seuils
app.post('/set-thresholds', (req, res) => {
  try {
    const { minTemperature, maxTemperature, turbidityThreshold } = req.body;
    if (minTemperature !== undefined && maxTemperature !== undefined && turbidityThreshold !== undefined) {
      thresholds.minTemperature = parseFloat(minTemperature);
      thresholds.maxTemperature = parseFloat(maxTemperature);
      thresholds.turbidityThreshold = parseFloat(turbidityThreshold);
      console.log(`Seuils recus: ${JSON.stringify(thresholds)} at ${new Date().toISOString()}`);
      // Envoyer les seuils via WebSocket
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'thresholds',
            minTemperature: thresholds.minTemperature,
            maxTemperature: thresholds.maxTemperature,
            turbidityThreshold: thresholds.turbidityThreshold
          }));
        }
      });
      res.status(200).json({ message: 'Seuils configures' });
    } else {
      res.status(400).json({ message: 'Donnees de seuils invalides' });
    }
  } catch (error) {
    console.error('Erreur dans /set-thresholds:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route GET pour l'heure actuelle
app.get('/getcurrenttime', (req, res) => {
  try {
    const now = new Date();
    const timeStr = now.toISOString().slice(0, 19).replace('T', ' ');
    console.log(`Envoi de l'heure actuelle: ${timeStr}`);
    res.status(200).json({ time: timeStr });
  } catch (error) {
    console.error('Erreur dans /getcurrenttime:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Route GET pour le statut
app.get('/status', (req, res) => {
  try {
    res.status(200).json({
      message: 'Serveur actif',
      feedingTimesSet: feedingTimes.length > 0,
      securityTimesSet: securityTimes.length > 0
    });
  } catch (error) {
    console.error('Erreur dans /status:', error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Gestion des erreurs globales
app.use((err, req, res, next) => {
  console.error('Erreur serveur:', err.stack);
  res.status(500).json({ message: 'Erreur interne du serveur' });
});

app.listen(port, () => {
  console.log(`Serveur demarre sur le port ${port}`);
});
