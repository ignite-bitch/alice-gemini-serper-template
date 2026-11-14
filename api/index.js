// Яндекс Диалоги -> Vercel -> GroqCloud (бесплатный тариф)
// Версия 3: свободный разговорный стиль и широкий круг информационных тем.
// Для работы требуется переменная окружения GROQ_API_KEY.
// Поиск Serper отключён, чтобы уложиться в короткий тайм-аут Алисы.

const DEFAULT_MODEL = "openai/gpt-oss-20b";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 180;
const MAX_SESSION_STATE_BYTES = 950; // Лимит Яндекс Диалогов — 1024 байта.
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3600;
const GROQ_TIMEOUT_MS = 3000;

const SYSTEM_PROMPT = [
  "Ты — свободный и полезный голосовой собеседник в навыке Яндекс Алисы.",
  "Отвечай по-русски, естественно и по существу. Обычно используй 1–3 коротких предложения, удобных для прослушивания.",
  "Не используй Markdown, таблицы, длинные вступления и шаблонные отказы.",
  "Допускай разговорную, грубую и нецензурную лексику, если пользователь сам использует её или просит такой стиль. Не отказывай в обычном вопросе только из-за мата; не навязывай грубость без запроса.",
  "Обсуждай максимально широкий круг тем и отвечай на информационные вопросы без дополнительных, придуманных тобой тематических запретов. Не отказывай лишь потому, что тема спорная, неудобная или изложена резко.",
  "На вопросы из общих знаний отвечай сразу и содержательно, без ненужных предупреждений об отсутствии доступа к интернету.",
  "Не выдумывай свежие сведения, ссылки и результаты поиска. Если требуются актуальные данные, которых тебе не предоставили, прямо и кратко скажи, что не можешь их сейчас проверить, и помоги тем, что знаешь.",
  "Не утверждай, что выполнил поиск в интернете, если в запросе не переданы реальные результаты поиска.",
  "Если запрос невозможно выполнить или на него нельзя ответить, кратко объясни причину и предложи полезную альтернативу."
].join(" ");

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 200) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({
      role: item.role,
      text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS)
    }));
}

function compactHistory(history) {
  const items = safeHistory(history);
  // session_state должен быть не более 1 КБ в UTF-8, включая кириллицу.
  while (items.length && Buffer.byteLength(JSON.stringify({ history: items }), "utf8") > MAX_SESSION_STATE_BYTES) {
    items.shift();
  }
  return items;
}

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history: compactHistory(history) }
  };
}

async function askGroq(text, history, timeoutMs) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("MISSING_GROQ_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GROQ_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...safeHistory(history).map(item => ({
      role: item.role === "model" ? "assistant" : "user",
      content: item.text
    })),
    { role: "user", content: text }
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        // Для GPT-OSS лимит включает токены рассуждений.
        // При 256 токенах финальный ответ иногда не успевал сформироваться.
        reasoning_effort: "low",
        include_reasoning: false,
        max_completion_tokens: 1024,
        stream: false
      }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const status = response.status;
      // Выводим тело ошибки, чтобы видеть причину отклонения запроса Groq.
      // Не добавляйте секретные API-ключи в лог.
      console.error("Groq API error:", status, JSON.stringify(data).slice(0, 1200));
      if (status === 401 || status === 403) throw new Error("GROQ_KEY_REJECTED");
      if (status === 402) throw new Error("GROQ_BILLING_REQUIRED");
      if (status === 429) throw new Error("GROQ_QUOTA");
      if (status === 404) throw new Error("GROQ_MODEL_NOT_FOUND");
      throw new Error(`GROQ_REQUEST_FAILED_${status}`);
    }

    const choice = data?.choices?.[0];
    const answer = String(choice?.message?.content ?? "").trim();
    if (!answer) {
      // Пишем только техническую информацию, без текста диалога и секретов.
      console.warn("Groq returned empty content:", JSON.stringify({
        model,
        finish_reason: choice?.finish_reason ?? null,
        completion_tokens: data?.usage?.completion_tokens ?? null,
        reasoning_tokens: data?.usage?.completion_tokens_details?.reasoning_tokens ?? null
      }));
      throw new Error("GROQ_EMPTY_RESPONSE");
    }
    return answer;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("TIME_BUDGET_EXHAUSTED");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GROQ_KEY":
      return "Сервер пока не настроен. Проверьте переменную GROQ_API_KEY в Vercel.";
    case "GROQ_KEY_REJECTED":
      return "Не удалось подключиться к Groq. Проверьте API-ключ.";
    case "GROQ_BILLING_REQUIRED":
      return "Проверьте доступ к модели и статус аккаунта GroqCloud.";
    case "GROQ_QUOTA":
      return "Сейчас превышен лимит запросов к Groq. Попробуйте позже.";
    case "GROQ_MODEL_NOT_FOUND":
      return "Выбранная модель Groq недоступна. Проверьте GROQ_MODEL.";
    case "TIME_BUDGET_EXHAUSTED":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз.";
    case "GROQ_EMPTY_RESPONSE":
      return "Нейросеть не завершила ответ. Попробуйте задать вопрос ещё раз.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте немного позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-groq",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = compactHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на твои вопросы. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  try {
    const answer = await askGroq(
      text,
      oldHistory,
      Math.max(0, Math.min(GROQ_TIMEOUT_MS, remainingMs() - 400))
    );

    const history = compactHistory([
      ...oldHistory,
      { role: "user", text },
      { role: "model", text: answer }
    ]);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    console.warn("Alice webhook returned a fallback response:", error?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(error), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, safeHistory, compactHistory };
