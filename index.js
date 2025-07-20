const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const fs = require("fs");
const { OpenAI } = require("openai");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

const rooms = {};
const userNames = {};

app.use(cors());
const upload = multer({ dest: "uploads/" });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "YOUR_OPENAI_API_KEY" });

app.post("/api/translate", upload.single("audio"), async (req, res) => {
  try {
    const { sourceLang, targetLang } = req.body;
    let audioFilePath = req.file.path;
    // Ensure file has .webm extension for OpenAI
    if (!audioFilePath.endsWith('.webm')) {
      const newPath = audioFilePath + '.webm';
      fs.renameSync(audioFilePath, newPath);
      audioFilePath = newPath;
    }
    console.log(audioFilePath);
    // Transcribe audio
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFilePath),
      model: "whisper-1"
    });
    // Translate using GPT-4
    const chatResponse = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `
    You are a professional real-time speech translator for live meetings and conversations.
    
    Your responsibilities:
    1. Translate the user's input into the specified **target language**.
    2. **Automatically detect the source language** if it's not explicitly provided.
    3. Preserve:
       - The **original meaning**, **intent**, and **tone**
       - **Names**, **technical terms**, and **formal/informal speech level**
    4. Add **natural punctuation and sentence breaks** to enhance clarity.
    5. Translate incomplete or partial input as best as possible, assuming it is part of a live conversation.
    6. Keep the translation concise, clear, and natural-sounding for real-time display (e.g., live captions or subtitles).
    7. Do **not** include explanations, commentary, or repetition of the original input.
    
    Your response must only be the translated sentence(s), formatted as a complete and readable message.
    
    Example:
    Input: “Hi John I'll join the call in 5 minutes just setting up my mic”
    Output: “Salut John, je rejoins l'appel dans 5 minutes. Je configure juste mon micro.”
    
    Begin translation now.
          `
        },
        {
          role: "user",
          content: `
    Source Language: ${sourceLang || "auto-detect"}
    Target Language: ${targetLang}
    Input: ${transcription.text}
          `
        }
      ]
    });
    
// const transcription = { text: "Hello" };
// const chatResponse = {
//   choices: [
//     { message: { content: "My name is khan." } }
//   ]
// };
  console.log({transcription: transcription.text,
    translation: chatResponse.choices[0].message.content.trim()})
    // Clean up uploaded file
    try {
      fs.unlinkSync(audioFilePath);
    } catch (e) {
      console.warn("Failed to delete audio file:", audioFilePath, e.message);
    }
    res.json({
      transcription: transcription.text,
      translation: chatResponse.choices[0].message.content.trim()
    });
  } catch (err) {
    console.error("Error in /api/translate:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

io.on("connection", (socket) => {
  console.log(`Socket Connected`, socket.id);

  socket.on("join-room", ({ roomId, username }) => {
    // Store username
    userNames[socket.id] = username;
    if (!rooms[roomId]) rooms[roomId] = [];
    // Send the new user a list of all users already in the room (with usernames)
    const otherUsers = rooms[roomId]
      .filter(id => id !== socket.id)
      .map(id => ({ userId: id, username: userNames[id] }));
    socket.emit("users-in-room", { users: otherUsers });
    rooms[roomId].push(socket.id);
    socket.join(roomId);
    // Notify others in the room
    socket.to(roomId).emit("user-joined", { userId: socket.id, username });
    socket.roomId = roomId;
  });

  socket.on("offer", ({ to, offer, username }) => {
    io.to(to).emit("offer", { from: socket.id, offer, username: userNames[socket.id] || username });
  });

  socket.on("answer", ({ to, answer, username }) => {
    io.to(to).emit("answer", { from: socket.id, answer, username: userNames[socket.id] || username });
  });

  socket.on("ice-candidate", ({ to, candidate }) => {
    io.to(to).emit("ice-candidate", { from: socket.id, candidate });
  });

  socket.on("translation-message", (data) => {
    // Relay to all others in the room
    if (socket.roomId) {
      socket.to(socket.roomId).emit("translation-message", data);
    }
  });

  socket.on("user-left", ({ roomId, userId }) => {
    if (roomId && rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter((id) => id !== userId);
      socket.to(roomId).emit("user-left", { userId, username: userNames[userId] });
      if (rooms[roomId].length === 0) {
        delete rooms[roomId];
      }
    }
    delete userNames[userId];
    // Also leave the socket.io room
    socket.leave(roomId);
  });

  socket.on('request-username', ({ userId }) => {
    if (userNames[userId]) {
      socket.emit('username-response', { userId, username: userNames[userId] });
    }
  });

  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter((id) => id !== socket.id);
      socket.to(roomId).emit("user-left", { userId: socket.id, username: userNames[socket.id] });
      if (rooms[roomId].length === 0) {
        delete rooms[roomId];
      }
    }
    delete userNames[socket.id];
  });
});
