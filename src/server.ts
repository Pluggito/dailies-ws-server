import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

interface ExtendedWebSocket extends WebSocket {
  userId?: string;
  chatRooms?: Set<string>;
  isAlive?: boolean;
}

// Use PORT from environment (Render provides this)
const PORT = process.env.PORT || 8085;

// Create HTTP server first (required for Render)
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        connections: wss.clients.size,
        users: userConnections.size,
        rooms: roomConnections.size,
      })
    );
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("WebSocket Server Running");
  }
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server });

// Store connections by userId for direct messaging
const userConnections = new Map<string, Set<ExtendedWebSocket>>();

// Store connections by chatRoomId for room broadcasting
const roomConnections = new Map<string, Set<ExtendedWebSocket>>();

// Rate limiting
const messageRateLimits = new Map<
  string,
  { count: number; resetTime: number }
>();
const MAX_MESSAGES_PER_MINUTE = 60;

console.log(`🚀 WebSocket server starting on port ${PORT}`);
console.log("📡 Broadcasting only - Database writes handled by API");

// ==================== UTILITY FUNCTIONS ====================

// Heartbeat function
function heartbeat(this: ExtendedWebSocket) {
  this.isAlive = true;
}

// Rate limiting check
function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const userLimit = messageRateLimits.get(userId);

  if (!userLimit || now > userLimit.resetTime) {
    messageRateLimits.set(userId, {
      count: 1,
      resetTime: now + 60000,
    });
    return true;
  }

  if (userLimit.count >= MAX_MESSAGES_PER_MINUTE) {
    return false;
  }

  userLimit.count++;
  return true;
}

// ==================== HEARTBEAT ====================
const HEARTBEAT_INTERVAL = 30000;

const interval = setInterval(() => {
  wss.clients.forEach((ws: WebSocket) => {
    const extWs = ws as ExtendedWebSocket;
    if (extWs.isAlive === false) {
      console.log(`💀 Terminating dead connection for user ${extWs.userId}`);
      return extWs.terminate();
    }
    extWs.isAlive = false;
    extWs.ping();
  });
}, HEARTBEAT_INTERVAL);

wss.on("close", () => {
  clearInterval(interval);
});

// ==================== CONNECTION HANDLER ====================
wss.on("connection", (ws: WebSocket, req) => {
  const extWs = ws as ExtendedWebSocket;
  console.log("✅ Client connected");

  extWs.isAlive = true;
  extWs.on("pong", heartbeat);

  // Connection timeout
  const connectionTimeout = setTimeout(() => {
    if (!extWs.userId) {
      console.log("⏰ Connection timeout - no userId provided");
      extWs.close(4000, "Connection timeout");
    }
  }, 10000);

  // Extract userId from query params
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const userId = url.searchParams.get("userId");

  if (userId) {
    clearTimeout(connectionTimeout);
    extWs.userId = userId;
    extWs.chatRooms = new Set();

    // Add to user connections
    if (!userConnections.has(userId)) {
      userConnections.set(userId, new Set());
    }
    userConnections.get(userId)?.add(extWs);

    console.log(
      `👤 User ${userId} connected (Total: ${userConnections.size} users)`
    );
  }

  extWs.on("message", async (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      const { type, payload } = message;

      switch (type) {
        case "joinRoom":
          handleJoinRoom(extWs, payload);
          break;

        case "leaveRoom":
          handleLeaveRoom(extWs, payload);
          break;

        case "message:send":
          await handleSendMessage(extWs, payload);
          break;

        case "typing:start":
          handleTypingStart(extWs, payload);
          break;

        case "typing:stop":
          handleTypingStop(extWs, payload);
          break;

        case "messages:read":
          await handleMessagesRead(extWs, payload);
          break;

        default:
          console.log("❓ Unknown message type:", type);
      }
    } catch (error) {
      console.error("Error handling message:", error);
      extWs.send(
        JSON.stringify({
          type: "error",
          payload: { message: "Invalid message format" },
        })
      );
    }
  });

  extWs.on("close", () => {
    console.log("❌ Client disconnected");
    if (extWs.userId) {
      // Remove from user connections
      const userWs = userConnections.get(extWs.userId);
      if (userWs) {
        userWs.delete(extWs);
        if (userWs.size === 0) {
          userConnections.delete(extWs.userId);
        }
      }

      // Remove from all rooms and clear typing indicators
      extWs.chatRooms?.forEach((roomId) => {
        const roomWs = roomConnections.get(roomId);
        if (roomWs) {
          roomWs.delete(extWs);
          if (roomWs.size === 0) {
            roomConnections.delete(roomId);
          }
        }

        // Clear typing indicator
        const typingKey = `${extWs.userId}:${roomId}`;
        const timeout = typingTimeouts.get(typingKey);
        if (timeout) {
          clearTimeout(timeout);
          typingTimeouts.delete(typingKey);
        }

        // Notify others that user stopped typing
        broadcastToRoom(roomId, {
          type: "typing:hide",
          payload: { chatRoomId: roomId, userId: extWs.userId },
        });
      });

      console.log(
        `👋 User ${extWs.userId} disconnected (Remaining: ${userConnections.size} users)`
      );
    }
  });

  extWs.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

// ==================== JOIN CHAT ROOM ====================
function handleJoinRoom(ws: ExtendedWebSocket, payload: any) {
  const { chatRoomId } = payload;
  const userId = ws.userId;

  if (!chatRoomId || !userId) {
    ws.send(
      JSON.stringify({
        type: "error",
        payload: { message: "Invalid payload for joinRoom" },
      })
    );
    return;
  }

  // Add to room connections
  if (!roomConnections.has(chatRoomId)) {
    roomConnections.set(chatRoomId, new Set());
  }
  roomConnections.get(chatRoomId)?.add(ws);
  ws.chatRooms?.add(chatRoomId);

  const roomSize = roomConnections.get(chatRoomId)?.size || 0;
  console.log(
    `📥 User ${userId} joined room ${chatRoomId} (${roomSize} in room)`
  );

  ws.send(
    JSON.stringify({ type: "joinRoom:success", payload: { chatRoomId } })
  );
}

// ==================== LEAVE CHAT ROOM ====================
function handleLeaveRoom(ws: ExtendedWebSocket, payload: any) {
  const { chatRoomId } = payload;
  const userId = ws.userId;

  if (!chatRoomId) return;

  const roomWs = roomConnections.get(chatRoomId);
  if (roomWs) {
    roomWs.delete(ws);
    if (roomWs.size === 0) {
      roomConnections.delete(chatRoomId);
    }
  }

  ws.chatRooms?.delete(chatRoomId);
  console.log(`📤 User ${userId} left room ${chatRoomId}`);
}

// ==================== SEND MESSAGE ====================
async function handleSendMessage(ws: ExtendedWebSocket, payload: any) {
  const userId = ws.userId;
  const {
    chatRoomId,
    content,
    type = "TEXT",
    mediaUrl = null,
    duration = null,
  } = payload;

  if (!chatRoomId || !userId) {
    ws.send(
      JSON.stringify({
        type: "error",
        payload: { message: "Missing required fields" },
      })
    );
    return;
  }

  // Rate limiting
  if (!checkRateLimit(userId)) {
    ws.send(
      JSON.stringify({
        type: "error",
        payload: { message: "Rate limit exceeded. Please slow down." },
      })
    );
    return;
  }

  try {
    console.log(`📨 Message from ${userId} in room ${chatRoomId}`);

    // Call Next.js API to save message to database
    const apiUrl = process.env.API_URL || "http://localhost:3000";
    const response = await axios.post(
      `${apiUrl}/api/chatroom/${chatRoomId}/messages`,
      {
        senderId: userId,
        content,
        type,
        mediaUrl,
        duration,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-secret": process.env.API_SECRET || "development-secret-key",
        },
      }
    );

    if (response.status !== 201) {
      throw new Error(`API responded with status ${response.status}`);
    }

    const savedMessage = response.data;
    console.log(`✅ Message saved to DB: ${savedMessage.id}`);

    // Transform message for WebSocket broadcast
    const transformedMessage = {
      id: savedMessage.id,
      content: savedMessage.content,
      type: savedMessage.type,
      mediaUrl: savedMessage.mediaUrl,
      duration: savedMessage.duration,
      createdAt: savedMessage.createdAt,
      senderId: savedMessage.senderId,
      sender: savedMessage.sender,
      readers: savedMessage.readers || [],
      system: false,
      chatRoomId: chatRoomId,
    };

    // Broadcast to all members in the chat room
    const roomMembers = roomConnections.get(chatRoomId);
    if (roomMembers) {
      const broadcast = {
        type: "message:received",
        payload: transformedMessage,
      };

      roomMembers.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(broadcast));
        }
      });
      console.log(`📡 Broadcasted to ${roomMembers.size} connected clients`);
    }

    // Send chat list update to all potentially affected users
    const chatListUpdate = {
      type: "chatList:update",
      payload: {
        chatRoomId: chatRoomId,
        message: transformedMessage,
      },
    };

    // Broadcast chat list update
    userConnections.forEach((connections) => {
      connections.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(chatListUpdate));
        }
      });
    });
  } catch (error: any) {
    console.error("❌ Error sending message:", {
      userId,
      chatRoomId,
      error: error.message,
    });
    ws.send(
      JSON.stringify({
        type: "error",
        payload: { message: "Failed to send message" },
      })
    );
  }
}

// ==================== TYPING INDICATORS ====================
const typingTimeouts = new Map<string, NodeJS.Timeout>();

function handleTypingStart(ws: ExtendedWebSocket, payload: any) {
  const userId = ws.userId;
  const { chatRoomId } = payload;

  if (!chatRoomId || !userId) return;

  const typingKey = `${userId}:${chatRoomId}`;

  // Clear existing timeout
  const existingTimeout = typingTimeouts.get(typingKey);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  // Set new timeout to auto-clear typing after 3 seconds
  const timeout = setTimeout(() => {
    handleTypingStop(ws, { chatRoomId });
    typingTimeouts.delete(typingKey);
  }, 3000);

  typingTimeouts.set(typingKey, timeout);

  broadcastToRoom(
    chatRoomId,
    {
      type: "typing:show",
      payload: { chatRoomId, userId },
    },
    ws
  );

  console.log(`⌨️  User ${userId} typing in room ${chatRoomId}`);
}

function handleTypingStop(ws: ExtendedWebSocket, payload: any) {
  const userId = ws.userId;
  const { chatRoomId } = payload;

  if (!chatRoomId || !userId) return;

  const typingKey = `${userId}:${chatRoomId}`;

  // Clear timeout
  const timeout = typingTimeouts.get(typingKey);
  if (timeout) {
    clearTimeout(timeout);
    typingTimeouts.delete(typingKey);
  }

  broadcastToRoom(
    chatRoomId,
    {
      type: "typing:hide",
      payload: { chatRoomId, userId },
    },
    ws
  );
}

// ==================== MARK MESSAGES AS READ ====================
async function handleMessagesRead(ws: ExtendedWebSocket, payload: any) {
  const userId = ws.userId;
  const { chatRoomId, messageIds } = payload;

  if (!chatRoomId || !userId) return;

  try {
    console.log(
      `📖 User ${userId} marking messages as read in room ${chatRoomId}`
    );

    // Call API to mark messages as read (using axios for consistency)
    const apiUrl = process.env.API_URL || "http://localhost:3000";
    const response = await axios.post(
      `${apiUrl}/api/chatroom/${chatRoomId}/messages/unread`,
      {
        userId,
        messageIds,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-secret": process.env.API_SECRET || "development-secret-key",
        },
      }
    );

    console.log(`✅ Marked ${response.data.markedCount} messages as read`);

    // Broadcast read receipt to other members in the room
    broadcastToRoom(
      chatRoomId,
      {
        type: "messages:read",
        payload: {
          chatRoomId,
          userId,
          messageIds,
          timestamp: new Date().toISOString(),
        },
      },
      ws
    );
  } catch (error: any) {
    console.error("❌ Error marking messages as read:", {
      userId,
      chatRoomId,
      error: error.message,
    });
  }
}

// ==================== HELPER FUNCTIONS ====================
function broadcastToRoom(
  roomId: string,
  message: any,
  exclude?: ExtendedWebSocket
) {
  const roomWs = roomConnections.get(roomId);
  if (!roomWs) return;

  const messageStr = JSON.stringify(message);
  roomWs.forEach((client) => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
}

// ==================== GRACEFUL SHUTDOWN ====================
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

function gracefulShutdown() {
  console.log("🛑 Shutting down WebSocket server...");

  // Close all connections
  wss.clients.forEach((ws) => {
    ws.close(1000, "Server shutting down");
  });

  // Close WebSocket server
  wss.close(() => {
    console.log("✅ WebSocket server closed");
    server.close(() => {
      console.log("✅ HTTP server closed");
      process.exit(0);
    });
  });
}

// ==================== SERVER STATS ====================
setInterval(() => {
  console.log(
    `📊 Stats: ${userConnections.size} users, ${roomConnections.size} active rooms`
  );
}, 300000); // Every 5 minutes

// ==================== START SERVER ====================
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   WebSocket Server Started             ║
║   Port: ${PORT}                        
║   Health: http://localhost:${PORT}/health 
╚════════════════════════════════════════╝
  `);
});
