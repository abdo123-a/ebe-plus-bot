// index.js
require("dotenv").config();
const express = require("express");
const session = require("express-session"); // مكتبة الجلسات
const axios = require("axios");
const http = require("http");
const { Server } = require("socket.io");
const bodyParser = require("body-parser");
const multer = require("multer");
const FormData = require("form-data");
const admin = require("firebase-admin");

// --- إعدادات AI ---
// const { GoogleGenerativeAI } = require("@google/generative-ai");
// // احصل على مفتاح مجاني من: https://aistudio.google.com/app/apikey
// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

//new--

// رابط Gemini المباشر (أضمن وأسرع)
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
let aiEnabled = false; // متغير لحفظ حالة الذكاء الاصطناعي

//-----

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

// دالة لتجهيز تاريخ المحادثة للذكاء الاصطناعي
async function getChatHistory(chatId) {
  try {
    // هات آخر 10 رسايل بس عشان السرعة والتكلفة
    const snap = await db
      .ref(`messages/${chatId}`)
      .orderByKey()
      .limitToLast(10)
      .once("value");
    const data = snap.val();

    if (!data) return [];

    const history = [];

    // تحويل رسايل فايربيس لتنسيق Gemini
    Object.values(data).forEach((item) => {
      const msg = item.message;
      // نتأكد إن الرسالة فيها نص (مش صورة أو ملف)
      if (msg.text) {
        // لو الرسالة من الموقع (is_site) يبقى دي رد البوت (model)
        // لو مفيش is_site يبقى دي رسالة المستخدم (user)
        const role = msg.from && msg.from.is_site ? "model" : "user";

        history.push({
          role: role,
          parts: [{ text: msg.text }],
        });
      }
    });

    return history;
  } catch (error) {
    console.error("Error fetching history:", error);
    return [];
  }
}

// دالة لتحميل الصورة من تيليجرام وتحويلها لـ Base64
async function downloadImageAsBase64(fileId) {
  try {
    // 1. نجيب مسار الملف من تيليجرام
    const res = await axios.get(`${TELE_API}/getFile?file_id=${fileId}`);
    const filePath = res.data.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

    // 2. نحمل الصورة كـ ArrayBuffer
    const imageRes = await axios.get(downloadUrl, {
      responseType: "arraybuffer",
    });

    // 3. نحولها لـ Base64
    return Buffer.from(imageRes.data).toString("base64");
  } catch (e) {
    console.error("Error downloading image:", e.message);
    return null;
  }
}

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
    const msg = update.message;
    const chatId = msg.chat.id;

    // 1. حفظ رسالة المستخدم أولاً
    await saveMessageToFirebase(chatId, msg, false);

    // 2. التحقق لو وضع الـ AI شغال (والرسالة فيها نص أو صورة)
    if (aiEnabled && (msg.text || msg.caption || msg.photo)) {
      try {
        await axios.post(`${TELE_API}/sendChatAction`, {
          chat_id: chatId,
          action: "typing",
        });

        // --- تجهيز محتوى الرسالة الحالية (نص + صورة محتملة) ---
        const currentParts = [];

        // 1. لو فيه نص أو كابشن للصورة
        const userText = msg.text || msg.caption;
        if (userText) {
          currentParts.push({ text: userText });
        } else if (msg.photo) {
          // لو بعت صورة من غير كلام، نعتبره بيسأل "إيه ده؟"
          currentParts.push({ text: "ماذا يوجد في هذه الصورة؟" });
        }

        // 2. لو فيه صورة
        if (msg.photo) {
          // تيليجرام بيبعت الصورة بأحجام مختلفة، بناخد آخر واحد (أعلى جودة)
          const photoObj = msg.photo[msg.photo.length - 1];
          const base64Image = await downloadImageAsBase64(photoObj.file_id);

          if (base64Image) {
            currentParts.push({
              inline_data: {
                mime_type: "image/jpeg",
                data: base64Image,
              },
            });
          }
        }

        // --- تجميع التاريخ والرسالة ---
        const history = await getChatHistory(chatId);
        const systemPrompt = {
          role: "user",
          parts: [
            {
              text: "تصرف كمساعد شخصي ذكي ومحترم اسمك هو ايبي بلس (ebe plus). رد باللهجة التي تجدها مناسبة او بلهجة المستخدم او باللغة العربية الفصحى. المعلومات التي سأذكرها لك الآن تخص هذا المستخدم فقط. مطورك اسمه عبدالرحمن (abdo)",
            },
          ],
        };

        // 3. ضيف الرسالة الجديدة اللي لسه واصلة دلوقتي
        // (ملحوظة: إحنا مش محتاجين نضيفها يدوي لو هي اتحفظت في الداتا بيس وجت مع الهيستوري،
        // بس عشان نضمن إنها آخر حاجة، هنبعت الهيستوري القديم + الرسالة الجديدة)

        const currentMessage = {
          role: "user",
          parts: currentParts,
        };

        // تجميع كل حاجة: التعليمات + التاريخ القديم + الرسالة الجديدة
        const fullConversation = [systemPrompt, ...history, currentMessage];

        // --- الإرسال لـ Gemini ---
        const response = await axios.post(GEMINI_URL, {
          contents: fullConversation,
        });

        const aiResponse = response.data.candidates[0].content.parts[0].text;

        // إرسال الرد وتخزينه
        const r = await axios.post(`${TELE_API}/sendMessage`, {
          chat_id: chatId,
          text: aiResponse,
          parse_mode: "Markdown",
        });

        if (r.data.ok) {
          await saveMessageToFirebase(chatId, r.data.result, true);
        }
      } catch (error) {
        console.error(
          "AI Vision Error:",
          error.response ? error.response.data : error.message,
        );
        if (aiEnabled) {
          axios.post(`${TELE_API}/sendMessage`, {
            chat_id: chatId,
            text: "معلش، حصل مشكلة وأنا بحاول أشوف الصورة دي 😅",
          });
        }
      }
    }
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

// API لتغيير وضع الذكاء الاصطناعي
app.post("/api/toggleAI", (req, res) => {
  aiEnabled = !aiEnabled;
  console.log("AI Mode:", aiEnabled ? "ON" : "OFF");
  res.json({ status: aiEnabled });
});

// API لمعرفة حالة الذكاء الاصطناعي عند فتح الموقع
app.get("/api/getAIStatus", (req, res) => {
  res.json({ status: aiEnabled });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));
