const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Record = require('./models/Record');

const app = express();
const PORT = 3001;

// Middleware
app.use(cors()); // Allow requests from React (port 5173/3000)
app.use(express.json());

// Connect to local MongoDB
// Make sure MongoDB is running on your machine!
mongoose.connect('mongodb://127.0.0.1:27017/medichain_thesis')
  .then(() => console.log('✅ Connected to MongoDB Local Database'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- ROUTES ---

// 1. Create a new Triage Record (Real DB Insert)
app.post('/api/records', async (req, res) => {
  try {
    // CORRECCIÓN: Agregar transactionHash al destructuring
    const { patientData, blockchainHash, blockchainSignature, transactionHash } = req.body;
    
    const newRecord = new Record({
      patientData,
      blockchainHash,
      blockchainSignature,
      transactionHash // GUARDAR EL HASH DE POLYGON
    });

    await newRecord.save();
    console.log(`[INFO] New Record Saved: ${patientData.name} | TX: ${transactionHash}`);
    res.status(201).json(newRecord);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server Error saving record' });
  }
});

// 2. Get All Records (For Auditor View)
app.get('/api/records', async (req, res) => {
  try {
    // Return sorted by newest first
    const records = await Record.find().sort({ createdAt: -1 });
    res.json(records);
  } catch (error) {
    res.status(500).json({ error: 'Server Error fetching records' });
  }
});

// 3. Mark as Attended (Update attentionTimestamp)
app.patch('/api/records/:id/attend', async (req, res) => {
  try {
    const { id } = req.params;
    const { attentionTimestamp } = req.body;

    const updated = await Record.findOneAndUpdate(
      { _id: id },
      { $set: { "patientData.attentionTimestamp": attentionTimestamp } },
      { new: true }
    );

    if (!updated) return res.status(404).json({ error: 'Record not found' });
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update attention time' });
  }
});

// 4. ADMIN BACKDOOR (The Hack)
app.patch('/api/hack/:id', async (req, res) => {
  try {
    const { id } = req.params; // MongoDB _id
    const hackedData = req.body; // Partial patient data

    const record = await Record.findById(id);
    if (!record) return res.status(404).json({ error: 'Record not found' });

    // Apply the hack: Update patientData fields
    record.patientData = { ...record.patientData, ...hackedData };
    
    await record.save();
    console.log(`[WARNING] Record ${id} was manually altered (HACKED)`);
    
    res.json({ success: true, message: 'Data injection successful (Integrity Compromised)' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Hack failed' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});