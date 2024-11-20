const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const Redis = require("ioredis");
const app = express();
const port = process.env.PORT || 5000;
const server = http.createServer(app);
const io = require("socket.io")(server);
require("dotenv").config();

// Redis Setup
const redis = new Redis(process.env.REDIS_URL);
const pubClient = new Redis(process.env.REDIS_URL);
const subClient = new Redis(process.env.REDIS_URL);

const userSocketMap = {}; // In-memory cache for quick access

// MongoDB Connection
const mongoURI = process.env.MONGO_URI;
mongoose
  .connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("Connected to MongoDB successfully."))
  .catch((err) => console.error("MongoDB connection error:", err));

// Middleware
app.use(express.json());

// Define User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
});

const User = mongoose.model("User", userSchema);

// Define Message Schema
const messageSchema = new mongoose.Schema({
  message: { type: String, required: true },
  sourceId: { type: String, required: true },
  targetId: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
});

const Message = mongoose.model("Message", messageSchema);

// Route: Login or Create User
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    // Check if user already exists
    let user = await User.findOne({ username });
    if (!user) {
      // If user doesn't exist, create a new one
      const hashedPassword = await bcrypt.hash(password, 10);
      user = new User({
        username,
        email: `${username}@example.com`,
        password: hashedPassword,
      });
      await user.save();
      console.log("New user created:", user);
    } else {
      // If user exists, validate password
      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return res.status(400).json({ message: "Invalid username or password" });
      }
    }

    // Generate a JWT token
    const token = jwt.sign({ id: user._id }, "secretKey", { expiresIn: "1h" });

    res.status(200).json({
      message: "Login successful",
      token,
      user: { id: user._id, username: user.username, email: user.email },
    });
  } catch (error) {
    console.error("Error during login:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Route: Get All Users
app.get("/users", async (req, res) => {
  try {
    const users = await User.find({}, { password: 0 }); // Exclude passwords
    res.status(200).json(users);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Route: Get Messages Between Two Users
app.get("/messages", async (req, res) => {
  const { sourceId, targetId } = req.query;

  if (!sourceId || !targetId) {
    return res
      .status(400)
      .json({ message: "sourceId and targetId are required" });
  }

  try {
    const messages = await Message.find({
      $or: [
        { sourceId, targetId },
        { sourceId: targetId, targetId: sourceId },
      ],
    }).sort({ timestamp: 1 }); // Sort by timestamp (ascending)

    res.status(200).json(messages);
  } catch (error) {
    console.error("Error fetching messages:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// WebSocket Handling
io.on("connection", (socket) => {
  console.log(`New client connected: ${socket.id}`);

  socket.on("signin", async (id) => {
    console.log(`User signed in with ID: ${id}`);
    userSocketMap[id] = socket.id;

    // Store the user in Redis
    await redis.hset("userSocketMap", id, socket.id);

    pubClient.publish("userStatus", JSON.stringify({ userId: id, action: "connect" }));
    console.log("Clients:", Object.keys(userSocketMap));
  });

  socket.on("message", async (msg) => {
    console.log(`Received message: ${JSON.stringify(msg)}`);
    if (!msg || !msg.targetId || !msg.message) {
      console.error("Invalid message format. Received:", msg);
      return;
    }

    try {
      // Save the message to the database
      const newMessage = new Message({
        message: msg.message,
        sourceId: msg.sourceId,
        targetId: msg.targetId,
      });
      await newMessage.save();
      console.log("Message saved to database:", newMessage);

      // Send the message to the recipient if they're online
      const targetSocketId = await redis.hget("userSocketMap", msg.targetId);

      if (targetSocketId) {
        io.to(targetSocketId).emit("message", msg);
        console.log(`Message sent to user ${msg.targetId}`);
      } else {
        console.warn(`User ${msg.targetId} is offline`);
      }
    } catch (err) {
      console.error("Error saving message to database:", err);
    }
  });

  socket.on("disconnect", async () => {
    console.log(`Client disconnected: ${socket.id}`);

    const disconnectedUser = Object.keys(userSocketMap).find(
      (key) => userSocketMap[key] === socket.id
    );

    if (disconnectedUser) {
      delete userSocketMap[disconnectedUser];
      await redis.hdel("userSocketMap", disconnectedUser);

      pubClient.publish(
        "userStatus",
        JSON.stringify({ userId: disconnectedUser, action: "disconnect" })
      );
      console.log(`Removed disconnected user: ${disconnectedUser}`);
    }

    console.log("Clients after disconnection:", Object.keys(userSocketMap));
  });

  socket.on("error", (err) => {
    console.error("Socket error:", err);
  });
});

// Redis Subscriptions
subClient.subscribe("userStatus");

subClient.on("message", (channel, message) => {
  if (channel === "userStatus") {
    const { userId, action } = JSON.parse(message);
    console.log(`User ${userId} has ${action}`);
    io.emit("getOnlineUsers", Object.keys(userSocketMap));
  }
});

// Start the server
server.listen(port, "0.0.0.0", () => {
  console.log(`Server started and listening on port ${port}`);
});
