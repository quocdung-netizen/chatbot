import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || "gpt-6-astra";
const INDEX_PATH = fileURLToPath(new URL("./index.html", import.meta.url));
const MAX_BODY_BYTES = 12_000;
const MAX_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 600;
const RATE_LIMIT = 18;
const RATE_WINDOW_MS = 60_000;
const requestsByIp = new Map();

const SYSTEM_INSTRUCTIONS = [
  "Bạn là gia sư Vật lý THPT bằng tiếng Việt, chuyên hướng dẫn thí nghiệm định luật Boyle.",
  "Giải thích ngắn, rõ, phù hợp học sinh; khuyến khích người học tự suy luận rồi mới nêu đáp án.",
  "Khi áp dụng Boyle, n và T không đổi; dùng áp suất tuyệt đối; pV không đổi còn p/V không phải đại lượng bất biến.",
  "Khi tính pV SI, đổi thể tích cm³ sang m³ bằng cách nhân 10^-6. Nêu đơn vị trong kết quả.",
  "Chỉ dùng số đo mô phỏng được cung cấp; không tự bịa số liệu hay khẳng định cảm biến thật.",
  "Nếu câu hỏi ngoài Vật lý hoặc thí nghiệm Boyle, lịch sự hướng người học về chủ đề này.",
  "Không yêu cầu hoặc tiết lộ mật khẩu, khóa API, hay dữ liệu cá nhân."
].join(" ");

function send(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    if (process.env.APP_ORIGIN) return new URL(origin).origin === new URL(process.env.APP_ORIGIN).origin;
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (requestsByIp.get(ip) || []).filter(time => now - time < RATE_WINDOW_MS);
  recent.push(now);
  requestsByIp.set(ip, recent);
  if (requestsByIp.size > 1000) {
    for (const [key, times] of requestsByIp) {
      if (!times.some(time => now - time < RATE_WINDOW_MS)) requestsByIp.delete(key);
    }
  }
  return recent.length > RATE_LIMIT;
}

async function readJson(req) {
  const parts = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const part of req) {
    bytes += part.length;
    if (bytes <= MAX_BODY_BYTES) parts.push(part);
    else tooLarge = true;
  }
  if (tooLarge) {
    const error = new Error("Yêu cầu quá lớn.");
    error.status = 413;
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    const error = new Error("Dữ liệu gửi lên không hợp lệ.");
    error.status = 400;
    throw error;
  }
}

function cleanMessages(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_MESSAGES).flatMap(message => {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") return [];
    const content = message.content.trim().slice(0, MAX_MESSAGE_CHARS);
    return content ? [{ role: message.role, content }] : [];
  });
}

function cleanContext(value) {
  if (!value || typeof value !== "object") return "";
  const volume = Number(value.volumeCm3);
  const pressure = Number(value.absolutePressurePa);
  const temperature = Number(value.temperatureK);
  const parts = [];
  if (Number.isFinite(volume) && volume >= 20 && volume <= 100) parts.push("Trạng thái hiện tại: V = " + volume.toFixed(1) + " cm³.");
  if (Number.isFinite(pressure) && pressure > 0 && pressure <= 3_000_000) parts.push("p tuyệt đối = " + Math.round(pressure) + " Pa.");
  if (Number.isFinite(temperature) && temperature === 298) parts.push("T = 298 K.");
  if (Array.isArray(value.measurements)) {
    const rows = value.measurements.slice(0, 5).filter(row =>
      row && Number(row.volumeCm3) >= 20 && Number(row.volumeCm3) <= 100 &&
      Number(row.absolutePressurePa) > 0 && Number(row.absolutePressurePa) <= 3_000_000
    );
    if (rows.length) parts.push("Số đo đã lưu (V cm³, p Pa tuyệt đối): " +
      rows.map(row => "(" + Number(row.volumeCm3).toFixed(1) + ", " + Math.round(Number(row.absolutePressurePa)) + ")").join("; ") + ".");
  }
  return parts.join(" ");
}

async function handleTutor(req, res) {
  if (!sameOrigin(req)) return send(res, 403, { error: "Nguồn truy cập không được phép." });
  if (isRateLimited(req.socket.remoteAddress || "unknown")) return send(res, 429, { error: "Bạn gửi hơi nhanh. Hãy đợi một phút rồi thử lại." });
  if (!process.env.OPENAI_API_KEY) return send(res, 503, { error: "Máy chủ chưa cấu hình OPENAI_API_KEY." });

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return send(res, error.status || 400, { error: error.message });
  }
  const messages = cleanMessages(body.messages);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return send(res, 400, { error: "Hãy gửi một câu hỏi trước." });
  }

  const transcript = messages.map(message => message.role + ": " + message.content).join("\n");
  const context = cleanContext(body.context);
  const input = context ? transcript + "\n\n" + context : transcript;

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        instructions: SYSTEM_INSTRUCTIONS,
        input,
        max_output_tokens: 450,
        store: false
      }),
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    return send(res, 502, { error: "Không kết nối được dịch vụ AI. Hãy thử lại." });
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const status = response.status === 429 ? 429 : 502;
    return send(res, status, { error: status === 429 ? "Dịch vụ AI đang bận. Hãy thử lại sau." : "Dịch vụ AI chưa phản hồi thành công." });
  }
  const answer = (result.output || [])
    .flatMap(item => item.content || [])
    .filter(part => part.type === "output_text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n").trim();
  if (!answer) return send(res, 502, { error: "AI chưa tạo được câu trả lời." });
  return send(res, 200, { answer, model: MODEL });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { aiAvailable: Boolean(process.env.OPENAI_API_KEY), model: MODEL });
  }
  if (url.pathname === "/api/tutor" && req.method === "POST") return handleTutor(req, res);
  if ((url.pathname === "/" || url.pathname === "/index.html") && (req.method === "GET" || req.method === "HEAD")) {
    try {
      const html = await readFile(INDEX_PATH);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" });
      return res.end(req.method === "HEAD" ? undefined : html);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Không tìm thấy index.html. Chạy máy chủ từ thư mục dự án.");
    }
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
  res.end("Không tìm thấy trang.");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Boyle lab server listening on port " + PORT + (process.env.OPENAI_API_KEY ? " (AI configured)" : " (AI not configured)"));
});

