// index.js
const express = require("express");
const session = require("express-session"); // مكتبة الجلسات
const axios = require("axios");
const http = require("http");
const { Server } = require("socket.io");
const bodyParser = require("body-parser");
const multer = require("multer");
const FormData = require("form-data");
const admin = require("firebase-admin");

// --- إعدادات فايربيس ---
const firebaseKey = JSON.parse(process.env.FIREBASE_KEY);
admin.initializeApp({
  credential: admin.credential.cert(firebaseKey),
  databaseURL: "https://ebe-plus-54785-default-rtdb.firebaseio.com",
});
const db = admin.database();

// --- إعدادات السيرفر ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ storage: multer.memoryStorage() });

// إعداد الجلسة (للحماية)
app.use(
  session({
    secret: "super-secret-key-change-it",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }, // في Replit العادي يكفي false
  }),
);

app.use(bodyParser.json());

// هذا الرابط مفتوح للجميع (عشان الـ Uptime Robot)
app.get("/ping", (req, res) => {
  res.status(200).send("I am alive!");
});

// حماية الملفات الثابتة وباقي الروابط
const protect = (req, res, next) => {
  // السماح بمرور الـ Ping وصفحة الدخول والملفات الضرورية
  if (
    req.path === "/ping" ||
    req.path === "/api/login" ||
    req.path === "/api/checkAuth"
  ) {
    return next();
  }

  if (req.session.authenticated) {
    next();
  } else {
    // إذا طلب API نرفض
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    // غير ذلك نعتبره طلب للموقع فنعرض له الـ index.html (والواجهة ستظهر له القفل)
    next();
  }
};

app.use(protect);
app.use(express.static("public"));

// ... (باقي الكود كما هو)

const TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_PASS = process.env.ADMIN_PASSWORD || "123"; // كلمة السر
const TELE_API = `https://api.telegram.org/bot${TOKEN}`;

// --- دوال مساعدة ---

async function saveMessageToFirebase(chatId, messageData, isFromSite = false) {
  try {
    const msgId = messageData.message_id;
    if (isFromSite) {
      if (!messageData.from) messageData.from = {};
      messageData.from.is_site = true;
    }

    // إضافة التوقيت إذا لم يكن موجوداً (تيليجرام يرسله بالثواني، نحوله لملي ثانية)
    if (!messageData.date) messageData.date = Math.floor(Date.now() / 1000);

    // 1. حفظ الرسالة
    await db.ref(`messages/${chatId}/${msgId}`).set({
      update_id: Date.now(),
      message: messageData,
    });

    // 2. الملخص
    let summary = "[Message]";
    if (messageData.text) summary = messageData.text;
    else if (messageData.photo) summary = "[Photo 📷]";
    else if (messageData.voice) summary = "[Voice 🎤]";
    else if (messageData.document) summary = "[File 📁]";

    if (isFromSite) summary = `You: ${summary}`;

    const chatInfo = messageData.chat || {};
    const updateData = { last_message: summary, ts: Date.now() };

    if (chatInfo.first_name) updateData.first_name = chatInfo.first_name;
    if (chatInfo.last_name) updateData.last_name = chatInfo.last_name;
    if (chatInfo.username) updateData.username = chatInfo.username;

    await db.ref(`chats_list/${chatId}`).update(updateData);

    if (!isFromSite && chatInfo.id) {
      await db.ref(`users/${chatId}`).update({
        id: chatInfo.id,
        first_name: chatInfo.first_name || "",
        last_name: chatInfo.last_name || "",
        username: chatInfo.username || "",
        language_code: messageData.from?.language_code || "",
      });
    }

    io.emit("update", { chatId, message: { message: messageData } });
  } catch (err) {
    console.error("Firebase Save Error:", err);
  }
}

async function deleteChatData(chatId) {
  try {
    await db.ref(`messages/${chatId}`).remove();
    await db.ref(`chats_list/${chatId}`).remove();
    await db.ref(`users/${chatId}`).remove();
    io.emit("delete_chat", { chatId });
  } catch (err) {
    console.error(err);
  }
}

// --- Socket IO for Typing Status ---
io.on("connection", (socket) => {
  // استقبال حدث الكتابة من الموقع وإرساله لتيليجرام
  socket.on("typing", async (chatId) => {
    try {
      await axios.post(`${TELE_API}/sendChatAction`, {
        chat_id: chatId,
        action: "typing",
      });
    } catch (e) {}
  });
});

// --- Routes ---

// Login API
app.post("/api/login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASS) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false });
  }
});

// Check Auth API (للتأكد من حالة الدخول عند تحديث الصفحة)
app.get("/api/checkAuth", (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

// Webhook
app.post("/webhook", async (req, res) => {
  const update = req.body;
  if (update.my_chat_member) {
    const status = update.my_chat_member.new_chat_member.status;
    if (status === "kicked" || status === "left")
      await deleteChatData(update.my_chat_member.chat.id);
  } else if (update.message) {
    await saveMessageToFirebase(update.message.chat.id, update.message, false);
  }
  res.sendStatus(200);
});

// Send Text (With Reply Support)
app.post("/api/sendText", async (req, res) => {
  try {
    const { chat_id, text, reply_to_message_id } = req.body;
    const params = { chat_id, text, parse_mode: "HTML" };
    if (reply_to_message_id) params.reply_to_message_id = reply_to_message_id;

    const r = await axios.post(`${TELE_API}/sendMessage`, params);
    if (r.data.ok) await saveMessageToFirebase(chat_id, r.data.result, true);
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// Send File
app.post("/api/sendFile", upload.single("file"), async (req, res) => {
  try {
    const { chat_id, reply_to_message_id } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file" });

    let method = "sendDocument";
    if (file.mimetype.startsWith("image/")) method = "sendPhoto";
    else if (file.mimetype.startsWith("audio/")) method = "sendAudio";

    const form = new FormData();
    form.append("chat_id", chat_id);
    const fieldName =
      method === "sendPhoto"
        ? "photo"
        : method === "sendAudio"
          ? "audio"
          : "document";
    form.append(fieldName, file.buffer, file.originalname);
    if (reply_to_message_id)
      form.append("reply_to_message_id", reply_to_message_id);

    const r = await axios.post(`${TELE_API}/${method}`, form, {
      headers: form.getHeaders(),
    });
    if (r.data.ok) {
      await saveMessageToFirebase(chat_id, r.data.result, true);
      res.json(r.data);
    } else {
      res.status(400).json(r.data);
    }
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

app.post("/api/deleteChat", async (req, res) => {
  try {
    await deleteChatData(req.body.chatId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// استبدال دالة الـ Proxy بالكامل في index.js

app.get("/api/proxyFile/:file_id", async (req, res) => {
  try {
    const file_id = req.params.file_id;
    const fileName = req.query.name || "file";

    // 1. طلب مسار الملف من تيليجرام (تم التعديل لإرسال الـ Params بشكل آمن)
    const r = await axios.get(`${TELE_API}/getFile`, {
      params: { file_id: file_id },
    });

    if (!r.data.ok) return res.status(404).send("File not found on Telegram");

    const filePath = r.data.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

    // 2. تحميل الملف كـ Stream
    const response = await axios({
      method: "get",
      url: downloadUrl,
      responseType: "stream",
    });

    // 3. ضبط الترويسة (Headers)
    res.setHeader("Content-Type", response.headers["content-type"]);
    res.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );

    // 4. تمرير الملف
    response.data.pipe(res);
  } catch (err) {
    // تحسين عرض الخطأ لمعرفة السبب
    const telegramError =
      err.response && err.response.data
        ? err.response.data.description
        : err.message;
    console.error("Proxy Error:", telegramError);

    // إذا كان الخطأ 400 غالباً بسبب حجم الملف
    if (err.response && err.response.status === 400) {
      return res
        .status(400)
        .send(
          `Telegram Error: ${telegramError} (Note: Bots cannot download files larger than 20MB)`,
        );
    }

    res.status(500).send(`Server Error: ${telegramError}`);
  }
});

app.get("/api/chats", async (req, res) => {
  if (!req.session.authenticated) return res.status(401).json({});
  const snap = await db.ref("chats_list").orderByChild("ts").once("value");
  res.json(snap.val() || {});
});
app.get("/api/messages/:chatId", async (req, res) => {
  if (!req.session.authenticated) return res.status(401).json({});
  const snap = await db.ref(`messages/${req.params.chatId}`).once("value");
  res.json(snap.val() || {});
});
app.get("/api/user/:chatId", async (req, res) => {
  if (!req.session.authenticated) return res.status(401).json({});
  const snap = await db.ref(`users/${req.params.chatId}`).once("value");
  res.json(snap.val() || {});
});

// --- New Features: Edit & Delete ---

// 1. API حذف الرسالة
app.post("/api/deleteMessage", async (req, res) => {
  try {
    const { chat_id, message_id } = req.body;

    // مسح من تيليجرام
    await axios.post(`${TELE_API}/deleteMessage`, { chat_id, message_id });

    // مسح من قاعدة البيانات
    await db.ref(`messages/${chat_id}/${message_id}`).remove();

    // إشعار الواجهة بالحذف
    io.emit("message_deleted", { chat_id, message_id });

    res.json({ success: true });
  } catch (err) {
    // حتى لو فشل الحذف من تيليجرام (لو الرسالة قديمة)، نحذفها من الداتا بيس عندنا
    console.error("Delete Error:", err.message);
    // محاولة حذف من الداتا بيس كاحتياط
    if (req.body.chat_id && req.body.message_id) {
      await db
        .ref(`messages/${req.body.chat_id}/${req.body.message_id}`)
        .remove();
    }
    res.status(500).json({ error: err.toString() });
  }
});

// 2. API تعديل الرسالة
app.post("/api/editMessage", async (req, res) => {
  try {
    const { chat_id, message_id, text } = req.body;

    // تعديل في تيليجرام
    const r = await axios.post(`${TELE_API}/editMessageText`, {
      chat_id,
      message_id,
      text,
      parse_mode: "HTML",
    });

    if (r.data.ok) {
      // تعديل في قاعدة البيانات
      // بنحتاج نحدث النص جوه الـ object
      await db
        .ref(`messages/${chat_id}/${message_id}/message`)
        .update({ text: text });

      // إشعار الواجهة
      io.emit("message_edited", { chat_id, message_id, text });
      res.json({ success: true });
    } else {
      res.status(400).json(r.data);
    }
  } catch (err) {
    console.error("Edit Error:", err.message);
    res.status(500).json({ error: err.toString() });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));
