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
  .connect(mongoURI)
  .then(() => console.log("Connected to MongoDB successfully."))
  .catch((err) => console.error("MongoDB connection error:", err));

// Middleware
app.use(express.json());

// Define Schemas
const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
});

const groupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  createdAt: { type: Date, default: Date.now },
});

// Add indexing for group members for efficient queries
groupSchema.index({ members: 1 });

const messageSchema = new mongoose.Schema({
  message: { type: String, required: true },
  sourceId: { type: String, required: true },
  targetId: { type: String, required: false }, // Optional for group messages
  groupId: { type: String, required: false }, // Optional for group messages
  timestamp: { type: Date, default: Date.now },
});

// Models
const User = mongoose.model("User", userSchema);
const Group = mongoose.model("Group", groupSchema);
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
        return res
          .status(400)
          .json({ message: "Invalid username or password" });
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

// Route: Create Group
app.post("/group", async (req, res) => {
  const { name, members } = req.body;

  if (!name || !Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ message: "Invalid group data" });
  }

  try {
    const validMembers = await User.find({ _id: { $in: members } });

    if (validMembers.length !== members.length) {
      return res.status(400).json({ message: "Some members are invalid" });
    }

    const newGroup = new Group({
      name,
      members,
    });

    await newGroup.save();

    res.status(201).json({
      message: "Group created successfully",
      group: newGroup,
    });
  } catch (error) {
    console.error("Error creating group:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Route: Get Groups for a User
app.get("/user/groups", async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ message: "User ID is required" });
  }

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ message: "Invalid User ID format" });
  }

  try {
    console.log("Received request for groups of userId:", userId);

    const userObjectId = new mongoose.Types.ObjectId(userId);
    console.log("Converted userId to ObjectId:", userObjectId);

    const groups = await Group.find({ members: userObjectId }).populate(
      "members",
      "username email"
    );
    console.log("Fetched groups:", groups);

    if (groups.length === 0) {
      return res.status(200).json({
        message: "No groups found for this user",
        groups: [],
      });
    }

    res.status(200).json({
      message: "Groups fetched successfully",
      groups,
    });
  } catch (error) {
    console.error("Error fetching groups:", error.message, error.stack);
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

// Route: Send a Message to a Group
app.post("/group/:groupId/message", async (req, res) => {
  const { groupId } = req.params;
  const { senderId, message } = req.body;

  if (!groupId || !senderId || !message) {
    return res
      .status(400)
      .json({ message: "groupId, senderId, and message are required" });
  }

  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    return res.status(400).json({ message: "Invalid groupId format" });
  }

  try {
    // Check if the group exists
    const group = await Group.findById(groupId);
    if (!group) {
      return res.status(404).json({ message: "Group not found" });
    }

    // Save the message to the database
    const newMessage = new Message({
      message,
      sourceId: senderId,
      groupId,
      timestamp: new Date(),
    });

    await newMessage.save();

    // Notify all group members using WebSocket
    for (const memberId of group.members) {
      const targetSocketId = await redis.hget(
        "userSocketMap",
        memberId.toString()
      );
      if (targetSocketId) {
        io.to(targetSocketId).emit("groupMessage", {
          groupId,
          message: {
            senderId,
            message,
            timestamp: newMessage.timestamp,
          },
        });
      }
    }

    res.status(201).json({
      message: "Message sent successfully",
      data: newMessage,
    });
  } catch (error) {
    console.error("Error sending group message:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Route: Get All Messages for a Group
app.get("/group/:groupId/messages", async (req, res) => {
  const { groupId } = req.params;

  if (!groupId) {
    return res.status(400).json({ message: "groupId is required" });
  }

  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    return res.status(400).json({ message: "Invalid groupId format" });
  }

  try {
    // Fetch all messages for the given groupId
    const messages = await Message.find({ groupId }).sort({ timestamp: 1 }); // Sort by oldest to newest

    res.status(200).json(messages);
  } catch (error) {
    console.error("Error fetching group messages:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// WebSocket Handling
io.on("connection", (socket) => {
  console.log(`New client connected: ${socket.id}`);

  // socket.on("signin", async (id) => {
  //   console.log(`User signed in with ID: ${id}`);
  //   userSocketMap[id] = socket.id;

  //   // Store the user in Redis
  //   await redis.hset("userSocketMap", id, socket.id);

  //   pubClient.publish(
  //     "userStatus",
  //     JSON.stringify({ userId: id, action: "connect" })
  //   );
  //   console.log("Clients:", Object.keys(userSocketMap));
  // });

  socket.on("signin", async (userId) => {
    console.log(`User signed in with ID: ${userId}`);
    userSocketMap[userId] = socket.id;
  
    // Join the group room for group message broadcasting
    const userGroups = await Group.find({ members: userId });
    userGroups.forEach((group) => {
      socket.join(group._id.toString());
    });
  
    // Store the user in Redis
    await redis.hset("userSocketMap", userId, socket.id);
  
    pubClient.publish(
      "userStatus",
      JSON.stringify({ userId, action: "connect" })
    );
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

  socket.on("groupMessage", async (msg) => {
    console.log(`Received message: ${JSON.stringify(msg)}`);

    if (!msg || !msg.groupId || !msg.message) {
      console.error("Invalid group message format:", msg);
      return;
    }

    try {
      const newMessage = new Message({
        message: msg.message,
        sourceId: msg.sourceId,
        groupId: msg.groupId,
        timestamp: new Date(),
      });
      await newMessage.save();

      const group = await Group.findById(msg.groupId);
      for (const memberId of group.members) {
        const targetSocketId = await redis.hget("userSocketMap", memberId.toString());
        if (targetSocketId) {
          io.to(targetSocketId).emit("groupMessage", {
            groupId: msg.groupId,
            message: newMessage,
          });
        }
      }
    } catch (error) {
      console.error("Error saving group message:", error);
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

// Start the Server
server.listen(port, "0.0.0.0", () => {
  console.log(`Server started and listening on port ${port}`);
});
